/* CodeMirror 6 编辑器：行号/语法高亮/软换行原生自带（FR-7.1）。
 * 与 store 联动：onChange → setDraft；同时注册 EditorBridge 供滚动同步与大纲编辑态定位
 * （v1.2 一把尺：小数源码行号 lineFloat，方案 §4.1(c)(d)）：
 *  topLine() —— 视口顶 → 小数行号（软换行按可视块折算，非整行吸附）；
 *  jumpToLine(lineFloat) —— scrollIntoView 贴整行 + 下一帧 coordsAtPos 精确对齐视口顶。 */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentLess, indentMore, insertTab } from "@codemirror/commands";
import { indentBlockLines, renumberOrderedBlock, splitListLine } from "../lib/listNumbers";
import { editLabel, historyDepths, undoOnce, redoOnce } from "../lib/editorHistory";
import { emptyJournal, historySnippet, reduceJournal, txTexts, type JournalState, type JournalStep } from "../lib/editorJournal";
import { md } from "../lib/mdEditor";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { mdHighlight } from "../lib/mdstyle";
import { mdStructural } from "../lib/mdStructural";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { t, tp } from "../lib/i18n";
import { SYNC_EPSILON } from "../lib/nav";
import { commonEditRange } from "../lib/textedit";
import {
  calloutOp, codeBlockOp, emojiOp, hrOp, imageOp, linkOp, listOp, prefixLinesOp, tableOp, wrapOp, yamlOp,
  type EditOp, type EditorCmd,
} from "../lib/mdInsert";

