/* CodeMirror 6 编辑器：行号/语法高亮/软换行原生自带（FR-7.1）。
 * 与 store 联动：onChange → setDraft；同时注册 EditorBridge 供滚动同步与大纲编辑态定位：
 *  jumpTo(sec, frac) —— 章节+比例 → 源码行；topFrac() —— 顶行 → 章节+比例（大纲跟随）。 */
import { Show, onCleanup, onMount } from "solid-js";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { md } from "../lib/mdEditor";
import { syntaxHighlighting } from "@codemirror/language";
import { mdHighlight } from "../lib/mdstyle";
import { mdStructural } from "../lib/mdStructural";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { lineForSecFrac, secFracFromTopline } from "../lib/nav";

export default function EditorPane() {
  const s = useStore();
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let raf = 0;

  function topFrac(): ui.SecFrac | null {
    if (!view || !s.current()) return null;
    // 顶行判定走 DOM ground-truth：posAtCoords 视口顶端下 4px → 文档位置。
    // （此前用 scrollTop - documentPadding.top 喂 lineBlockAtHeight，坐标系含 padding 与否
    //  差一手，顶行少算一行 → 大纲高亮恒判成上一章节。）
    let line0 = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    try {
      const r = view.scrollDOM.getBoundingClientRect();
      const cx = view.contentDOM.getBoundingClientRect().left + 8; // x 落在正文列，避开行号槽
      const pos = view.posAtCoords({ x: cx, y: r.top + 4 }, false);
      if (pos != null) line0 = view.state.doc.lineAt(pos).number - 1;
    } catch { /* 几何未就绪时退回光标行 */ }
    // 与阅读侧 FR-3.2 同判据：滚到底（末章内容不足以上滚到顶）时强制判给最后一个标题
    const sc = view.scrollDOM;
    if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 6) {
      const last = s.current()!.outline.at(-1);
      if (last) return { sec: last.sec, frac: 1 };
    }
    if (!s.current()!.outline.length) {
      return { sec: null, frac: view.state.doc.lines > 1 ? line0 / (view.state.doc.lines - 1) : 0 };
    }
    return secFracFromTopline(s.current()!.outline, line0);
  }

  function jumpTo(sec: number | null, frac: number) {
    const cur = s.current();
    if (!cur || !view) return;
    const line0 = sec == null
      ? Math.round(frac * (view.state.doc.lines - 1))     // 无标题文档：全文比例映射
      : lineForSecFrac(cur.outline, sec, frac);
    const safe = Math.min(line0 + 1, view.state.doc.lines);
    const pos = view.state.doc.line(safe).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }) });
    view.focus();
  }

  // 双 rAF：等 scrollIntoView 的几何应用稳定后再读顶行——单帧读会在滚动生效前
  // 拿到旧位置，把大纲点击刚设好的 activeSec 覆写回上一章节（差一章的根因之二）
  function syncOutline() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        raf = 0;
        const sf = topFrac();
        if (sf) s.setActiveSec(sf.sec);
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
    ui.registerEditorBridge({ jumpTo, topFrac });
    const pj = ui.takePendingEditorJump();
    if (pj && (pj.sec != null || pj.frac > 0)) jumpTo(pj.sec, pj.frac);
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
