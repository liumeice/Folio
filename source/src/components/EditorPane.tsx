/* CodeMirror 6 编辑器：行号/语法高亮/软换行原生自带（FR-7.1）。
 * 与 store 联动：onChange → setDraft；同时注册 EditorBridge 供滚动同步与大纲编辑态定位
 * （v1.2 一把尺：小数源码行号 lineFloat，方案 §4.1(c)(d)）：
 *  topLine() —— 视口顶 → 小数行号（软换行按可视块折算，非整行吸附）；
 *  jumpToLine(lineFloat) —— scrollIntoView 贴整行 + 下一帧 coordsAtPos 精确对齐视口顶。 */
import { Show, onCleanup, onMount } from "solid-js";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { indentLess, insertTab } from "@codemirror/commands";
import { md } from "../lib/mdEditor";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { mdHighlight } from "../lib/mdstyle";
import { mdStructural } from "../lib/mdStructural";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { SYNC_EPSILON } from "../lib/nav";
import { commonEditRange } from "../lib/textedit";
import {
  calloutOp, codeBlockOp, emojiOp, hrOp, imageOp, linkOp, listOp, prefixLinesOp, tableOp, wrapOp,
  type EditOp, type EditorCmd,
} from "../lib/mdInsert";

export default function EditorPane() {
  const s = useStore();
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let raf = 0;

  /** 视口顶 → 小数源码行号（二轮评审 2.4：必须小数，整行吸附会让交接精度归零、往返在边界抖）。
   *  几何全走 CM 文档坐标（documentTop 系）：lineBlockAtHeight 找视口顶所在可视块 →
   *  归属逻辑行 → 块顶在「该逻辑行全部可视块的文档跨度」内的比例即行内小数。
   *  软换行的各可视块行高相等，此比例与「块序号+块内比例」等价且免遍历。 */
  function topLine(): number | null {
    const v = view;
    if (!v || !s.current()) return null;
    try {
      const r = v.scrollDOM.getBoundingClientRect();
      if (r.width < 2) throw new Error("未挂载");
      const h = (r.top + SYNC_EPSILON) - v.documentTop;   // 视口顶的文档相对 y
      const blk = v.lineBlockAtHeight(Math.max(0, h));
      const ln = v.state.doc.lineAt(blk.from);
      const first = v.lineBlockAt(ln.from);
      const last = v.lineBlockAt(ln.to);
      const endTop = last.top + last.height;
      const frac = Math.min(1, Math.max(0, (h - first.top) / Math.max(1, endTop - first.top)));
      return ln.number - 1 + frac;
    } catch {
      // 几何未就绪退回光标行（整数精度，下一拍 sync/交接自会校正）
      return v.state.doc.lineAt(v.state.selection.main.head).number - 1;
    }
  }

  /** 精确跳行：小数部分折算成行内字符偏移后一起交给 scrollIntoView(y:"start")——
   *  CM 会把**目标字符所在的可视块**贴顶，行内比例与 topLine() 的跨度比例同一几何（同步行高）。 */
  function jumpToLine(lineFloat: number) {
    const v = view;
    if (!v || !s.current()) return;
    const n = v.state.doc.lines;
    const line0 = Math.max(0, Math.min(n - 1, Math.floor(lineFloat)));
    const frac = lineFloat - line0;
    const ln = v.state.doc.line(line0 + 1);
    const target = ln.from + Math.min(ln.length, Math.round(frac * ln.length));
    v.dispatch({ selection: { anchor: target }, effects: EditorView.scrollIntoView(target, { y: "start" }) });
    v.focus();
  }

  /** 整篇替换（源码格式化专用）：
   *  ① 只替换公共前缀/后缀之间的中段——光标在未变化区域时原样保留；
   *  ② 单次 dispatch = 一个事务，Ctrl+Z 可把整次格式化一次撤销。 */
  function replaceAll(text: string) {
    const v = view;
    if (!v) return;
    const r = commonEditRange(v.state.doc.toString(), text);
    if (!r) return;
    v.dispatch({ changes: { from: r.from, to: r.to, insert: r.insert } });
  }

  /* ── 编辑窗右键插入（方案 N-CTX-01）────────────────────────────
   * 模板纯函数只拿「光标附近的局部窗口」，不 doc.toString() 全文复制（P1-3 纪律）。
   * 所有命令一次 dispatch：一次 Ctrl+Z 还原；落盘仍走既有手动保存链路。 */
  function localWindow(kind: "block" | "lines" | "selection", from: number, to: number) {
    const doc = view!.state.doc;
    if (kind === "selection") {
      const base = from;
      return { src: doc.sliceString(from, to), base, from: 0, to: to - from };
    }
    if (kind === "block") {
      const line = doc.lineAt(Math.max(from, to));
      const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
      const base = line.from;
      const end = next ? next.to : line.to;
      return {
        src: doc.sliceString(base, end), base,
        from: Math.max(0, from - base), to: to - base,
      };
    }
    const a = doc.lineAt(from);
    let b = doc.lineAt(to);
    if (to > from && b.from === to && b.to > b.from) b = doc.line(b.number - 1);
    // 有序列表续号：把选区上方最近的非空行也带进窗口，供 prevOrdered 扫描
    const first = (() => {
      for (let n = a.number - 1; n >= 1; n--) {
        const l = doc.line(n);
        if (l.text.trim() !== "") return l;
      }
      return a;
    })();
    const base = first.from;
    return { src: doc.sliceString(base, b.to), base, from: from - base, to: to - base };
  }

  function applyOp(op: EditOp, base: number, focus = true) {
    const v = view;
    if (!v) return;
    v.dispatch({
      changes: { from: base + op.from, to: base + op.to, insert: op.insert },
      selection: { anchor: base + op.selFrom, head: base + op.selTo },
      effects: EditorView.scrollIntoView(base + op.selFrom),
    });
    if (focus) v.focus();
  }

  async function runEditorCommand(cmd: EditorCmd): Promise<boolean> {
    const v = view;
    if (!v) return false;
    const main = v.state.selection.main;
    const from = main.from, to = main.to;
    switch (cmd.kind) {
      case "table": {
        const w = localWindow("block", from, to);
        applyOp(tableOp(w.src, w.from, w.to, cmd.cols, cmd.rows), w.base);
        break;
      }
      case "code": {
        if (from !== to) {
          const w = localWindow("selection", from, to);
          applyOp(codeBlockOp(w.src, 0, w.to, cmd.lang), w.base);
        } else {
          const w = localWindow("block", from, to);
          applyOp(codeBlockOp(w.src, w.from, w.to, cmd.lang), w.base);
        }
        break;
      }
      case "heading": {
        const w = localWindow("lines", from, to);
        applyOp(prefixLinesOp(w.src, w.from, w.to, "heading", cmd.level), w.base);
        break;
      }
      case "callout": {
        if (from !== to) {
          const w = localWindow("lines", from, to);
          applyOp(calloutOp(w.src, w.from, w.to, cmd.callout), w.base);
        } else {
          const w = localWindow("block", from, to);
          applyOp(calloutOp(w.src, w.from, w.to, cmd.callout), w.base);
        }
        break;
      }
      case "emoji": {
        // 行内纯替换，不需要上下文窗口（P1-3：不复制周边文本）
        applyOp(emojiOp("", from, to, cmd.text), 0);
        break;
      }
      case "image": {
        const w = localWindow("block", from, to);
        applyOp(imageOp(w.src, w.from, w.to), w.base);
        break;
      }
      case "link": {
        if (from !== to) {
          const w = localWindow("selection", from, to);
          applyOp(linkOp(w.src, 0, w.to), w.base);
        } else {
          const w = localWindow("block", from, to);
          applyOp(linkOp(w.src, w.from, w.to), w.base);
        }
        break;
      }
      case "hr": {
        const w = localWindow("block", from, to);
        applyOp(hrOp(w.src, w.from, w.to), w.base);
        break;
      }
      case "wrap": {
        if (from !== to) {
          const w = localWindow("selection", from, to);
          applyOp(wrapOp(w.src, 0, w.to, cmd.style), w.base);
        }
        break;
      }
      case "list": {
        if (cmd.list === "quote") {
          const w = localWindow("lines", from, to);
          applyOp(prefixLinesOp(w.src, w.from, w.to, "quote"), w.base);
        } else {
          const w = localWindow("lines", from, to);
          // 列表连点：菜单保持展开，不抢焦点
          applyOp(listOp(w.src, w.from, w.to, cmd.list), w.base, false);
        }
        break;
      }
      case "clip": {
        const text = v.state.sliceDoc(from, to);
        const doc = v.state.doc;
        if (cmd.action === "selectAll") {
          v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
          v.focus();
          return true;
        }
        if (cmd.action === "copy") {
          if (!text) return false;
          try { await navigator.clipboard.writeText(text); s.toast("已复制"); }
          catch { s.toast("剪贴板不可用"); }
          v.focus();
          return true;
        }
        if (cmd.action === "cut") {
          if (!text) return false;
          try { await navigator.clipboard.writeText(text); }
          catch { s.toast("剪贴板不可用"); return false; }
          if (v.state.doc !== doc) return false;   // 等待期间文档已变：不作废用户输入
          applyOp({ from, to, insert: "", selFrom: from, selTo: from }, 0);
          s.toast("已剪切");
          return false;
        }
        if (cmd.action === "delete") {
          if (!text) return false;
          applyOp({ from, to, insert: "", selFrom: from, selTo: from }, 0);
          return false;
        }
        // paste
        let clip: string | null = null;
        try { clip = await navigator.clipboard.readText(); } catch { /* 权限/非安全上下文 */ }
        if (clip == null) { s.toast("无法读取剪贴板，请按 Ctrl+V"); return false; }
        if (!clip) { s.toast("剪贴板为空"); return false; }
        if (v.state.doc !== doc) return false;
        applyOp({ from, to, insert: clip, selFrom: from + clip.length, selTo: from + clip.length }, 0);
        s.toast("已粘贴");
        return false;
      }
    }
    return !v.state.selection.main.empty;
  }

  // 双 rAF：等 scrollIntoView 的几何应用稳定后再读顶行——单帧读会在滚动生效前
  // 拿到旧位置，把大纲点击刚设好的 activeSec 覆写回上一章节（差一章的根因之二）
  function syncOutline() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        raf = 0;
        const l = topLine();
        const cur = s.current();
        if (l != null && cur) {
          // 章节判定：行号落在哪个 outline 区间（触底时 topLine 已自然到文末 → 末章）
          const ol = cur.outline;
          let sec: number | null = ol.length ? ol[0].sec : null;
          for (const o of ol) if (l >= o.line) sec = o.sec;
          s.setActiveSec(sec);
        }
      });
    });
  }

  function focusEditor() { view?.focus(); }
  function hasSelection() { return !!view && !view.state.selection.main.empty; }

  /** 右键 mousedown 先记选区：CM/浏览器可能在 contextmenu 前就把选区收成光标 */
  let savedSel: { from: number; to: number } | null = null;
  function onMouseDown(e: MouseEvent) {
    if (e.button !== 2) return;
    const s = view?.state.selection.main;
    savedSel = s && !s.empty ? { from: s.from, to: s.to } : null;
  }

  /** 编辑窗右键：落在选区内保留原选区；落在选区外把光标移到右键点（方案 §2.1） */
  function onContextMenu(e: MouseEvent) {
    const v = view;
    if (!v) return;
    e.preventDefault();
    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
    const current = v.state.selection.main;
    const keep = savedSel ?? (current.empty ? null : { from: current.from, to: current.to });
    savedSel = null;
    if (pos != null) {
      if (keep && pos >= keep.from && pos <= keep.to) {
        v.dispatch({ selection: { anchor: keep.from, head: keep.to } });
      } else {
        v.dispatch({ selection: { anchor: pos } });
      }
    }
    const after = v.state.selection.main;
    ui.setCtxMenu({ kind: "editor", x: e.clientX, y: e.clientY, hasSelection: !after.empty });
  }

  onMount(() => {
    view = new EditorView({
      doc: s.draftSrc(),
      parent: host,
      extensions: [
        basicSetup,
        md(),   // GFM 解析器配置见 lib/mdEditor.ts（默认 CommonMark 会丢删除线/任务/表格着色）
        // 着色必须接在 basicSetup 之后：它自带的 defaultHighlightStyle 是 fallback，
        // 我们定义过的 tag 才不会被那套通用浅色配色覆盖（原型对齐见 mdstyle.ts）
        syntaxHighlighting(mdHighlight),
        mdStructural,
        EditorView.lineWrapping,
        // Tab = 制表符（需求方 2026-11-19 定夺）。CM 默认不绑 Tab（焦点切换给浏览器），
        // 这里插回制表语义：无选择→光标处插 \t；有选择→整段行首加 \t；Shift-Tab 反操作。
        // indentUnit 设为 "\t" 让缩进落的是制表符而不是空格；需要焦点导航时 Ctrl+M 切换
        // （basicSetup 自带 toggleTabFocusMode）。
        indentUnit.of("\t"),
        keymap.of([{ key: "Tab", run: insertTab, shift: indentLess }]),
        // 中英混排文档里浏览器拼写检查满屏红波浪线（把 focus.css、拼音词全判"错拼"）——
        // contenteditable 默认 spellcheck=true，显式关闭
        EditorView.contentAttributes.of({ spellcheck: "false" }),
        EditorView.contentAttributes.of({ autocorrect: "off", autocapitalize: "off" }),
        EditorView.updateListener.of((u) => {
          // P1-3：按键热路径不再 toString + 全文比较；只挂脏，正文快照由 store 防抖取一次
          if (u.docChanged) s.markDraftChanged();
          if (u.viewportChanged || u.selectionSet) syncOutline();
        }),
      ],
    });
    ui.registerEditorBridge({
      jumpToLine,
      topLine,
      docText: () => view?.state.doc.toString() ?? s.draftSrc(),
      replaceAll,
      hasSelection,
      runEditorCommand,
      focusEditor,
    });
    view.contentDOM.addEventListener("mousedown", onMouseDown, true);
    view.contentDOM.addEventListener("contextmenu", onContextMenu);
    const pj = ui.takePendingEditorJump();
    if (pj != null && pj > 0) jumpToLine(pj);
    view.focus();
    syncOutline();
    onCleanup(() => {
      ui.registerEditorBridge(null);
      view?.contentDOM.removeEventListener("mousedown", onMouseDown, true);
      view?.contentDOM.removeEventListener("contextmenu", onContextMenu);
      if (raf) cancelAnimationFrame(raf);
      view?.destroy();
    });
  });

  return (
    <div class="editor-wrap">
      <div class="editor-bar">
        <span class="hint" title="编辑模式已启用行号 / Markdown 语法着色 / 软换行；滚动与阅读视图、大纲互通">
          编辑模式 — <b>行号 / 语法着色</b>已启用
        </span>
        <span class="sp" />
        <Show when={s.dirty()}>
          <span class="hint" style={{ color: "var(--amber)" }}>● 未保存</span>
        </Show>
        {/* §8.2 按钮组口径：等宽、dismiss（放弃修改）居左 */}
        <span class="mfb">
          <button class="btn" title="不保存本次修改，返回阅读 (Esc)" onClick={() => s.discard()}>放弃修改</button>
          <button class="btn primary" title="写回磁盘并更新索引 (Ctrl+S)" onClick={() => void s.save()}>
            <svg class="ico ico-14"><use href="#i-save" /></svg>保存并返回阅读
          </button>
        </span>
      </div>
      <div class="cm-host" ref={host} />
    </div>
  );
}