export default function EditorPane() {
  const s = useStore();
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let raf = 0;
  /* Word 式撤销/重做下拉：步骤日志随每次事务更新；
   * 菜单开关与悬停计数是纯视图状态，不进入 store/ui 全局信号。 */
  const [journal, setJournal] = createSignal<JournalState>(emptyJournal());
  const [openHist, setOpenHist] = createSignal<"undo" | "redo" | null>(null);
  const [hoverN, setHoverN] = createSignal(1);

  const stepLabel = (step: JournalStep): string => {
    if (step.kind === "cmd") return step.added;
    const text = historySnippet(step.kind === "type" ? step.added : step.removed);
    if (step.kind === "type") return text ? t("editorpane.history.typed", { text }) : t("editorpane.history.typing");
    if (step.kind === "delete") return text ? t("editorpane.history.deleted", { text }) : t("editorpane.history.deleting");
    return t("editorpane.history.replaced", { text });
  };
  const undoItems = () => journal().steps.slice(0, journal().depth).slice().reverse();
  const redoItems = () => journal().steps.slice(journal().depth);
  function toggleHist(which: "undo" | "redo") {
    setHoverN(1);
    setOpenHist(openHist() === which ? null : which);
  }
  /** 跳到指定 undoDepth：按步数循环 undo/redo（每次恰好消费一个 CM 历史事件） */
  function jumpHistory(target: number) {
    const v = view;
    if (!v) return;
    const from = historyDepths(v.state).undo;
    const to = Math.max(0, Math.min(target, journal().steps.length));
    if (to === from) { setOpenHist(null); return; }
    let guard = 240;
    while (guard-- > 0) {
      const d = historyDepths(v.state).undo;
      if (d === to) break;
      if (d > to) { if (!undoOnce(v)) break; }
      else if (!redoOnce(v)) break;
    }
    v.focus();
    setOpenHist(null);
    const n = Math.abs(from - to);
    if (n > 0) s.toast(tp(to < from ? "editorpane.history.undone" : "editorpane.history.redone", n, { n }));
  }

  /** 视口顶 → 小数源码行号（二轮评审 2.4：必须小数，整行吸附会让交接精度归零、往返在边界抖）。
   *  几何全走 CM 文档坐标（documentTop 系）：lineBlockAtHeight 找视口顶所在可视块 →
   *  归属逻辑行 → 块顶在「该逻辑行全部可视块的文档跨度」内的比例即行内小数。
   *  软换行的各可视块行高相等，此比例与「块序号+块内比例」等价且免遍历。 */
  function topLine(): number | null {
    const v = view;
    if (!v || !s.current()) return null;
    try {
      const r = v.scrollDOM.getBoundingClientRect();
      if (r.width < 2) throw new Error(t("editorpane.notMounted"));   // 内部异常串，不进界面
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
    v.dispatch({
      changes: { from: r.from, to: r.to, insert: r.insert },
      userEvent: "insert.command",
      annotations: editLabel.of(t("app.menu.document.format")),
    });
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

  function applyOp(op: EditOp, base: number, focus = true, label?: string) {
    const v = view;
    if (!v) return;
    v.dispatch({
      changes: { from: base + op.from, to: base + op.to, insert: op.insert },
      selection: { anchor: base + op.selFrom, head: base + op.selTo },
      effects: EditorView.scrollIntoView(base + op.selFrom),
      // 命令各自成步：insert.command 不匹配 CM 的可合并 userEvent
      userEvent: "insert.command",
      annotations: label ? editLabel.of(label) : undefined,
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
        applyOp(tableOp(w.src, w.from, w.to, cmd.cols, cmd.rows, cmd.labels), w.base, true, t("editor.block.table"));
        break;
      }
      case "code": {
        if (from !== to) {
          const w = localWindow("selection", from, to);
          applyOp(codeBlockOp(w.src, 0, w.to, cmd.lang), w.base, true, t("editor.block.code"));
        } else {
          const w = localWindow("block", from, to);
          applyOp(codeBlockOp(w.src, w.from, w.to, cmd.lang), w.base, true, t("editor.block.code"));
        }
        break;
      }
      case "heading": {
        const w = localWindow("lines", from, to);
        applyOp(prefixLinesOp(w.src, w.from, w.to, "heading", cmd.level), w.base, true,
          t("editor.panel.headingLevel", { lv: cmd.level }));
        break;
      }
      case "callout": {
        if (from !== to) {
          const w = localWindow("lines", from, to);
          applyOp(calloutOp(w.src, w.from, w.to, cmd.callout), w.base, true, t("editor.block.callout"));
        } else {
          const w = localWindow("block", from, to);
          applyOp(calloutOp(w.src, w.from, w.to, cmd.callout), w.base, true, t("editor.block.callout"));
        }
        break;
      }
      case "emoji": {
        // 行内纯替换，不需要上下文窗口（P1-3：不复制周边文本）
        applyOp(emojiOp("", from, to, cmd.text), 0, true, t("editor.emoji.title"));
        break;
      }
      case "image": {
        const w = localWindow("block", from, to);
        applyOp(imageOp(w.src, w.from, w.to, cmd.labels), w.base, true, t("editor.block.image"));
        break;
      }
      case "link": {
        if (from !== to) {
          const w = localWindow("selection", from, to);
          applyOp(linkOp(w.src, 0, w.to, cmd.labels), w.base, true, t("editor.block.link"));
        } else {
          const w = localWindow("block", from, to);
          applyOp(linkOp(w.src, w.from, w.to, cmd.labels), w.base, true, t("editor.block.link"));
        }
        break;
      }
      case "hr": {
        const w = localWindow("block", from, to);
        applyOp(hrOp(w.src, w.from, w.to), w.base, true, t("editor.block.divider"));
        break;
      }
      case "yaml": {
        // 只读文档开头片段：front matter 判定与插入定坐标都在首区，不复制全文（P1-3）
        const doc = v.state.doc;
        const head = doc.sliceString(0, Math.min(doc.length, 64 * 1024));
        const op = yamlOp(head);
        if (!op) { s.toast(t("editorpane.yamlExists")); return false; }
        applyOp(op, 0, true, t("editor.block.yaml"));
        break;
      }
      case "wrap": {
        if (from !== to) {
          const w = localWindow("selection", from, to);
          const label = cmd.style === "bold" ? t("editor.wrap.bold")
            : cmd.style === "italic" ? t("editor.wrap.italic")
            : cmd.style === "code" ? t("editor.wrap.code")
            : cmd.style === "strike" ? t("editor.wrap.strike") : t("editor.wrap.link");
          applyOp(wrapOp(w.src, 0, w.to, cmd.style), w.base, true, label);
        }
        break;
      }
      case "list": {
        const label = cmd.list === "quote" ? t("editor.list.quote")
          : cmd.list === "task" ? t("editor.list.task")
          : cmd.list === "ol" ? t("editor.list.ol") : t("editor.list.ul");
        if (cmd.list === "quote") {
          const w = localWindow("lines", from, to);
          applyOp(prefixLinesOp(w.src, w.from, w.to, "quote"), w.base, true, label);
        } else {
          const w = localWindow("lines", from, to);
          // 列表连点：菜单保持展开，不抢焦点
          applyOp(listOp(w.src, w.from, w.to, cmd.list), w.base, false, label);
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
          try { await navigator.clipboard.writeText(text); s.toast(t("editorpane.copied")); }
          catch { s.toast(t("side.status.clipboardFail")); }
          v.focus();
          return true;
        }
        if (cmd.action === "cut") {
          if (!text) return false;
          try { await navigator.clipboard.writeText(text); }
          catch { s.toast(t("side.status.clipboardFail")); return false; }
          if (v.state.doc !== doc) return false;   // 等待期间文档已变：不作废用户输入
          applyOp({ from, to, insert: "", selFrom: from, selTo: from }, 0, true, t("editor.action.cut"));
          s.toast(t("editorpane.cut"));
          return false;
        }
        if (cmd.action === "delete") {
          if (!text) return false;
          applyOp({ from, to, insert: "", selFrom: from, selTo: from }, 0, true, t("editor.action.delete"));
          return false;
        }
        // paste
        let clip: string | null = null;
        try { clip = await navigator.clipboard.readText(); } catch { /* 权限/非安全上下文 */ }
        if (clip == null) { s.toast(t("editorpane.clipboard.readFailed")); return false; }
        if (!clip) { s.toast(t("editorpane.clipboard.empty")); return false; }
        if (v.state.doc !== doc) return false;
        applyOp({ from, to, insert: clip, selFrom: from + clip.length, selTo: from + clip.length }, 0, true, t("editor.action.paste"));
        s.toast(t("editorpane.pasted"));
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

  /** Tab / Shift-Tab（2026-11-27 编辑窗口优化）：
   *  - 有选区时缩进整行（含 Alt 矩形/多选区），并把列表块内的有序标记整体重排，
   *    使 Tab 进父项后的首个子项从 1 开始（阅读区显示 2.1.）；
   *  - 无选区维持 CM 原行为（光标处插 \t / Shift-Tab 反缩进）。 */
  function tabListIndent(outdent: boolean): boolean {
    const v = view;
    if (!v) return false;
    const sel = v.state.selection;
    // 单光标无选区：保持 CM 原行为（光标处插 \t / 反缩进）；
    // 多光标（含 Alt 拉出的零宽竖线）即使都为空，也按行缩进处理。
    if (sel.ranges.length === 1 && sel.ranges[0].empty) return outdent ? indentLess(v) : insertTab(v);
    const doc = v.state.doc;
    const touchedDoc = new Set<number>();
    for (const r of sel.ranges) {
      const a = doc.lineAt(r.from).number;
      let b = doc.lineAt(r.to).number;
      // 选区结束正好落在行首：该行不算被选中（与 paragraph 选区口径一致）
      if (r.to > r.from && doc.lineAt(r.to).from === r.to) b = Math.max(a, b - 1);
      for (let n = a; n <= b; n++) touchedDoc.add(n);
    }
    if (!touchedDoc.size) return false;
    const first = Math.min(...touchedDoc);
    const last = Math.max(...touchedDoc);
    const isList = (n: number) => splitListLine(doc.line(n).text) !== null;
    let start = first, end = last;
    while (start > 1) {
      const prev = doc.line(start - 1);
      if (prev.text.trim() !== "" && !splitListLine(prev.text)) break;
      start--;
    }
    while (end < doc.lines) {
      const next = doc.line(end + 1);
      if (next.text.trim() !== "" && !splitListLine(next.text)) break;
      end++;
    }
    let hasList = false;
    for (let n = start; n <= end; n++) if (isList(n)) { hasList = true; break; }
    // 选区跨出了列表块 / 块内没有列表：退回 CodeMirror 的行缩进
    if (!hasList || [...touchedDoc].some((n) => n < start || n > end)) {
      return outdent ? indentLess(v) : indentMore(v);
    }
    const lines: string[] = [];
    for (let n = start; n <= end; n++) lines.push(doc.line(n).text);
    const touched = new Set([...touchedDoc].map((n) => n - start));
    const indented = indentBlockLines(lines, touched, "\t", outdent);
    const text = renumberOrderedBlock(indented, touched).join("\n");
    v.dispatch({
      changes: { from: doc.line(start).from, to: doc.line(end).to, insert: text },
      userEvent: "input.indent",
      annotations: editLabel.of(t(outdent ? "editorpane.history.outdent" : "editorpane.history.indent")),
      scrollIntoView: true,
    });
    return true;
  }

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
    ui.setEditorTouched(false);   // 用户真的滚动过才算（滚轮/指针按下/翻页键）
    // 新编辑会话：历史随编辑器清空，下拉列表也从空开始
    setJournal(emptyJournal());
    setOpenHist(null);
    const extensions = [
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
        keymap.of([
          // Alt+drag 矩形选择 / 多选区输入删除由 basicSetup 的 rectangularSelection +
          // allowMultipleSelections 提供；Tab 对选区走 tabListIndent（整行缩进 + 有序列表重排）。
          { key: "Tab", run: () => tabListIndent(false), shift: () => tabListIndent(true) },
          // 撤销/重做方案 v1.0：补 Windows 默认未绑定的 Ctrl+Shift+Z 重做别名
          //（basicSetup 已含 Mod-z / Mod-y，不重复绑定）
          { key: "Mod-Shift-z", run: () => runRedo(), preventDefault: true },
        ]),
        // 中英混排文档里浏览器拼写检查满屏红波浪线（把 focus.css、拼音词全判"错拼"）——
        // contenteditable 默认 spellcheck=true，显式关闭
        EditorView.contentAttributes.of({ spellcheck: "false" }),
        EditorView.contentAttributes.of({ autocorrect: "off", autocapitalize: "off" }),
        EditorView.updateListener.of((u) => {
          // P1-3：按键热路径不再 toString + 全文比较；只挂脏，正文快照由 store 防抖取一次
          if (u.docChanged) {
            s.markDraftChanged();
            // 撤销/重做方案 v1.0：历史深度回写 ui 信号，驱动「文档」菜单可用性
            const h = historyDepths(u.state);
            ui.setEditorHistoryDepth(h.undo, h.redo);
            // Word 式下拉：用 undoDepth 当锚同步步骤日志（命令事务带 editLabel / userEvent）
            const nav = u.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"));
            const editTr = nav ? undefined : u.transactions.find((tr) => tr.docChanged);
            const texts = editTr ? txTexts(editTr) : { added: "", removed: "" };
            setJournal((j) => reduceJournal(j, {
              undoDepth: h.undo, redoDepth: h.redo, navigation: nav,
              added: texts.added, removed: texts.removed,
              label: editTr?.annotation(editLabel),
            }));
            if (!nav) setOpenHist(null);
          }
          if (u.viewportChanged || u.selectionSet) syncOutline();
        }),
    ];
    view = new EditorView({ doc: s.draftSrc(), parent: host, extensions });
    // 撤销/重做（方案 v1.0）：经桥暴露，历史深度由 updateListener 同步；成功后把焦点还给编辑器
    function runUndo() {
      const v = view;
      if (!v) return false;
      const ok = undoOnce(v);
      if (ok) v.focus();
      return ok;
    }
    function runRedo() {
      const v = view;
      if (!v) return false;
      const ok = redoOnce(v);
      if (ok) v.focus();
      return ok;
    }
    /* 外部刷新：整篇换内容时重建 EditorState——撤销历史与 Word 式步骤日志都指向旧正文，
     * 必须一起清空；光标按旧行号夹取恢复。focus=false 供阅读预览态使用（不抢焦点）。 */
    function cursorLine(): number {
      const v = view;
      if (!v) return 1;
      return v.state.doc.lineAt(v.state.selection.main.head).number;
    }
    function reloadText(text: string, line: number, focus = true) {
      const v = view;
      if (!v) return;
      const hadFocus = v.hasFocus;
      v.setState(EditorState.create({ doc: text, extensions }));
      setJournal(emptyJournal());
      setOpenHist(null);
      ui.setEditorHistoryDepth(0, 0);
      const target = Math.max(1, Math.min(line, v.state.doc.lines));
      const pos = v.state.doc.line(target).from;
      v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "nearest" }) });
      if (focus || hadFocus) v.focus();
      syncOutline();
    }
    ui.registerEditorBridge({
      jumpToLine,
      topLine,
      docText: () => view?.state.doc.toString() ?? s.draftSrc(),
      replaceAll,
      hasSelection,
      runEditorCommand,
      focusEditor,
      runUndo,
      runRedo,
      cursorLine,
      reloadText,
    });
    // 挂桥时写入初始深度（正常为 0/0——新编辑器历史为空）
    {
      const h0 = historyDepths(view.state);
      ui.setEditorHistoryDepth(h0.undo, h0.redo);
    }
    // 撤销/重做下拉：点外面关闭；Esc 优先关下拉，不触发“放弃修改”
    const onHistDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".hgroup")) setOpenHist(null);
    };
    const onHistKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openHist()) { e.preventDefault(); e.stopPropagation(); setOpenHist(null); }
    };
    document.addEventListener("mousedown", onHistDown);
    document.addEventListener("keydown", onHistKey, true);
    view.contentDOM.addEventListener("mousedown", onMouseDown, true);
    view.contentDOM.addEventListener("contextmenu", onContextMenu);
    const pj = ui.takePendingEditorJump();
    if (pj != null && pj > 0) jumpToLine(pj);
    // 基线：跳转落定后的顶行（用户没滚动前一直有效）
    requestAnimationFrame(() => requestAnimationFrame(() => ui.setEditorBaseline(topLine())));
    // 用户真实滚动输入（滚轮/滚动条拖动/翻页键）才标记 touched；程序跳转与显隐测量不算
    const markTouched = () => ui.setEditorTouched(true);
    view.scrollDOM.addEventListener("wheel", markTouched, { passive: true });
    view.scrollDOM.addEventListener("pointerdown", markTouched);
    view.contentDOM.addEventListener("keydown", (e) => {
      if (!e.ctrlKey && !e.metaKey && ["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"].includes(e.key)) markTouched();
    }, true);
    const cleanupTouched = () => {
      view?.scrollDOM.removeEventListener("wheel", markTouched);
      view?.scrollDOM.removeEventListener("pointerdown", markTouched);
    };
    onCleanup(cleanupTouched);
    view.focus();
    syncOutline();
    // 预览阅读（v1.1）：display:none 期间 CodeMirror 量不到尺寸，重新显示时强制重测
    createEffect(() => {
      if (s.mode() === "edit" && view) view.requestMeasure();
    });
    onCleanup(() => {
      ui.registerEditorBridge(null);
      document.removeEventListener("mousedown", onHistDown);
      document.removeEventListener("keydown", onHistKey, true);
      view?.contentDOM.removeEventListener("mousedown", onMouseDown, true);
      view?.contentDOM.removeEventListener("contextmenu", onContextMenu);
      if (raf) cancelAnimationFrame(raf);
      view?.destroy();
    });
  });

  return (
    <div class="editor-wrap" classList={{ "is-hidden": s.mode() !== "edit" }}>
      <div class="editor-bar">
        {/* Word 式撤销/重做：按钮单击走一步，箭头展开操作列表（最新在上） */}
        <div class="hgroup">
          <div class="hwrap">
            <button type="button" class="hbtn" title={t("editorpane.history.undoTitle")} aria-label={t("editorpane.history.undo")}
              disabled={!ui.editorCanUndo()} onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setOpenHist(null); ui.getEditorBridge()?.runUndo(); }}>
              <svg class="ico"><use href="#i-undo" /></svg>
            </button>
            <button type="button" class="harrow" title={t("editorpane.history.undoHistory")} aria-label={t("editorpane.history.undoHistory")}
              disabled={!ui.editorCanUndo()} onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleHist("undo")}>▾</button>
            <Show when={openHist() === "undo"}>
              <div class="hmenu" role="menu">
                <For each={undoItems()}>{(step, i) => (
                  <button type="button" class="hitem" classList={{ hot: i() === 0 }} role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHoverN(i() + 1)}
                    onClick={() => jumpHistory(step.depth - 1)}>{stepLabel(step)}</button>
                )}</For>
                <div class="hfoot">{tp("editorpane.history.undoCount", hoverN(), { n: hoverN() })}</div>
              </div>
            </Show>
          </div>
          <div class="hwrap">
            <button type="button" class="hbtn" title={t("editorpane.history.redoTitle")} aria-label={t("editorpane.history.redo")}
              disabled={!ui.editorCanRedo()} onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setOpenHist(null); ui.getEditorBridge()?.runRedo(); }}>
              <svg class="ico"><use href="#i-redo" /></svg>
            </button>
            <button type="button" class="harrow" title={t("editorpane.history.redoHistory")} aria-label={t("editorpane.history.redoHistory")}
              disabled={!ui.editorCanRedo()} onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleHist("redo")}>▾</button>
            <Show when={openHist() === "redo"}>
              <div class="hmenu" role="menu">
                <For each={redoItems()}>{(step, i) => (
                  <button type="button" class="hitem" classList={{ hot: i() === 0 }} role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHoverN(i() + 1)}
                    onClick={() => jumpHistory(step.depth)}>{stepLabel(step)}</button>
                )}</For>
                <div class="hfoot">{tp("editorpane.history.redoCount", hoverN(), { n: hoverN() })}</div>
              </div>
            </Show>
          </div>
        </div>
        <span class="sp" />
        <Show when={s.dirty()}>
          <span class="hint" style={{ color: "var(--amber)" }}>{t("editorpane.dirty")}</span>
        </Show>
        {/* §8.2 按钮组口径：等宽、dismiss（放弃修改）居左 */}
        <span class="mfb">
          <button class="btn" title={t("editorpane.discard.title")} onClick={() => s.discard()}>{t("editorpane.discard")}</button>
          <button class="btn primary" title={t("editorpane.save.title")} onClick={() => void s.save()}>
            <svg class="ico ico-14"><use href="#i-save" /></svg>{t("editorpane.saveAndReturn")}
          </button>
        </span>
      </div>
      <div class="cm-host" ref={host} />
    </div>
  );
}
