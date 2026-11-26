/* 编辑区的"语法结构装饰"：只补 HighlightStyle 用 tag 表达不了的三件事。
 *
 * 基准是原型编辑区（prototype/prototype.html:2004-2038 着色器 + 394-408 配色表）：
 *   hl-fence  —— 围栏整行：text-2 + frame 底纹（行内代码是另一套 accent 底纹）
 *   hl-quote  —— 引用整行：text-2 + accent 6% 底纹
 *   hl-bullet —— 列表符号 `- * + 1.`：s-bullet 橙色 + 700（其它标记符都是 text-3 灰）
 *
 * lezer-markdown 把 InlineCode 与 CodeText 都标成 monospace、把 ListMark 与 HeaderMark/LinkMark
 * 都标成 processingInstruction，所以行内/围栏、子弹/普通标记在 tag 层面分不开——
 * 这里按语法树补行装饰与标记装饰，颜色全部留在 CSS，深浅主题自动跟随。 */
import { syntaxTree } from "@codemirror/language";
import type { Range, Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { frontMatterEnd } from "./md.ts";

const LINE_NODES = new Map<string, string>([
  ["FencedCode", "cm-fence-line"],
  ["CodeBlock", "cm-fence-line"],        // 缩进式代码块（lezer 叫 CodeBlock，不是 IndentedCode）
  ["HTMLBlock", "cm-fence-line"],
  ["Blockquote", "cm-quote-line"],
]);
const MARK_NODES = new Set(["ListMark"]);

type Item = { from: number; to: number; deco: Range<Decoration> };

/** 文档开头 YAML front matter 的收口行号（无 → 0）。逐行读取，不复制整篇；
 *  判据与阅读区一致（md.ts frontMatterEnd：首行 --- + body 像 YAML + ---/... 收口）。 */
export function frontMatterLastLine(doc: Text): number {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return 0;
  const lines: string[] = [];
  const cap = Math.min(doc.lines, 2000);   // 防御异常长文头部；正常 front matter 只有几行
  for (let n = 1; n <= cap; n++) {
    const text = doc.line(n).text;
    lines.push(text);
    if (n === 1) continue;
    const t = text.trimEnd();
    if (t !== "---" && t !== "...") continue;
    return frontMatterEnd(lines) >= 0 ? n : 0;
  }
  return 0;
}

function build(view: EditorView): DecorationSet {
  const items: Item[] = [];
  const doc = view.state.doc;
  /** 一行可能同时属于引用与围栏（引用里嵌代码），类名要合并而不是先到先得 */
  const lineCls = new Map<number, Set<string>>();

  const addLines = (from: number, to: number, cls: string) => {
    let pos = doc.lineAt(from).from;
    while (true) {
      const set = lineCls.get(pos);
      if (set) set.add(cls); else lineCls.set(pos, new Set([cls]));
      const line = doc.lineAt(pos);
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  };

  /* YAML front matter（2026-11-26）：lezer-markdown 不认头部区，收口 --- 会把上面几行
   * 当 Setext 标题（首行 --- 是 hr、其余是粗体标题，视觉不一致）。整块打 cm-frontmatter，
   * CSS 把标题样式降回正文，与阅读区的元数据卡对齐。 */
  const fmEnd = frontMatterLastLine(doc);
  for (let n = 1; n <= fmEnd; n++) {
    const line = doc.line(n);
    addLines(line.from, line.to, "cm-frontmatter");
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (node) => {
        const cls = LINE_NODES.get(node.name);
        if (cls) {
          addLines(node.from, node.to, cls);
          return;   // 继续下钻：引用块里嵌的围栏也要拿到 fence 类
        }
        if (MARK_NODES.has(node.name)) {
          items.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: "cm-bullet" }).range(node.from, node.to) });
        }
      },
    });
  }

  /* 数学块（2026-11-24）：lezer-markdown 不认 $$ 块，LaTeX 的 \\ \, \{ 会被当成 Markdown
   * 转义，整段染成转义色。这里按行扫描 $$ 围栏：围栏行 cm-math-fence、块内行 cm-math-line，
   * CSS 统一接管颜色，不再逐字符上色。仅在文档含 "$$" 时扫描。 */
  if (doc.toString().includes("$$")) {
    let inMath = false;
    for (let ln = 1; ln <= doc.lines; ln++) {
      const line = doc.line(ln);
      const delim = /^\s*\$\$\s*$/.test(line.text);
      if (delim) {
        addLines(line.from, line.to, "cm-math-fence");
        inMath = !inMath;
        continue;
      }
      if (inMath) addLines(line.from, line.to, "cm-math-line");
    }
  }
  for (const [pos, set] of lineCls) {
    items.push({ from: pos, to: pos, deco: Decoration.line({ class: [...set].join(" ") }).range(pos) });
  }
  items.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(items.map((i) => i.deco), true);
}

export const mdStructural = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
