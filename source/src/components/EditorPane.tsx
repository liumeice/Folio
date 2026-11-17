/* CodeMirror 6 编辑器：行号/语法高亮/软换行原生自带（FR-7.1）。
 * 与 store 联动：onChange → setDraft；同时注册 EditorBridge 供滚动同步与大纲编辑态定位
 * （v1.2 一把尺：小数源码行号 lineFloat，方案 §4.1(c)(d)）：
 *  topLine() —— 视口顶 → 小数行号（软换行按可视块折算，非整行吸附）；
 *  jumpToLine(lineFloat) —— scrollIntoView 贴整行 + 下一帧 coordsAtPos 精确对齐视口顶。 */
import { Show, onCleanup, onMount } from "solid-js";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { md } from "../lib/mdEditor";
import { syntaxHighlighting } from "@codemirror/language";
import { mdHighlight } from "../lib/mdstyle";
import { mdStructural } from "../lib/mdStructural";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { SYNC_EPSILON } from "../lib/nav";

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
        // 中英混排文档里浏览器拼写检查满屏红波浪线（把 focus.css、拼音词全判"错拼"）——
        // contenteditable 默认 spellcheck=true，显式关闭
        EditorView.contentAttributes.of({ spellcheck: "false" }),
        EditorView.contentAttributes.of({ autocorrect: "off", autocapitalize: "off" }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) s.setDraft(u.state.doc.toString());
          if (u.viewportChanged || u.selectionSet) syncOutline();
        }),
      ],
    });
    ui.registerEditorBridge({ jumpToLine, topLine });
    const pj = ui.takePendingEditorJump();
    if (pj != null && pj > 0) jumpToLine(pj);
    view.focus();
    syncOutline();
    onCleanup(() => {
      ui.registerEditorBridge(null);
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
