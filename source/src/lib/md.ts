/* 迷你 Markdown 渲染器 —— 自原型移植，内联层升级为递归解析器。
 * 关键契约 1：标题 data-sec 编号必须与 folio-core::markdown::headings 完全一致。
 *   2026-11-21 第二档起，两侧共用同一行种类状态机：nextKind() ↔ Rust line_kinds()——
 *   围栏 ``` 与 ~~~ 都认、闭合=同字符且长度≥开栏；≥4 列三分流（懒延续/项内容/缩进代码）；
 *   Setext 下划线（=→h1、-→h2）只接紧邻段落、优先于 hr。headingMatch() 只管 ATX 行内容。
 *   引用块/提示块内的标题**不占锚点序号**——Rust 按原始行判定，"> # x" 不是标题。
 * 关键契约 2：任务清单序号坐标系同 Rust toggle_task（计数只认 Kind::List 行；
 *   围栏内/缩进代码/懒延续/引用前缀的 "- [ ]" 一律出局——审查报告 CON-01 + 第二档）。
 * 安全契约（审查报告 SEC-01）：renderSnippet 自带转义。
 * 远程图片口径（需求方 2026-11-16 定夺）：自动加载（<img src> + loading=lazy），
 *   与通用 Markdown 阅读器一致；「运行期零外联」的旧承诺据此让位于功能性。
 * 内联层支持：嵌套链接包图 [![a](i)](u)、参考式 [x][1] + 定义行、
 *   自动链接 <url>/<mailto>、裸 URL、反引号码段保护、反斜杠转义、强调/删除线、GFM emoji 短代码。 */
import { applyEmojis } from "./emoji.ts";
import { sanitizeHtml, sanitizeInlineTag, isAllowedTag } from "./htmlsan.ts";
import { zhCN } from "./i18n/catalog/zh-CN.ts";

/* ── 渲染 chrome 文案（多语言设计 §4.6.1，P4b）───────────────────────────────
 * md.ts 保持纯函数契约：不读 locale()、不调 t()——运行时由调用方（Reader）传入 RenderOptions。
 * 缺省值取源语言目录 zh-CN 的中文串（zh-CN 目录是界面文案唯一中文来源，本文件不内联中文）。
 * 所有注入 innerHTML 的翻译值都过 escapeHtml；callout/任务控件的 lang 用 uiLang，
 * 避免被文档自身语言带偏（设计 §4.6.1 第 4 条）。tests/unit/md.test.ts 等不传 opts 即中文原样。 */
const zhMsg = (k: string): string => (zhCN as unknown as Record<string, string>)[k];

export interface RenderOptions {
  /** callout 五类默认标题（复用 editor.callout.*，与编辑菜单同术语） */
  callout: { note: string; tip: string; important: string; warning: string; caution: string };
  copyCode: string;              // 代码块复制按钮文字
  copyCodeTitle: string;         // 按钮 title
  taskToggle: string;            // 可勾选任务 title
  taskNestedDisabled: string;    // 引用块内任务 title
  frontmatter: string;           // front matter 卡标题
  footnotes: string;             // 脚注区标题
  footnoteBack: string;          // 脚注回跳 title
  mermaidError: string;          // ⚠ 图表语法错误标注
  mermaidAlt: string;            // mermaid 错误回显标记（内部 Error 文本，不上屏）
  mathError: string;             // ⚠ 公式语法错误标注
  zenumlError: string;           // ⚠ zenuml 语法错误标注前缀（后接 " · " + 转义 reason）
  zenumlLoadError: string;       // 引擎缺失 reason
  zenumlParseError: string;      // 无定位信息时的 parse 失败 reason
  zenumlLineColumn: (d: { line: number; column: number; msg: string }) => string; // 定位 reason
  zenumlRenderError: string;     // 绘制异常 reason
  zenumlAlt: string;             // <img alt>（可访问性文案，必须翻译）
  uiLang: string;                // 注入 chrome 元素的 lang 属性值（BCP 47）
}

const interp = (tpl: string, p: Record<string, string | number>): string =>
  tpl.replace(/\{(\w+)\}/g, (m0, key: string) => (key in p ? String(p[key]) : m0));

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  callout: {
    note: zhMsg("editor.callout.note"), tip: zhMsg("editor.callout.tip"),
    important: zhMsg("editor.callout.important"), warning: zhMsg("editor.callout.warning"),
    caution: zhMsg("editor.callout.caution"),
  },
  copyCode: zhMsg("markdown.code.copy"),
  copyCodeTitle: zhMsg("markdown.code.copyTitle"),
  taskToggle: zhMsg("markdown.task.toggle"),
  taskNestedDisabled: zhMsg("markdown.task.nestedDisabled"),
  frontmatter: zhMsg("markdown.frontmatter"),
  footnotes: zhMsg("markdown.footnotes"),
  footnoteBack: zhMsg("markdown.footnoteBack"),
  mermaidError: zhMsg("markdown.mermaid.error"),
  mermaidAlt: zhMsg("markdown.mermaid.alt"),
  mathError: zhMsg("markdown.math.error"),
  zenumlError: zhMsg("markdown.zenuml.error"),
  zenumlLoadError: zhMsg("markdown.zenuml.loadError"),
  zenumlParseError: zhMsg("markdown.zenuml.invalidContent"),
  zenumlLineColumn: (d) => interp(zhMsg("markdown.zenuml.lineColumn"), { line: d.line, column: d.column, msg: d.msg }),
  zenumlRenderError: zhMsg("markdown.zenuml.renderError"),
  zenumlAlt: zhMsg("markdown.zenuml.alt"),
  uiLang: "zh-CN",
};

/** 本次渲染使用的文案（mdToHtml 入口设置、出口恢复；渲染全程同步，不存在并发交错）。 */
let RO: RenderOptions = DEFAULT_RENDER_OPTIONS;
/** opts 合并：缺字段回落中文默认，Partial 传入也安全。 */
function resolveOpts(opts?: Partial<RenderOptions>): RenderOptions {
  if (!opts) return DEFAULT_RENDER_OPTIONS;
  return {
    ...DEFAULT_RENDER_OPTIONS, ...opts,
    callout: { ...DEFAULT_RENDER_OPTIONS.callout, ...(opts.callout ?? {}) },
  };
}
/** lang 属性（uiLang 是 BCP 47 短串，仍走 escapeHtml 兜属性注入）。 */
const langAttr = (): string => ` lang="${escapeHtml(RO.uiLang)}"`;

/** CommonMark 4.6 类型 6 块标签表（规范原单，含已废弃项保持同集合）：这些标签的行可带后续内容直接开块。 */
const HTML_BLOCK_TAGS = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul|svg)$/i;

/** HTML 块起始判定（第三档，audit 4.6-c/6.11-a）：
 *  - `<!--` 注释行 → 开块（终止仍按"吃到空行"，跨空行注释属 4.6-b 残余）；
 *  - 类型 6 块标签表命中（标签名后紧跟 >、空白或 /）→ 开块，即使同行还有内容；
 *  - 其它**完整标签独占整行**（类型 7）→ 开块；
 *  - 其余（如 `<span>hi</span>`、`<script>alert(1)</script>` 这种带内容的行内标签行）
 *    → 归段落，走行内白名单/转义通道——与 GitHub 的 tagfilter 语义同向：
 *    危险标签转义可见而不是静默删除，普通行内标签不再吞掉后续 Markdown。
 *  `<https:` 自动链接被"标签名后必须 >空白/"排除；`<p=x>` 这类畸形标签同样不成块。 */
export function isHtmlBlockStart(line: string): boolean {
  if (/^ {0,3}<!--/.test(line)) return true;
  if (/^ {0,3}<[!?]/.test(line)) return true; // 类型 3/5 声明（<!DOCTYPE>）与类型 4 处理指令（<?xml?>）（audit 4.6-a）
  const m = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(line);
  if (!m) return false;
  if (!/^[>/\s]/.test(line.slice(m[0].length))) return false;
  if (HTML_BLOCK_TAGS.test(m[1])) return true;
  return /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/][^<>]*)?>$/.test(line);
}

/** 表格体终止判据（GFM 4.10「beginning of another block-level structure」，2026-11-21 P0）：
 *  ATX 标题 / 引用 / 围栏 / 分隔线（同字符×3 可带空格）/ 列表项起点。
 *  列表分支要求标记后紧跟空白，`---` 交给 hr 分支；`# h | x` 这类"含竖线的标题"从此终结表格。 */
const TABLE_STOP = /^ {0,3}(?:#{1,6}\s|>|```|~~~|([-*_])(?:\s*\1){2,}\s*$|(?:[-*+]|\d+[.)])[ \t])/;

/** 「图片行」单元：`![alt](url)` 或 README 徽章惯用的套链一层 `[![alt](img)](link)`。
 *  （首版只认裸 ![]()，Bootstrap 的 shields.io 徽章全是套链形态，整段漏判成普通段落竖排——2026-11-16 需求反馈） */
const IMG_LINE_RE = new RegExp(
  "^(?:(?:!\\[[^\\]]*\\]\\([^)]*\\)" +
    "|\\[!\\[[^\\]]*\\]\\([^)]*\\)\\]\\([^)]*\\))" + "[ \\t]*)+$",
);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* GFM 6.2 实体引用（2026-11-21 P0）：文本叶子中形如实体的串原样保留，交给浏览器按 HTML5
 * 规则解码（含 &#0; / 超范围码点的替换规则，无需自带实体表；未知命名实体浏览器本就按字面
 * 渲染，passthrough 无歧义）。代码段与属性值仍走 escapeHtml 字面化——那是规范要求的语义。 */
const ENTITY_RE = /&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;
export function escapeText(s: string): string {
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  ENTITY_RE.lastIndex = 0;
  while ((m = ENTITY_RE.exec(s)) !== null) {
    out += escapeHtml(s.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  out += escapeHtml(s.slice(last));
  return out;
}

/* 行内解析的两个控制码占位（正文里出现的真实 U+0001 由 mdToHtml 入口剥除）：
 *  ESCAPED——反斜杠转义的字面字符占位，强调/删除线正则不得把它当定界符（GFM 6.1 优先级）；
 *  BR_MARK——段内硬换行标记（GFM 6.12），叶子输出时替换为 <br>。 */
const ESCAPED = String.fromCharCode(1);
const BR_MARK = String.fromCharCode(2);
const BR_RE = new RegExp(String.fromCharCode(2), "g"); // 剥除硬换行占位（Setext 取段落文本用）

/** 段落行去掉行尾硬换行标记（imgOnly 之类的纯文本判定用） */
const paraBare = (l: string) => (l.endsWith(BR_MARK) ? l.slice(0, -1) : l);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ══════════════ 内联引擎 ══════════════ */

interface Def { url: string; title: string }
type Defs = Map<string, Def>;

const normLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function matchBracket(s: string, open: number): number {
  let depth = 1;
  let i = open + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      let run = 0;
      while (i + run < s.length && s[i + run] === "`") run++;
      const token = "`".repeat(run);
      let j = i + run;
      let ci = -1;
      for (;;) {
        j = s.indexOf(token, j);
        if (j === -1) break;
        if (s[j + run] !== "`") { ci = j; break; }
        j += run;
      }
      i = ci === -1 ? i + run : ci + run;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (!depth) return i; }
    i++;
  }
  return -1;
}

function parseInlineTarget(s: string, k: number): { url: string; title: string; end: number } | null {
  let i = k + 1;
  while (i < s.length && /\s/.test(s[i])) i++;
  let url = "";
  if (s[i] === "<") {
    const close = s.indexOf(">", i + 1);
    if (close === -1) return null;
    url = s.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) { url += s[i + 1]; i += 2; continue; }
      if (c === "(") { depth++; url += c; i++; continue; }
      if (c === ")") { if (depth === 0) break; depth--; url += c; i++; continue; }
      url += c;
      i++;
    }
  }
  while (i < s.length && /[ \t]/.test(s[i])) i++;
  let title = "";
  const q = s[i];
  if (q === '"' || q === "'" || q === "(") {
    const closer = q === "(" ? ")" : q;
    // 标题内反斜杠可转义闭引号（CC 6.1）："a\"b" 是合法 title；整体找不到闭引号才失败
    let close = -1;
    for (let p = i + 1; p < s.length; p++) {
      if (s[p] === "\\") { p++; continue; }
      if (s[p] === closer) { close = p; break; }
    }
    if (close === -1) return null;
    title = s.slice(i + 1, close).replace(/\\(?=[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "");
    i = close + 1;
    while (i < s.length && /[ \t]/.test(s[i])) i++;
  }
  if (s[i] !== ")") return null;
  return { url, title, end: i + 1 };
}

function flattenAlt(label: string): string {
  let out = label;
  out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  out = out.replace(/`([^`]*)`/g, "$1");
  out = out.replace(/(\*\*|__|\*|_|~~)/g, "");
  return out.trim();
}

function emitLinkOrImg(isImg: boolean, label: string, url: string, title: string, defs: Defs): string {
  // alt/title 是**文本语义**（GFM 6.2/6.7-a）：形如实体的串保留给浏览器解码，只转义字面
  // & < > " ——此前一律 escapeHtml，![AT&amp;T](/u) 的 alt 变成 &amp;amp; 二次转义。
  // URL 属性维持 escapeHtml 字面化（点击链路按字面取 href，不做实体解码）。
  const tAttr = title ? ` title="${escapeText(title)}"` : "";
  // 远程图片自动加载（需求方 2026-11-16 二次定夺：功能优先；此前的占位点击方案废弃）。
  // loading=lazy 保留：浏览器按需就近加载，长文档不一次拉全部。协议相对 // 交给
  // WebView 按当前 origin 解析（http: 文档 → http 图），CSP img-src 已放行 http(s)。
  if (isImg) return `<img alt="${escapeText(flattenAlt(label))}" src="${escapeHtml(url)}"${tAttr} loading="lazy">`;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"${tAttr}>${renderInline(label, defs)}</a>`;
}

/** 纯文本 run：先保护裸链接成自动链接，再做强调（强调内不再解析 URL，避免破坏属性）。
 *  GFM 6.9 扩展自动链接（2026-11-21 P0 补齐）：
 *   - http(s):// 与 www.（www. 补 http:// 前缀）；裸邮箱 → mailto:；
 *   - 邮箱要求前一字符非 word/标点粘连（防 URL/路径碎片误判）；
 *   - 结尾剥离带括号平衡：Foo_(bar) 的配对右括号留在 URL 内，未配对的 ) ] } 与常见尾标点才剥离。 */
const AUTO_LINK_RE = new RegExp(
  // 字符类同时挡两个控制符占位（BR_MARK 段尾标记/ESCAPED 转义位不许被 URL 吞走）
  "(?:https?://|www\\.)[^\\s<>\"'`" + BR_MARK + ESCAPED + "“”【】，。；：！？、]+",
  "gi",
);
// 域名部分刻意用扁平字符类：嵌套量词组 (?:[A-Za-z0-9-]*[A-Za-z0-9])+ 在长域名失败输入上是
// 指数级回溯（实测单测 45s+），禁用；`[A-Za-z0-9.-]*` + 尾段 `[A-Za-z]{2,}` 为线性形态。
// P2 收紧（↔ cmark-gfm EMAIL）：localpart 首尾必须字母数字、特殊符（._%+-）不得连续
// （a.@b、..b@c、+tag@x 不再自动链接）；域名各段同样禁首尾连字符；全部线性量词，无回溯陷阱。
const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9](?:[._%+-][A-Za-z0-9]|[A-Za-z0-9])*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;

/** URL 末尾剥离：标点直接剥；右括号仅在未配对时剥（数左括号） */
function trimUrlTail(u: string): string {
  let out = u;
  for (;;) {
    const lastCh = out[out.length - 1];
    if (out.length > 1 && /[.,;:!?"'`>]/.test(lastCh)) { out = out.slice(0, -1); continue; }
    if (out.length > 1 && (lastCh === ")" || lastCh === "]" || lastCh === "}")) {
      const openCh = lastCh === ")" ? "(" : lastCh === "]" ? "[" : "{";
      const opens = out.split(openCh).length - 1;
      const closes = out.split(lastCh).length - 1;
      if (closes > opens) { out = out.slice(0, -1); continue; }
    }
    break;
  }
  return out;
}

/* ══════════════ 内联引擎 v2（2026-11-22，CommonMark 0.31.2 对齐）══════════════
 * 三段流水线，替代旧的「正则强调 + 文本叶子」组合：
 *   ① tokenize：字符扫描 → token 流（文本 / 原子 html / 链接[带子流]）；
 *   ② applyEmphasis：文本内定界符 run 拆成 d-token → **cmark 分隔符栈**
 *      （left/right flanking、`_` 词内限制、rule of 3、就近开符配对、部分消费留残符）；
 *   ③ serialize：文本叶子做 GFM 自动链接 + ESCAPED 还原 + \n 硬换行判定 + emoji。
 * 旧实现的 EMPH_RE/emphasisPass 无法表达跨原子嵌套（*a `x`* / **(*foo)）与 run 长度语义，
 * CommonMark 审计 132 例强调题只过 60——此重写即其修复（audit-src.mjs 为回归门槛）。 */

type Tok =
  | { k: "t"; s: string }                                              // 原始文本（含 ESCAPED 占位与 \n）
  | { k: "x"; s: string }                                              // 原子：code/行内 HTML/自动链接/公式/脚注/图片
  | { k: "a"; pre: string; kids: Tok[]; post: string }                 // 链接：强调可跨过它，label 内部自成一层
  | { k: "d"; ch: string; len: number; ol: number; o: boolean; c: boolean; dead?: boolean } // 定界符 run
  | { k: "e"; tag: "em" | "strong" | "del"; kids: Tok[] };

/** 字符分类（↔ cmark ISSPACE/ISPUNCT）：ASCII 标点全集 + Unicode P/S 类 */
const CPUNCT = /[!-\/:-@\[-`{-~]|\p{P}|\p{S}/u;
const isWs = (ch: string): boolean => ch !== "" && /\s/.test(ch);
const isPn = (ch: string): boolean => ch !== "" && CPUNCT.test(ch);

/** token 的首/末 flanking 字符（cmark scan_delimiters 同构）：原子与链接容器取其标签字符
 *  （'<'/'>'，标点）——`*a `*`*`、`**foo [x](/u)**` 这类跨原子配对的内外侧判定全靠它；
 *  越界/无邻 → ""（cmark 的 null 字符）。 */
function firstVis(t: Tok | undefined): string {
  if (!t) return "";
  if (t.k === "t") return t.s[0] === ESCAPED ? (t.s[1] ?? "") : (t.s[0] ?? "");
  if (t.k === "d") return t.ch;
  if (t.k === "a") return "<";
  if (t.k === "e") return firstVis(t.kids[0]);
  return t.s[0] ?? ""; // x 原子：净化后 html 的首字符（'<'）
}
function lastVis(t: Tok | undefined): string {
  if (!t) return "";
  if (t.k === "t") {
    const L = t.s.length;
    if (L === 0) return "";
    return t.s[L - 2] === ESCAPED ? t.s[L - 1] : t.s[L - 1];
  }
  if (t.k === "d") return t.ch;
  if (t.k === "a") return ">";
  if (t.k === "e") return lastVis(t.kids[t.kids.length - 1]);
  return t.s[t.s.length - 1] ?? ""; // x 原子末字符（'>'）
}

/** ① 把文本 token 里的 `*`/`_`/`~` run 拆成 d-token，并按 cmark flanking 规则标定 canOpen/canClose。
 *  ESCAPED 对整体跳过（反斜杠定界符不启动强调，CC 6.1）；`~` run >2 不成删除线（GFM）。 */
function splitDelims(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  toks.forEach((tok, ni) => {
    if (tok.k !== "t") { out.push(tok); return; }
    const s = tok.s;
    let last = 0;
    let i = 0;
    while (i < s.length) {
      if (s[i] === ESCAPED) { i += 2; continue; }
      const ch = s[i];
      if (ch !== "*" && ch !== "_" && ch !== "~") { i++; continue; }
      let run = 0;
      while (i + run < s.length && s[i + run] === ch) run++;
      if (ch === "~" && run > 2) { i += run; continue; } // 波浪 run>2 当普通文本（GFM 定界上限）
      if (i > last) { out.push({ k: "t", s: s.slice(last, i) }); last = i; }
      const before = i > 0 ? (s[i - 2] === ESCAPED ? s[i - 1] : s[i - 1]) : lastVis(toks[ni - 1]);
      const after = i + run < s.length ? (s[i + run] === ESCAPED ? s[i + run + 1] : s[i + run]) : firstVis(toks[ni + 1]);
      const lf = after !== "" && !isWs(after) && (!isPn(after) || before === "" || isWs(before) || isPn(before));
      const rf = before !== "" && !isWs(before) && (!isPn(before) || after === "" || isWs(after) || isPn(after));
      const o = ch !== "_" ? lf : lf && (!rf || isPn(before));
      const c = ch !== "_" ? rf : rf && (!lf || isPn(after));
      out.push({ k: "d", ch, len: run, ol: run, o, c });
      i += run;
      last = i;
    }
    if (last < s.length) out.push({ k: "t", s: s.slice(last) });
  });
  return out;
}

/** ② cmark process_emphasis：定界符从左到右扫，闭符回溯最近合法开符；
 *  rule of 3、`~` 等长配对、部分消费（run 余数留在原位继续参与后续配对）。 */
function emphasisStack(lst: Tok[]): Tok[] {
  const dels = lst.filter((t): t is Extract<Tok, { k: "d" }> => t.k === "d");
  const stack: Extract<Tok, { k: "d" }>[] = [];
  for (const cl of dels) {
    if (cl.dead) continue;
    if (!cl.c) { if (cl.o) stack.push(cl); continue; }
    while (cl.c && cl.len > 0) {
      let oi = -1;
      for (let si = stack.length - 1; si >= 0; si--) {
        const op = stack[si];
        if (op.dead || op.ch !== cl.ch || !op.o || op.len === 0) continue;
        if (cl.ch === "~" && op.len !== cl.len) continue;                       // 删除线：run 必须等长
        if ((cl.o || op.c) && cl.ol % 3 !== 0 && (op.ol + cl.ol) % 3 === 0) continue; // rule of 3（按原始 run 长）
        oi = si; break;
      }
      if (oi < 0) break;
      const op = stack[oi];
      const use = cl.ch === "~" ? op.len : (op.len >= 2 && cl.len >= 2 ? 2 : 1);
      const tag = cl.ch === "~" ? "del" : use === 2 ? "strong" : "em";
      const oi2 = lst.indexOf(op);
      const ci2 = lst.indexOf(cl);
      if (oi2 === -1 || ci2 === -1 || ci2 <= oi2) { stack.length = oi; break; } // 防御：异侧（不该发生）
      const kids = lst.splice(oi2 + 1, ci2 - oi2 - 1);
      kids.forEach((kd) => { if (kd.k === "d") kd.dead = true; });
      op.len -= use;
      cl.len -= use;
      lst.splice(oi2 + (op.len > 0 ? 1 : 0), 0, { k: "e", tag, kids });
      stack.length = oi;
      if (op.len > 0) stack.push(op);
    }
    if (cl.dead || cl.len === 0) continue;
    if (cl.o) stack.push(cl); // 剩余闭符同时可作开符继续
  }
  return lst;
}

/** 残余 d-token → 字面文本（与相邻文本合并）；e 体只落字面（配对已在其内含处理），
 *  a（链接）体是**全新定界符域**——无论出现在哪一层都要独立跑一遍 applyEmphasis（cmark 同构）。 */
function literals(lst: Tok[]): Tok[] {
  const out: Tok[] = [];
  const pushT = (s: string) => { if (!s) return; const p = out[out.length - 1]; if (p && p.k === "t") p.s += s; else out.push({ k: "t", s }); };
  for (const t of lst) {
    if (t.k === "d") { pushT(t.ch.repeat(t.len)); continue; }
    if (t.k === "t") { pushT(t.s); continue; } // 相邻文本必须并拢：emoji 短码等 token 级模式跨碎块失效（:white_check_mark: 教训）
    if (t.k === "e") t.kids = literals(t.kids);
    else if (t.k === "a") t.kids = applyEmphasis(t.kids);
    out.push(t);
  }
  return out;
}

/** ② 主入口：本级 split→栈配对 → 残余定界符落字面；链接 label 重新起栈（cmark 同构）。 */
function applyEmphasis(toks: Tok[]): Tok[] {
  return literals(emphasisStack(splitDelims(toks)));
}

/* 文本叶子输出（P0-CM 改造）：ESCAPED+字符 → 转义后的字面字符（不再参与任何语法，GFM 6.1）；
 * 硬换行判定挪到这里（CC 6.7）：\n 前 ≥2 空格/tab → <br>；\n 前行尾单个反斜杠（非 ESCAPED 对）
 * → 吃掉反斜杠出 <br>；其余 \n 原样输出为软换行。块层不再预注入控制符——代码段/HTML 属性
 * 里的行尾空格保持原字符（audit #640-643），段末反斜杠不再丢字符（#644）。 */
/** 段落内软换行显示策略（设置项 softBreakBr，需求 2026-11-23）：false=按 GFM/CommonMark
 *  折叠为一个空格（默认）；true=软换行输出 <br>，逐行显示（Typora 习惯）。只影响显示，不改源文本。 */
let softBreakBr = false;
export function setSoftBreakBr(on: boolean): void { softBreakBr = on; }

function emitTextLeaf(t: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === ESCAPED && i + 1 < t.length) {
      out += escapeText(t.slice(last, i));
      out += escapeHtml(t[i + 1]);
      i++;
      last = i + 1;
    } else if (t[i] === "\n") {
      const pre = t.slice(last, i);
      if (/[ \t]{2,}$/.test(pre)) out += escapeText(pre.replace(/[ \t]+$/, "")) + "<br>";
      else if (pre.endsWith("\\") && !(pre.length >= 2 && pre[pre.length - 2] === ESCAPED)) out += escapeText(pre.slice(0, -1)) + "<br>";
      else out += escapeText(pre) + (softBreakBr ? "<br>" : "\n");   // 软换行：默认折叠（规范口径），开关开启逐行
      last = i + 1;
    }
  }
  out += escapeText(t.slice(last));
  return out;
}

/** ③ 文本叶子序列化：GFM 自动链接（URL/邮箱候选，重叠先到胜，CC 6.9 语义在转义前扫描）
 *  + ESCAPED 还原 + 硬换行 + emoji 短代码。强调配对已在 ② 完成，这里只剩行内链接。 */
function leafHtml(seg: string): string {
  type Cand = { start: number; end: number; text: string; href: string; mail: boolean };
  const cands: Cand[] = [];
  let m: RegExpExecArray | null;
  AUTO_LINK_RE.lastIndex = 0;
  while ((m = AUTO_LINK_RE.exec(seg)) !== null) {
    const prev = m.index > 0 ? seg[m.index - 1] : "";
    if (/[A-Za-z0-9/:@.\-]/.test(prev)) continue;   // 粘在更长 token 里（如 http://x/www.y）不算
    const raw = trimUrlTail(m[0]);
    if (raw.length < 8 && !raw.startsWith("www.")) continue;
    const href = raw.toLowerCase().startsWith("www.") ? "http://" + raw : raw;
    cands.push({ start: m.index, end: m.index + raw.length, text: raw, href, mail: false });
    AUTO_LINK_RE.lastIndex = m.index + Math.max(raw.length, 4);
  }
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(seg)) !== null) {
    let raw = m[0];
    while (raw.length > 1 && /[.,;:!?)\]"'>]/.test(raw[raw.length - 1])) raw = raw.slice(0, -1);
    cands.push({ start: m.index, end: m.index + raw.length, text: raw, href: "mailto:" + raw, mail: true });
  }
  cands.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const cd of cands) {
    if (cd.start < last) continue;   // 与先到者重叠：跳过
    out += applyEmojis(emitTextLeaf(seg.slice(last, cd.start)));
    out += `<a href="${escapeHtml(cd.href)}"${cd.mail ? "" : ' target="_blank" rel="noopener"'}>${escapeHtml(cd.text)}</a>`;
    last = cd.end;
  }
  out += applyEmojis(emitTextLeaf(seg.slice(last)));
  return out;
}

/** token 流 → HTML 字符串 */
function serialize(lst: Tok[]): string {
  let out = "";
  for (const t of lst) {
    if (t.k === "t") out += leafHtml(t.s);
    else if (t.k === "x") out += t.s;
    else if (t.k === "a") out += t.pre + serialize(t.kids) + t.post;
    else if (t.k === "e") out += `<${t.tag}>${serialize(t.kids)}</${t.tag}>`;
    else out += escapeHtml(t.ch.repeat(t.len)); // 漏网 d（理论不可达）
  }
  return out;
}

/** ① 字符扫描 → token 流：文本累积；代码段/公式/脚注/自动链接/行内 HTML 产原子 x；
 *  链接产 a 节点（label 子流递归 tokenize，强调配对在 ② 统一处理）。 */
function tokenize(src: string, defs: Defs): Tok[] {
  const toks: Tok[] = [];
  let buf = "";
  let i = 0;
  const n = src.length;
  const flush = () => {
    if (buf) { toks.push({ k: "t", s: buf }); buf = ""; }
  };
  const atom = (html: string) => { flush(); toks.push({ k: "x", s: html }); };
  while (i < n) {
    const c = src[i];
    // 反斜杠转义 → ESCAPED 占位（GFM 6.1：转义字符此后不得参与强调/删除线配对）
    if (c === "\\" && i + 1 < n && PUNCT.test(src[i + 1])) { buf += ESCAPED + src[i + 1]; i += 2; continue; }
    if (c === "`") {
      let run = 0;
      while (i + run < n && src[i + run] === "`") run++;
      const token = "`".repeat(run);
      let j = i + run;
      let ci = -1;
      for (;;) {
        j = src.indexOf(token, j);
        if (j === -1) break;
        let r2 = 0;
        while (src[j + r2] === "`") r2++;              // 此处反引号总长
        if (r2 === run) { ci = j; break; }             // CC 6.1：闭合必须等长
        j += r2;                                       // 不等长的 run 是内容，整体跳过再找
      }
      if (ci !== -1) {
        let code = src.slice(i + run, ci).replace(/\n/g, " ");
        // CC 6.1：换行→空格之后，首尾各一个空格才剥一层；纯空格内容不剥
        if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && /\S/.test(code)) code = code.slice(1, -1);
        atom(`<code>${escapeHtml(code)}</code>`);
        i = ci + run;
        continue;
      }
      buf += token;
      i += run;
      continue;
    }
    if (c === "$") {
      // 行内公式（MathJax 集成·方案 a）：$$…$$ 优先于 $…$；单行限定；不命中即字面量。
      // 定界规则按 GFM-math 收紧（真窗口回归教训：光查「体首尾非空白」会被
      // "$5 和 $10 …转义 \ $" 跨两句咬合成假公式）：
      //   开 $ 后必须紧跟非空白；闭 $ 前必须非空白、后必须非数字、且 \$ 转义对不参与配对。
      if (src.startsWith("$$", i)) {
        const closeIdx = src.indexOf("$$", i + 2);
        const body = closeIdx === -1 ? "" : src.slice(i + 2, closeIdx);
        if (closeIdx !== -1 && body.length > 0 && !/^\s|\s$|\n/.test(body)) {
          atom(`<span class="f-block" data-math="inline" data-lang="tex" data-code="${escapeHtml(body)}"></span>`);
          i = closeIdx + 2;
          continue;
        }
        buf += c;
        i++;
        continue;
      }
      if (i + 1 < src.length && !/\s/.test(src[i + 1])) {
        let j = i + 1;
        let hit = -1;
        while (j < src.length) {
          const ch = src[j];
          if (ch === "\\") { j += 2; continue; } // 反斜杠对（含 \$）整体跳过，不当闭界
          if (ch === "$") {
            const next = src[j + 1];
            if (!/\s/.test(src[j - 1]) && !(next && /\d/.test(next))) { hit = j; break; }
          }
          j++;
        }
        if (hit !== -1) {
          const body = src.slice(i + 1, hit);
          if (body.length > 0 && !body.includes("\n")) {
            atom(`<span class="f-block" data-math="inline" data-lang="tex" data-code="${escapeHtml(body)}"></span>`);
            i = hit + 1;
            continue;
          }
        }
      }
      buf += c;
      i++;
      continue;
    }
    /* Pandoc 上下标（2026-11-24 需求）：^内容^ → <sup>、~内容~ → <sub>；
     * 内容不含空白（与 Pandoc 口径一致），双标记 ~~ 仍归删除线，单 ~ 才可能成下标。 */
    if (c === "^" || c === "~") {
      const mark = c;
      const nx = src[i + 1];
      if (nx && nx !== mark && !/\s/.test(nx)) {
        let j = i + 1;
        let close = -1;
        while (j < n) {
          const ch = src[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === mark) {
            if (src[j + 1] === mark) { j += 2; continue; }   // 双标记属于删除线，不是上下标
            if (j > i + 1 && !/\s/.test(src[j - 1])) close = j;
            break;
          }
          if (/\s/.test(ch)) break;
          j++;
        }
        if (close !== -1) {
          const body = src.slice(i + 1, close);
          atom(mark === "^" ? `<sup>${renderInline(body, defs)}</sup>` : `<sub>${renderInline(body, defs)}</sub>`);
          i = close + 1;
          continue;
        }
      }
      buf += c;
      i++;
      continue;
    }
    /* 高亮（Obsidian/Typora 扩展，2026-11-24）：==内容== → <mark>；开合标记均须贴非空白，
     * 以避开 `a == b` 这类比较写法；行内代码内不生效。 */
    if (c === "=" && src[i + 1] === "=" && src[i + 2] !== "=") {
      const nx = src[i + 2];
      if (nx && !/\s/.test(nx)) {
        let j = i + 2;
        let close = -1;
        while (j < n) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "\n") break;
          if (src[j] === "=" && src[j + 1] === "=" && src[j + 2] !== "=") {
            if (j > i + 2 && !/\s/.test(src[j - 1])) { close = j; break; }
            j += 2;
            continue;
          }
          j++;
        }
        if (close !== -1) {
          atom(`<mark>${renderInline(src.slice(i + 2, close), defs)}</mark>`);
          i = close + 2;
          continue;
        }
      }
      buf += c;
      i++;
      continue;
    }
    if (c === "[" && FN) {
      // 脚注引用 [^标签]：有定义有编号 → 上标链接；否则按普通中括号文本（GitHub 同款回落）
      const fr = /^\[\^([^\]\s]{1,64})\]/.exec(src.slice(i));
      if (fr) {
        const nn = FN.num.get(fr[1]);
        if (nn !== undefined) {
          const idAttr = FN.seen.has(fr[1]) ? "" : ` id="fnref-${nn}"`;
          FN.seen.add(fr[1]);
          atom(`<sup class="fnref"${idAttr}><a href="#fn-${nn}">[${nn}]</a></sup>`);
          i += fr[0].length;
          continue;
        }
      }
    }
    const isImg = c === "!" && src[i + 1] === "[";
    if (c === "[" || isImg) {
      const open = isImg ? i + 1 : i;
      const close = matchBracket(src, open);
      if (close !== -1) {
        const label = src.slice(open + 1, close);
        // CommonMark 6.7：链接不得嵌进链接——label 含真链接时外层不成立，
        // 把 "[" 当字面量从内部重扫（内层链接照常产出，落点同 commonmark.js）。图片豁免（[![a](i)](u) 合法）。
        let labelToks: Tok[] | null = null;
        if (!isImg) {
          labelToks = tokenize(label, defs);
          if (labelToks.some((t) => t.k === "a")) { buf += c; i++; continue; }
        }
        const j = close + 1;
        let url: string | null = null;
        let title = "";
        let end = -1;
        if (src[j] === "(") {
          if (src[j + 1] === ")") { url = ""; end = j + 2; }
          else {
            const tgt = parseInlineTarget(src, j);
            if (tgt) { url = tgt.url; title = tgt.title; end = tgt.end; }
          }
        } else if (src[j] === "[") {
          const rc = matchBracket(src, j);
          if (rc !== -1) {
            const rl = src.slice(j + 1, rc);
            const def = defs.get(normLabel(rl === "" ? label : rl));
            if (def) { url = def.url; title = def.title; end = rc + 1; }
          }
        } else {
          const def = defs.get(normLabel(label));
          if (def) { url = def.url; title = def.title; end = j; }
        }
        if (url !== null) {
          if (isImg) {
            // alt 是文本语义（GFM 6.2/6.7-a）：实体透传；URL 属性维持字面化 escapeHtml。
            // 远程图片自动加载（需求方 2026-11-16 定夺）：src 直出 + loading=lazy。
            atom(`<img alt="${escapeText(flattenAlt(label))}" src="${escapeHtml(url)}"${title ? ` title="${escapeText(title)}"` : ""} loading="lazy">`);
          } else {
            flush();
            toks.push({
              k: "a",
              pre: `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"${title ? ` title="${escapeText(title)}"` : ""}>`,
              kids: labelToks!,
              post: "</a>",
            });
          }
          i = end;
          continue;
        }
      }
    }
    if (c === "<") {
      const close = src.indexOf(">", i + 1);
      if (close !== -1) {
        const inner = src.slice(i + 1, close);
        if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/.test(inner)) {
          flush();
          atom(`<a href="${escapeHtml(inner)}" target="_blank" rel="noopener">${escapeHtml(inner)}</a>`);
          i = close + 1;
          continue;
        }
        if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(inner)) {
          atom(`<a href="mailto:${escapeHtml(inner)}">${escapeHtml(inner)}</a>`);
          i = close + 1;
          continue;
        }
      }
      // GFM 6.10 行内原始 HTML（2026-11-21 P0）：<kbd>/<sup>/<span>/<br>/行内 <img>… 与文本流交错，
      // 单标签走 htmlsan.sanitizeInlineTag 白名单净化（DOMParser 会替半截开标签补闭、污染输出流，故不用它）；
      // 不允许的标签（含 DROP 与未知）按 tag-filter 语义**转义为可见文本**——比静默删除更不易丢内容。
      // 净化产物是原子 token，天然免疫强调配对与 URL 再解析。
      const tagM = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:"[^"]*"|'[^']*'|[^<>"'`])*?>/.exec(src.slice(i));
      if (tagM) {
        atom(sanitizeInlineTag(tagM[0]) ?? escapeHtml(tagM[0]));
        i += tagM[0].length;
        continue;
      }
      const cmtM = /^<!--[\s\S]*?(?:-->|$)/.exec(src.slice(i));
      if (cmtM) {
        atom(cmtM[0]);   // 注释在 innerHTML 里惰性无害（与块级净化器同口径保留注释节点）
        i += cmtM[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return toks;
}

/** 内联渲染唯一入口：分词 → 分隔符栈强调 → 序列化 */
export function renderInline(src: string, defs: Defs): string {
  return serialize(applyEmphasis(tokenize(src, defs)));
}

/* ══════════════ 块层 ══════════════ */

/** 表格分列：代码段内的 |、反斜杠转义 \| 都不算分隔符（GFM 语义） */
/** 表格分隔行单元 → GFM 对齐（:---=left，---:=right，:---:=center，无冒号=默认不输出）。
 *  非对齐单元（空/异常形态）返回 ""，单元格不带样式（2026-11-21 需求：| :---: | 生效）。 */
function cellAlign(raw: string): string {
  const s = raw.trim();
  if (!/^:?-+:?$/.test(s)) return "";
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function splitRow(s: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "\\" && i + 1 < n && PUNCT.test(s[i + 1])) { cur += c + s[i + 1]; i += 2; continue; }
    if (c === "`") {
      let run = 0;
      while (i + run < n && s[i + run] === "`") run++;
      const token = "`".repeat(run);
      let j = i + run;
      let ci = -1;
      for (;;) {
        j = s.indexOf(token, j);
        if (j === -1) break;
        if (s[j + run] !== "`") { ci = j; break; }
        j += run;
      }
      if (ci !== -1) { cur += s.slice(i, ci + run); i = ci + run; continue; }
      cur += token; i += run; continue;
    }
    if (c === "|") { cells.push(cur); cur = ""; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur);
  const t = s.trim();
  if (cells.length > 1 && t.startsWith("|") && /^\s*$/.test(cells[0])) cells.shift();
  if (cells.length > 1 && t.endsWith("|") && /^\s*$/.test(cells[cells.length - 1])) cells.pop();
  return cells.map((x) => x.trim());
}

/* ── GFM Callouts：`> [!NOTE]` 等五类；body 为其余引用行（可含列表/代码/嵌套引用）──
 * 变体：`[!NOTE] 自定义标题`；`[!NOTE]-` 默认折叠、`[!NOTE]+` 默认可展开（点击标题切换）。
 * 未知类型自动回落普通 blockquote（与 GitHub 行为一致）。 */
/* P4b：默认标题不内联中文——图标留这里，标题按当前 RenderOptions 取（缺省=zh-CN 目录中文）。
 * 用户自定义标题 `[!NOTE] 我的标题` 保持原文不译、也不加 lang（那是文档内容，不是应用 chrome）。 */
const CALLOUT_TYPES = {
  note: { icon: "i-co-note" },
  tip: { icon: "i-co-tip" },
  important: { icon: "i-co-important" },
  warning: { icon: "i-co-warning" },
  caution: { icon: "i-co-caution" },
} as const;

const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([+-])?(?:[ \t]+(.*))?$/i;

function parseCallout(buf: string[], defs: Defs, nested: boolean, lineAttrs: string, bodyBaseLine: number): string | null {
  if (!buf.length) return null;
  const m = buf[0].trim().match(CALLOUT_RE);
  if (!m) return null;
  const key = m[1].toLowerCase() as keyof typeof CALLOUT_TYPES;
  const spec = CALLOUT_TYPES[key];
  const fold = m[2] === "-" || m[2] === "+";
  const collapsed = m[2] === "-";
  const customTitle = (m[3] ?? "").trim();
  const title = customTitle || RO.callout[key as keyof RenderOptions["callout"]];
  // 正文行与原始行逐行 1:1（仅剥 "> " 前缀），故传 bodyBaseLine 让子块记绝对行号（方案 §4.1(a) 嵌套记账）
  const body = buf.length > 1 ? renderBlocks(buf.slice(1).join("\n"), defs, nested, bodyBaseLine) : "";
  // lang 只随应用 chrome（默认标题）走 head；用户自定义标题属文档内容，不标 lang（设计 §4.6.2）
  const headLang = customTitle ? "" : langAttr();
  return (
    `<div class="callout co-${key}${collapsed ? " folded" : ""}" data-callout="${key}"${fold ? ` data-fold="1"` : ""}${lineAttrs}>` +
      `<div class="co-head"${headLang}${fold ? ` role="button" tabindex="0" aria-expanded="${!collapsed}"` : ""}>` +
        `<svg class="ico ico-14"><use href="#${spec.icon}"/></svg><span>${escapeHtml(title)}</span>` +
        (fold ? `<svg class="ico ico-12 co-chev"><use href="#i-chev-d"/></svg>` : "") +
      `</div><div class="co-body">${body}</div>` +
    `</div>`
  );
}

/** 参考式链接定义行（CommonMark 子集，≤3 空格缩进） */
/* 链接引用定义（第三档 audit 4.7-a/b）：标签允许反斜杠转义 ]（[a\]] 合法）；
 * 目标/标题可落在后续行（≤3 列缩进的连续行）。DEF_HEAD_RE 认标签行+行内剩余，
 * DEF_DEST_RE 解析「目标 [行内标题]」，DEF_TITLE_ONLY_RE 认「整行只有标题」。 */
const DEF_HEAD_RE = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(.*)$/;
const DEF_DEST_RE = /^(?:<([^\s<>]*)>|([^\s]+))(?:[ \t]+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\(((?:[^)\\]|\\.)*)\)))?[ \t]*$/;
const DEF_TITLE_ONLY_RE = /^[ \t]+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\(((?:[^)\\]|\\.)*)\))[ \t]*$/;
const defContOk = (ln: string | undefined): boolean => ln !== undefined && ln.trim() !== "" && indentCol(ln) <= 3;

/** 解析 i 处起的定义（1~3 行）。返回 used=消费行数（块层据此把续行照常喂状态机）。 */
export function defParse(lines: string[], i: number): { label: string; url: string; title: string; used: number } | null {
  const m = lines[i]?.match(DEF_HEAD_RE);
  if (!m) return null;
  const label = m[1];
  if (label.startsWith("^")) return null; // [^x]: 是脚注定义（GitHub 扩展），不再充当链接引用标签
  let rest = m[2];
  let used = 1;
  if (rest === "") {
    // 目标在下一行（CC 4.7 完整形）：非空、≤3 列缩进
    if (!defContOk(lines[i + 1])) return null;
    rest = lines[i + 1].trim();
    used = 2;
  }
  const dt = rest.match(DEF_DEST_RE);
  if (!dt) return null;
  const url = dt[1] ?? dt[2] ?? "";
  let title = dt[3] ?? dt[4] ?? dt[5] ?? "";
  if (title === "" && defContOk(lines[i + used])) {
    // 标题在下一行（audit 4.7-a）
    const tm = lines[i + used].match(DEF_TITLE_ONLY_RE);
    if (tm) { title = tm[1] ?? tm[2] ?? tm[3] ?? ""; used += 1; }
  }
  return { label, url, title, used };
}

/* ── 第二档行种类状态机（2026-11-21 GFM）：与 Rust folio-core::markdown::
 * {fence_open,fence_close,indent_col,after_list_marker,line_kinds} 逐条镜像。
 * 块层分支路由、flipTaskInSrc、taskMarksIn、DEF 预扫、api.ts mock 全共用这一台机器——
 * 两侧坐标系的唯一入口，改任何一支必须双跑（tests/unit/md.test.ts ↔ markdown.rs::tests）。 ── */

export interface Fence { ch: string; len: number }

/** 围栏开启行：行首（容忍任意缩进）≥3 个同一 ` 或 ~。缩进刻意不设上限——列表项内缩进围栏
 *  是存量文档常见写法，收紧会拆坏既有配对（与 fence_open 同口径的已批准偏差）。 */
export function fenceOpen(line: string): Fence | null {
  const t = line.replace(/^\s+/, "");
  const c = t[0];
  if (c !== "`" && c !== "~") return null;
  let n = 0;
  while (n < t.length && t[n] === c) n++;
  if (n < 3) return null;
  // CC 4.5（第五批）：反引号围栏的 info string 不得再含反引号（``` ``` 不成栏）↔ Rust fence_open
  if (c === "`" && t.slice(n).includes("`")) return null;
  return { ch: c, len: n };
}

/** 围栏闭合行：同字符、长度 ≥ 开启长度、其后仅空白。 */
export function fenceClose(line: string, open: Fence): boolean {
  const f = fenceOpen(line);
  if (!f || f.ch !== open.ch || f.len < open.len) return false;
  return !/\S/.test(line.replace(/^\s+/, "").slice(f.len));
}

/** info 串首词 = 语言（classifyCodeLang 取词口径 ↔ Rust fence_info/is_skipped_fence）。 */
export function fenceInfo(line: string): string {
  const t = line.replace(/^\s+/, "");
  const n = /^[`~]+/.exec(t)?.[0].length ?? 0;
  return t.slice(n).trim().split(/\s+/)[0] ?? "";
}

/** 行首缩进列（Tab 按 4 列制表位推进，CommonMark 2.2）；≥8 即返回不必精确。 */
export function indentCol(line: string): number {
  let col = 0;
  for (const c of line) {
    if (c === " ") col += 1;
    else if (c === "\t") col += 4 - (col % 4);
    else break;
    if (col >= 8) return col;
  }
  return col;
}

/** 列表嵌套深度专用宽度：Tab=4 列制表位、不设 8 列截断（indentCol 为状态机服务，早停）。 */
function indentWidth(ws: string): number {
  let col = 0;
  for (const c of ws) {
    if (c === " ") col += 1;
    else if (c === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** 剥掉 ≤cols 列缩进（Tab 按制表位对齐；跨边界的 Tab 展开为剩余空格，CC 2.2/缩进代码口径）。 */
function stripIndentCols(line: string, cols: number): string {
  let col = 0, p = 0;
  while (p < line.length && col < cols) {
    const c = line[p];
    if (c === " ") { col++; p++; }
    else if (c === "\t") {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; p++; }
      return " ".repeat(Math.max(0, cols - col)) + line.slice(p); // tab 跨界：拆成空格
    }
    else break;
  }
  return line.slice(p);
}
const stripIndentCol4 = (line: string): string => stripIndentCols(line, 4);

/** 列表标记拆分（↔ Rust after_list_marker）：命中返回内容起始列——
 *  缩进 + (-|*|+|n.|n\)) + 空白；"- " 空内容也算命中；不要求标记后有字符。 */
export function afterListMarkerIdx(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  if (i >= line.length) return -1;
  let j = -1;
  const c0 = line[i];
  if (c0 === "-" || c0 === "*" || c0 === "+") j = i + 1;
  else {
    let k = i;
    while (k < line.length && line[k] >= "0" && line[k] <= "9") k++;
    // CC 5.2（第五批）：有序标记数字至多 9 位，超限不是列表标记（#266）↔ Rust after_list_marker
    if (k > i && k - i <= 9 && k < line.length && (line[k] === "." || line[k] === ")")) j = k + 1;
  }
  if (j < 0) return -1;
  if (j >= line.length) return j; // 标记即整行（"-"/"1."）= 空列表项（CC 5.2，↔ Rust after_list_marker）
  if (line[j] !== " " && line[j] !== "\t") return -1;
  while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
  return j;
}

/** 列表行起始（↔ Rust list_start）：打断紧邻段落时——空项不得打断；
 *  有序项数字必须是 1（CC 5.2，第三档 audit 5.2-a）。 */
function isListStartKind(line: string, interrupting: boolean): boolean {
  const b = afterListMarkerIdx(line);
  if (b < 0) return false;
  if (!interrupting) return true;
  if (b >= line.replace(/[ \t]+$/, "").length) return false;
  const t = line.replace(/^[ \t]+/, "");
  if (t[0] >= "0" && t[0] <= "9") {
    return /^[0-9]+/.exec(t)![0].replace(/^0+/, "") === "1";
  }
  return true;
}

/** 分隔线（GFM 4.1 变体）：≥3 个同一 -/_/*，字符间可夹空白（↔ Rust is_hr）。 */
function isHrLine(t: string): boolean {
  const c = t[0];
  if (c !== "-" && c !== "_" && c !== "*") return false;
  let n = 0;
  for (const ch of t) {
    if (ch === " " || ch === "\t") continue;
    if (ch !== c) return false;
    n++;
  }
  return n >= 3;
}

const NUL_CH = String.fromCharCode(0);
const FFFD_CH = String.fromCharCode(0xFFFD);
/** 输入预处理（P2，↔ Rust normalize()）：NUL→U+FFFD（CommonMark 2.1）。 */
export function normalizeInput(src: string): string {
  return src.indexOf(NUL_CH) === -1 ? src : src.split(NUL_CH).join(FFFD_CH);
}
/** 行切分（P2）：LF/CRLF/裸 CR 都是行界（↔ Rust normalize().lines()）。 */
export function splitSrcLines(src: string): string[] {
  return normalizeInput(src).replace(/\r\n?/g, "\n").split("\n");
}

/** YAML front matter（GitHub/Jekyll 扩展，2026-11-22；第五批收紧）：首行恰为 `---`，收口行 `---`/`...`；
 *  返回收口行下标，不成立 → -1（↔ Rust front_matter_end 同判据）。
 *  body 必须整体"像 YAML"：空行外只允许一行有内容（多段落即普通 hr/setext），且该行是
 *  `key:`、`- 项`、`# 注释`、`key: [流]` 形态——cmark 官方例 #96/#98（hr+Setext 序列）据此不再误判。 */
export function frontMatterEnd(lines: string[]): number {
  if (lines.length === 0 || lines[0].trimEnd() !== "---") return -1;
  const looksYaml = (l: string) => /^(?:# |- |["']|[A-Za-z_][\w.-]*:(?:[ \t]|$))/.test(l); // 冒号必选：裸单词不算键值行（#96 教训）
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trimEnd();
    if (t !== "---" && t !== "...") continue;
    const body = lines.slice(1, i).map((l) => l.trim()).filter((l) => l !== "");
    if (body.length > 0 && body.every(looksYaml)) return i;
    return -1; // 找到收口但 body 不像 YAML（裸文本/空 body）：整段按普通 hr/段落/Setext 走 CommonMark
  }
  return -1;
}

/* ── 脚注（GitHub 扩展，非 GFM 规范，2026-11-22）──
 * 定义 = 顶格 `[^标签]: 内容` + 后续 ≥2 列缩进延续行；引用 = 行内 `[^标签]`。
 * 编号按引用首次出现顺序（GitHub 同规则）；正文中定义块被收集不内联渲染，
 * 文末汇总为 .footnotes 节。坐标系安全：定义行在块层照常喂行种类状态机（Rust 视角
 * 它们是 Para/Head/List），栏内真任务的隐藏 data-task 占位打在定义位置——与 $$ 块同方案。 */
interface FnReg {
  defs: Map<string, string[]>;                    // 标签 → 去缩进后的内容行
  num: Map<string, number>;                       // 标签 → 编号（仅被引用的）
  starts: Map<number, { label: string; end: number }>; // 定义首行（绝对行号）→ 覆盖区间
  seen: Set<string>;                              // 已出过 id="fnref-N" 的标签（回跳锚只给首个引用）
}
let FN: FnReg | null = null;
const FN_DEF_RE = /^ {0,3}\[\^([^\]\s]{1,64})\]:[ \t]*(.*)$/;
const FN_REF_RE = /\[\^([^\]\s]{1,64})\]/g;
const FN_CONT_RE = /^(?: {2,}|\t)\S/;

function fnPrescan(lines: string[], from: number): FnReg {
  const reg: FnReg = { defs: new Map(), num: new Map(), starts: new Map(), seen: new Set() };
  const st = newKindState();
  for (let i = from; i < lines.length; i++) {
    const k = nextKind(lines[i], st);
    if (k === "fo" || k === "fc" || k === "fi") continue; // 围栏内不是定义
    const m = FN_DEF_RE.exec(lines[i]);
    if (!m || reg.defs.has(m[1])) continue;
    const body: string[] = [m[2]];
    let j = i + 1;
    while (j < lines.length) {
      const k2 = nextKind(lines[j], st);
      if (k2 === "fo" || k2 === "fc" || k2 === "fi") break; // 围栏插进来 → 定义终止（围栏归主循环）
      if (/^\s*$/.test(lines[j])) {
        let p = j;
        while (p < lines.length && /^\s*$/.test(lines[p])) p++;
        const kp = p < lines.length ? nextKind(lines[p], st) : "blank";
        if (p >= lines.length || kp === "fo" || kp === "fc" || kp === "fi" || !FN_CONT_RE.test(lines[p]) || FN_DEF_RE.test(lines[p])) break;
        for (; j < p; j++) body.push("");
        continue;
      }
      if (!FN_CONT_RE.test(lines[j]) || FN_DEF_RE.test(lines[j])) break;
      body.push(lines[j].replace(/^(?: {1,2}|\t)/, ""));
      j++;
    }
    while (body.length > 1 && body[body.length - 1] === "") body.pop();
    let end = i;
    for (let q = i + 1; q < j; q++) if (!/^\s*$/.test(lines[q])) end = q;
    reg.defs.set(m[1], body);
    reg.starts.set(i, { label: m[1], end });
    i = j - 1;
  }
  const st2 = newKindState();
  for (const ln of lines) {
    const k = nextKind(ln, st2);
    if (k === "fo" || k === "fc" || k === "fi") continue;
    FN_REF_RE.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = FN_REF_RE.exec(ln)) !== null) {
      if (reg.defs.has(r[1]) && !reg.num.has(r[1])) reg.num.set(r[1], reg.num.size + 1);
    }
  }
  return reg;
}

export type LineKind =
  | "blank" | "fo" | "fc" | "fi" // 空行 / 开栏 / 闭栏 / 栏内
  | "head" | "setext" | "hr" | "list" | "quote" | "code" | "para" | "other";

export interface KindState {
  fence: Fence | null; // 当前开启的围栏（fo→置位，fc→清空）
  prev: LineKind;      // 上一非空行种类（≥4 列三分流与代码运行续行用）
  adjPar: boolean;     // 紧邻上一行是段落正文——Setext 必须贴段落，空行即复位
}
export function newKindState(): KindState { return { fence: null, prev: "blank", adjPar: false }; }

/** 推进一行、返回其种类——Rust line_kinds() 循环体的逐条镜像（分支顺序即语义）。
 *  行文本必须已剥 \r（Rust src.lines() 天然不含）。 */
export function nextKind(raw: string, st: KindState): LineKind {
  let k: LineKind;
  if (st.fence) {
    if (fenceClose(raw, st.fence)) { st.fence = null; k = "fc"; }
    else k = "fi";
  } else {
    const t = raw.trim();
    if (!t) k = "blank";
    else if (st.prev === "code" && indentCol(raw) >= 4) k = "code"; // 缩进代码运行中：``` 只是内容
    else {
      const fo = fenceOpen(raw);
      if (fo) { st.fence = fo; k = "fo"; }
      else if (indentCol(raw) >= 4) {
        // ≥4 列三分流（↔ Rust）：紧邻段落→懒延续（规范：缩进代码不能打断段落）；
        // 上承列表→项内容（4 列 ATX/深缩进宽松口径，已批准偏差）；其余→缩进代码。
        // 2026-11-23 规范修正：判据由 prev=="para" 改为 adjPar——空行结束段落，
        // "段落 + 空行 + 4 列缩进"回归缩进代码块（原偏差作用面过大，见 CLAUDE.md）。
        if (st.adjPar) k = "para";
        else if (st.prev === "list") k = t[0] === "#" ? "head" : afterListMarkerIdx(raw) >= 0 ? "list" : "para";
        else k = "code";
      } else if (t[0] === "#") k = "head";
      else if (st.adjPar && (/^=+$/.test(t) || /^-+$/.test(t))) k = "setext";
      else if (isHrLine(t)) k = "hr";
      else if (isListStartKind(raw, st.adjPar)) k = "list";
      else if (t[0] === ">") k = "quote";
      else if (t[0] === "<") k = "other";
      else k = "para";
    }
  }
  if (k !== "blank") st.prev = k;
  st.adjPar = k === "para";
  return k;
}

export function lineKinds(src: string): LineKind[] {
  const st = newKindState();
  const ls = splitSrcLines(src);
  const fm = frontMatterEnd(ls); // 头部区整体 Blank 且不进状态机（↔ Rust line_kinds 跳头）
  const out: LineKind[] = new Array<LineKind>(ls.length).fill("blank");
  for (let i = fm >= 0 ? fm + 1 : 0; i < ls.length; i++) out[i] = nextKind(ls[i], st);
  return out;
}

/** Rust headings() 的整体镜像（大纲/锚点权威坐标）：ATX + Setext（line 记段落首行）。 */
export interface HeadInfo { sec: number; level: number; text: string; line: number }
export function headingsOfSrc(src: string): HeadInfo[] {
  const lines = splitSrcLines(src);
  const kinds = lineKinds(src);
  const out: HeadInfo[] = [];
  let paraRun = -1; // 连续 Para 行的首行（Blank/Head 等一律复位，↔ Rust headings 的 para_run）
  lines.forEach((raw, i) => {
    const k = kinds[i];
    if (k === "para") { if (paraRun < 0) paraRun = i; return; }
    if (k === "setext") {
      const start = paraRun >= 0 ? paraRun : Math.max(0, i - 1);
      out.push({ sec: out.length + 1, level: raw.trim()[0] === "=" ? 1 : 2, text: lines.slice(start, i).join(" ").trim(), line: start });
      paraRun = -1;
      return;
    }
    paraRun = -1;
    if (k !== "head") return;
    const m = headingMatch(raw);
    if (!m) return; // "#tag" 之类 kinds 记 Head 但不产出条目（↔ Rust hashes>6 / 无空白分支）
    out.push({ sec: out.length + 1, level: m.level, text: m.text, line: i });
  });
  return out;
}

/** 切换第 nth 个（0 起）**可勾选**任务的勾选态——Rust toggle_task 的 TS 镜像（契约 2 同坐标系）。
 *  第二档：计数只认 LineKind="list" 行——围栏配对（```/~~~ 同类长闭）、缩进代码、懒延续里的
 *  假任务一律出局。手动保存链路专用（2026-11-18 定夺：打勾不即时写盘），越界返回 null；
 *  替换仍原地切片，CRLF/LF 风格与文件末尾换行保留。 */
export function flipTaskInSrc(src: string, nth: number): string | null {
  const st = newKindState();
  const fmE = frontMatterEnd(splitSrcLines(src)); // YAML 头内假任务不计（↔ Rust line_kinds 跳头）
  let seen = 0;
  let lineStart = 0;
  let lineIdx = 0;
  const n = src.length;
  for (;;) {
    let lineEnd = src.indexOf("\n", lineStart);
    const crAt = src.indexOf("\r", lineStart);
    if (crAt >= 0 && (lineEnd < 0 || crAt < lineEnd)) lineEnd = crAt; // P2：裸 CR 也是行界（↔ Rust split_lines_cr）
    if (lineEnd < 0) lineEnd = n;
    const line = src.slice(lineStart, lineEnd); // 终止符天然不含在 line 内
    const inFm = fmE >= 0 && lineIdx <= fmE;
    if (!inFm && nextKind(line, st) === "list") {
      const rel = afterListMarkerIdx(line);
      const j = lineStart + rel;
      // 任务框 [ ] / [x] / [X]：']' 必须在行内（Rust task_parts 的 bc.len()≥3）
      if (rel >= 0 && j + 2 < lineStart + line.length && src[j] === "[" && src[j + 2] === "]") {
        const state = src[j + 1];
        if (state === " " || state === "x" || state === "X") {
          if (seen === nth) {
            return src.slice(0, j + 1) + (state === " " ? "x" : " ") + src.slice(j + 2);
          }
          seen++;
        }
      }
    }
    if (lineEnd >= n) break;
    lineStart = lineEnd + (src[lineEnd] === "\r" && src[lineEnd + 1] === "\n" ? 2 : 1);
    lineIdx++;
  }
  return null;
}

/** ATX 标题判定：folio-core::markdown::headings 行逻辑的逐条镜像（CON-02 修复）：
 *  前导空白一律容忍（Rust trim_start）、"#" 单独成行也算空标题、"#" 后必须空白或行尾、
 *  闭合 # 串仅在「整串即标题」或「# 串前有空白」时剥离。返回 level(1–6)+text（可空串）。 */
export function headingMatch(line: string): { level: number; text: string } | null {
  const t = line.replace(/^\s+/, "");
  let i = 0;
  while (i < t.length && t[i] === "#") i++;
  if (i === 0 || i > 6) return null;
  const rest = t.slice(i);
  if (rest && rest[0] !== " " && rest[0] !== "\t") return null;
  let text = rest.trim();
  if (text.endsWith("#")) {
    const cut = text.replace(/#+$/, "");
    if (cut === "" || /[ \t]$/.test(cut)) text = cut.replace(/[ \t]+$/, "");
  }
  return { level: i, text };
}

/* ── 公式/图表块（MathJax + Mermaid 集成，见根目录《Mermaid与MathJax渲染实现提示词.md》）──
 * 渲染期零解析零求值：只切类型、存原文、输出占位符；排版延迟到 DOM 插入后
 * （lib/mathjax.ts / lib/mermaidRender.ts），语法错误由那两个模块退化为 <pre>。
 * 坐标不变量：Rust markdown.rs 只把 ``` 当围栏——$$…$$ 内的 "# " 行在 Rust 侧仍计标题、
 * "- [ ]" 行仍计任务。TS 吞掉这些行的渲染后，必须同点补记 secN 与隐藏 data-task 占位，
 * 否则其后所有章节/任务序号全体错位（CON-01/CON-02 的同类坑，绝不重演）。
 * ```math / ```mermaid 走真 ``` 围栏 → Rust 整段跳过 → 无需记账。 */

/** 代码块语言归类（§3.2 单点真相，Overlays/mock 如需判定一律 import 这里）。
 * 刻意精确匹配 "math"——hljs 语境下 math 常指数学 XML，两者渲染结果不同（易错点 #12）。 */
export function classifyCodeLang(lang: string): "mermaid" | "math" | "code" {
  if (/^mermaid$/i.test(lang)) return "mermaid";
  if (/^math$/i.test(lang)) return "math";
  return "code";
}

const MATH_FENCE_RE = /^\s*\$\$\s*$/;

/** void 元素（HTML5 列表）：开放-延续判定要排除（`<br>` 永不等待闭标签）。 */
const VOID_TAGS = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

/** HTML 块级 token 流净化（第三档 audit 10.2）：标签逐个走行内白名单通道、文本段实体保留转义，
 *  **不做 DOM 平衡**——DOMParser 会把未闭合的 `<details>` 强行补闭、把孤立的 `</details>` 丢弃，
 *  跨块开合的容器（opener 一块、closer 一块、中间照常跑 Markdown）只有保持原样拼接才成立，
 *  这正是 cmark 直出 + GitHub 后置净化的实际形态。危险/未知标签逐个转义可见（tagfilter 向）。
 *  仅供「开放延续 / 孤立闭标签」两种边界块使用；自平衡块继续走 sanitizeHtml 的子树删除策略。 */
export function sanitizeBlockTokens(code: string): string {
  let res = "";
  let last = 0;
  const re = /<\/?[A-Za-z][A-Za-z0-9-]*(?:"[^"]*"|'[^']*'|[^<>"'`])*?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    res += escapeText(code.slice(last, m.index));
    const tok = sanitizeInlineTag(m[0]);
    res += tok ?? escapeText(m[0]);
    last = m.index + m[0].length;
  }
  res += escapeText(code.slice(last));
  return res;
}

/** 隐藏任务占位数 = 该段原文按 nextKind 状态机（=Rust line_kinds + task_parts）命中的 List 任务行数。
 *  第二档起改用状态机：段内 ``` 围栏开/闭会真实改变行的种类——与 Rust 在全文上跑的结果一致
 *  （旧正则会把围栏内的假 checkbox 也计入，序号错位）。 */
function taskMarksIn(code: string): string {
  const st = newKindState();
  let n = 0;
  for (const ln of code.split("\n")) {
    if (nextKind(ln, st) !== "list") continue;
    const j = afterListMarkerIdx(ln);
    if (j >= 0 && j + 2 < ln.length && ln[j] === "[" && ln[j + 2] === "]" && (ln[j + 1] === " " || ln[j + 1] === "x" || ln[j + 1] === "X")) n++;
  }
  return n ? '<span class="f-marks">' + '<span data-task="1" hidden></span>'.repeat(n) + "</span>" : "";
}

/* 公式/图表占位块（滚动同步方案 v1.2 §4.2 占位预估高度）：排版前高度≈0 会让首落整个错位、
 * 补偿层"稳定地保持错误"。按源码行数给 min-height 估算，f-ready/f-error 后由 CSS 归零；
 * 只影响首落体验，不影响最终精度（终局重放兜底）。lineAttrs=data-line-start/end 记账串。 */
function mathMinH(lines: number): string {
  return ` style="min-height:${Math.min(160, Math.max(48, (lines + 2) * 20))}px"`;
}
function mermaidMinH(lines: number): string {
  return ` style="min-height:${Math.min(300, Math.max(120, (lines + 2) * 40))}px"`;
}

function mathBlockHtml(lang: string, code: string, nested: boolean, lineAttrs: string): string {
  return `<div class="f-block" data-math="block" data-lang="${escapeHtml(lang)}" data-code="${escapeHtml(code)}"${lineAttrs}${mathMinH(code.split("\n").length)}>${nested ? "" : taskMarksIn(code)}</div>`;
}

function mermaidBlockHtml(code: string, lineAttrs: string): string {
  // 首行 `zenuml` 关键字的块走 @zenuml/core 原生通道（mermaid v11 上游已移除 zenuml 图类型，
  // 2026-11-16 需求方定夺原生支持；路由见 mermaidRender.ts / zenumlRender.ts）
  const zuml = /^\s*zenuml(\b|$)/m.test(code);
  return `<div class="f-block" data-mermaid="1"${zuml ? ' data-zuml="1"' : ""} data-lang="${zuml ? "zenuml" : "mermaid"}" data-code="${escapeHtml(code)}"${lineAttrs}${mermaidMinH(code.split("\n").length)}></div>`;
}

/** nested=true：引用块/提示块内的递归渲染——标题不占 data-sec 序号（Rust 的 outline 不认 "> # x"），
 *  任务项不生成 data-task/role=checkbox（Rust toggle_task 不认引用前缀行；CON-01/CON-02）。
 *  baseLine（滚动同步方案 v1.2 §4.1(a)）：本段第一行在原始文档中的绝对行号。"> " 前缀剥离逐行 1:1，
 *  递归传 baseLine 让引用/Callout 内子块也记**绝对**行号；行号记账与 data-sec/任务序号是两本账，互不污染。
 *  data-line-start/end（闭区间、0 起）是阅读窗滚动同步的块锚，纯前端记账：不进 Rust、不进导出。 */
function renderBlocks(src: string, defs: Defs, nested = false, baseLine = 0): string {
  const lines = splitSrcLines(src); // P2：裸 CR 也是行界（↔ Rust headings 的行号坐标系）
  // 文档顶层独享：front matter 区间 + 脚注注册表（↔ Rust line_kinds 的 front_matter_end 跳头）
  const docTop = !nested && baseLine === 0;
  const fmEnd = docTop ? frontMatterEnd(lines) : -1;
  if (docTop) FN = fnPrescan(lines, fmEnd >= 0 ? fmEnd + 1 : 0);
  // CommonMark 语义：链接定义全文预扫描（引用可以在定义之前出现）。围栏内的行不算定义
  // （第二档起走 nextKind：配对围栏，~~~ 同样屏蔽）；紧邻段落行之后的是懒延续正文，
  // 不构成定义（CC 4.7「定义不能打断段落」，第三档 audit 4.7-c——注册侧与渲染侧同门）。
  {
    const pre = newKindState();
    let wasPara = false; // 紧邻上一行是「真段落正文」（被段落吞掉的定义行也算段落行）
    for (let pi = fmEnd >= 0 ? fmEnd + 1 : 0; pi < lines.length; pi++) {
      const k = nextKind(lines[pi], pre);
      const inFenceK = k === "fo" || k === "fc" || k === "fi";
      const dp = inFenceK ? null : defParse(lines, pi);
      if (dp && !wasPara) {
        const key = normLabel(dp.label);
        if (!defs.has(key)) defs.set(key, { url: dp.url, title: dp.title });
        for (let u = 1; u < dp.used; u++) nextKind(lines[pi + u], pre); // 续行照喂状态机，不漏围栏/Setext 邻接
        pi += dp.used - 1;
        wasPara = false; // 成立的定义自成定义块，不铺开段落（连排定义继续成立）
      } else {
        wasPara = k === "para"; // 被段落吞掉的定义行（dp 存在但 wasPara 时）保持段落开着
      }
    }
  }
  const out: string[] = [];
  let i = 0;
  let secN = 0;
  const ks = newKindState(); // 行种类状态机：分支路由唯一权威（↔ Rust line_kinds）
  let runStart = -1;         // 连续 Para 行起点（Setext 空缓冲重建文本用，↔ Rust headings 的 para_run）
  /** 喂一行进状态机并同步 runStart——**每条原始行必须且只能经这里喂一次**（分支内消费的
   *  多行块要在消费处补喂），否则围栏配对/段落邻接判据与 Rust 脱钩。 */
  const feed = (ln: string, idx: number): LineKind => {
    const k = nextKind(ln, ks);
    runStart = k === "para" ? (runStart < 0 ? idx : runStart) : -1;
    return k;
  };
  /* 列表栈（2026-11-21 GFM P0 重构）：每个列表容器持有自己的 segs 与当前开项——
   * 子列表出栈时拼成完整字符串插回**父 <li> 的闭标签之前**（此前顶级 push，子 <ul> 成了
   * 父 <li> 的兄弟节点，HTML 非法：语义/可访问性/CSS 选择器/导出全受影响）。 */
  interface LiRef { arr: string[]; tagIdx: number; closeIdx: number }
  interface LEntry { type: "ul" | "ol";
    /** cmark 列模型（第六批 S3）：容器首标记列 / 最近一项内容列（续行、嵌套、闭合基准） */
    markerCol: number; contentCol: number;
    start: number; startNum: number; segs: string[]; openLi: LiRef | null;
    /** 层级序号链（需求 2026-11-22）：seq=最近一项序号（-1=未出项）；curDisp=该项显示串；
     *  prefix=本容器建栈时最近的有序祖先显示串（""=顶层观感，保留原生标记） */
    seq: number; curDisp: string; prefix: string;
    /** loose 判定（CC 5.4，第三档 audit 5.2-d）：列表内部出现过空行 → 出栈时给纯文本项包 <p> */
    loose: boolean; pendingBlank: boolean;
    /** 延续判据（第三档 audit 5.4-c/f）：无序=项目符号字符、有序=分隔符（. 或 )）；变化即开新列表 */
    marker: string }
  const listStack: LEntry[] = [];
  const curLi = (): LiRef | null => (listStack.length ? listStack[listStack.length - 1].openLi : null);
  let para: string[] = [];
  let paraStart = 0, paraEnd = 0;   // 显式记账：flushPara 输出时机总在消费之后，届时 i 已越前（二轮评审 2.6.2）
  let paraToLi = false;             // 本段是列表项的后续内容（延续/空行后正文），去向是 <li> 内部还是顶级
  let paraLazy = false;             // 紧项懒延续：并入首段而非另起 <p>（第六批 S8）
  let blank = false;                // 空行挂起标记：loose list 不在空行处急着关列表，看下一行再定（需求方 2026-11-17 缺陷）
  let lastListLine = -1;            // 列表当前产出的最后真实内容行（收容器时的 data-line-end 与 start 边界都取它）
  let lastContentEntry: LEntry | null = null; // 最后一块内容落到的容器（loose 归属判定，#319）

  /** 块锚属性串：起止绝对行号（闭区间） */
  const LA = (s: number, e: number) =>
    ` data-line-start="${baseLine + s}" data-line-end="${baseLine + Math.max(s, Math.min(e, lines.length - 1))}"`;

  /** 收列表：容器在出栈时才组装完整（开标签回填 start/块锚；顶级落 out，子级插回父 <li> 闭标签前）。
   *  父级 openLi 不清——子容器恰好拼进那个正开着的 <li>，父项的 loose 正文随后仍并进同一 <li>（语义更对）。 */
  const popList = (end: number) => {
    const l = listStack.pop()!;
    // loose 表：纯文本 <li> 正文包 <p>（CC 5.4，audit 5.2-d）。
    // 保护：任务项（<span class="cbx"）、已包好的 <p>、嵌套子表/块级内容都以 '<' 开头 → 不动，
    // 只包裸文本；故 `- *em*` 这类正文恰以标签起的 loose 项不包（保守漏包，绝不误伤 DOM）。
    if (l.loose) {
      for (let p = 0; p < l.segs.length; p++) {
        const tag = l.segs[p];
        if (tag.startsWith("<li")) {
          const inner = l.segs[p + 1];
          if (inner && inner.length > 0 && !inner.startsWith("<")) l.segs[p + 1] = `<p>${inner}</p>`;
        }
      }
    }
    const e = Math.max(l.start, end);
    // cmark 换行格式（第六批 S1）：行内文本之后紧跟块级子件（嵌套表/项内代码/loose 段）要一个换行——
    // canonical 语义比对把 "foo\n<ul" 折成文本 "foo "，缺换行的 "foo" 判不等（#294/#296 一族主因）。
    // segs 布局：["<li…>", inner, …块件…, "</li>"] ×N；纯块结构之间空白可折叠，无需补。
    const bodyParts: string[] = [];
    for (let p = 0; p < l.segs.length; p++) {
      const s = l.segs[p];
      if (!s.startsWith("<li")) { bodyParts.push(s); continue; }
      const inner = p + 1 < l.segs.length ? l.segs[p + 1] : "";
      let q = p + 2; // 块件从 inner 之后开始（此前把 inner 又当块件重复输出了一遍）
      const blocks: string[] = [];
      while (q < l.segs.length && l.segs[q] !== "</li>") { blocks.push(l.segs[q]); q++; }
      let li = s + inner;
      for (const b of blocks) li += (inner !== "" && !inner.startsWith("<") && b === blocks[0] ? "\n" : "") + b;
      if (blocks.length > 0) li += "\n";
      bodyParts.push(li + "</li>");
      p = q; // 跳过已消费的 "</li>"
    }
    const container =
      `<${l.type}${l.type === "ol" ? ` start="${l.startNum}"` : ""}${LA(l.start, e)}>` +
      bodyParts.join("") + (l.type === "ul" ? "</ul>" : "</ol>");
    const par = listStack[listStack.length - 1];
    if (par && par.openLi) { par.openLi.arr.splice(par.openLi.closeIdx, 0, container); par.openLi.closeIdx++; } // 子容器之后的块件排其后
    else if (par) par.segs.push(container);
    else out.push(container);
  };
  const closeLists = (end: number) => { while (listStack.length) popList(end); };
  /** 非列表内容出现处收表：空行挂起过则以最后内容行为界，否则以当前行前一行；顺带清挂起 */
  const closeListsHere = () => {
    if (listStack.length) closeLists(blank ? lastListLine : i - 1);
    blank = false;
  };
  const flushPara = () => {
    if (para.length) {
      // join("\n")：段内换行保留给行内公式扫描判「跨行 miss」；HTML 折叠空白，渲染结果与 join(" ") 相同
      // 纯图片段（需求补充：多个连续图片横向排列不换行）：整段只有 ![]() 语法 → imgrow 行。
      // 该特例与「段落内换行显示为换行」开关**完全无关**（需求 2026-11-23 定夺）：
      // 图片行恒横排、未超宽即连续显示，超宽由 inline-block 自然折行；下方拼接也避开 \n。
      const imgOnly = para.every((l) => IMG_LINE_RE.test(l.trim()));
      // cmark 6.8：段落末行行尾空白不进输出（P0-CM #226——影响 <br> 后文对齐）
      const ps = para.slice();
      if (ps.length) ps[ps.length - 1] = ps[ps.length - 1].replace(/[ \t]+$/, "");
      // 图片行用空格拼接：软换行开关打开时也不产生 <br>（imgrow 恒横排）
      const joined = imgOnly ? ps.join(" ") : ps.join("\n");
      const li = curLi();
      if (paraToLi && li) {
        // CommonMark loose/lazy 语义：列表项的后续正文并进该 <li>（此前作为游离 <p> 混进 <ol> 里）；
        // 行锚尾随正文扩到 paraEnd
        const owner = listStack.find((e) => e.segs === li.arr) ?? null;
        if (paraLazy) {
          // 紧项懒延续（S8/#291/292）：直接续到首段文本后，同段落、不包 <p>、不转 loose
          const cur = li.arr[li.tagIdx + 1];
          li.arr[li.tagIdx + 1] = (cur ? cur + "\n" : "") + renderInline(joined, defs);
        } else {
          if (blank && listStack.length) listStack[listStack.length - 1].loose = true; // 空行后的项内段落=loose 信号（audit 5.2-e）
          li.arr.splice(li.closeIdx, 0, (imgOnly ? '<p class="imgrow">' : "<p>") + renderInline(joined, defs) + "</p>");
          li.closeIdx++; // 文档顺序（第六批）
        }
        lastContentEntry = owner; // 空行归属：cmark 段落也是「最后一块内容」
        li.arr[li.tagIdx] = li.arr[li.tagIdx].replace(/data-line-end="\d+"/, `data-line-end="${baseLine + paraEnd}"`);
        if (paraEnd > lastListLine) lastListLine = paraEnd;
      } else {
        out.push((imgOnly ? `<p class="imgrow"${LA(paraStart, paraEnd)}>` : `<p${LA(paraStart, paraEnd)}>`) + renderInline(joined, defs) + "</p>");
      }
      para = [];
      paraToLi = false;
      paraLazy = false;
    }
  };
  const inline = (s: string) => renderInline(s, defs);
  /** ATX / Setext 两种标题共用出口；引用块内标题不占 data-sec 序号（CON-02 口径不变）。
   *  inItem=true（第三档 audit 5.2-c）：缩进到列表项内容列的标题**并进当前 <li>**、列表不断开
   *  （CC 5.2「项内容列的块级结构属于该项」；顶格标题仍走关闭列表的老路）。 */
  const emitHeading = (lv: number, text: string, sLine: number, eLine: number, inItem = false) => {
    flushPara();
    let html: string;
    if (nested) {
      // 引用块/提示块内的标题：照常渲染成标题元素，但绝不占用 data-sec 序号、不产出 id——
      // Rust headings() 按原始行判定（"> # x" 不是标题），两侧必须同坐标系（CON-02）
      html = `<h${lv}${LA(sLine, eLine)}>${inline(text)}</h${lv}>`;
    } else {
      secN++;
      html = `<h${lv} id="sec-${secN}" data-sec="${secN}" data-sec-text="${escapeHtml(text)}"${LA(sLine, eLine)}>${inline(text)}</h${lv}>`;
    }
    if (inItem) { emitBlock(html, sLine, eLine); return; }
    closeListsHere();
    out.push(html);
  };
  /** 围栏/缩进代码共用的代码块壳；<pre> 子锚只记内容行（不含围栏行），行→像素映射以它为精（方案 §4.1(a)） */
  const codeblockHtml = (code: string, lang: string, s: number, e: number, preS: number, preE: number) =>
    `<div class="codeblock"${LA(s, e)}><div class="cbh"><span class="lang">${escapeHtml(lang)}</span><span class="sp"></span>` +
    `<button class="cb-copy" type="button" title="${escapeHtml(RO.copyCodeTitle)}"${langAttr()}><svg class="ico ico-14"><use href="#i-copy"/></svg>${escapeHtml(RO.copyCode)}</button></div>` +
    `<pre${LA(preS, preE)}><code class="language-${escapeHtml(lang.toLowerCase())}">${escapeHtml(code)}</code></pre></div>`;
  /** 正文/懒延续/项内段落行积累（原循环尾部抽提；含 GFM 6.12 硬换行标记） */
  const accumulate = (line: string) => {
    if (!para.length) {
      paraStart = i;
      // 列模型（第六批 S3）：空行后缩进不足项内容列的行才关闭列表（旧 /^ {2,}/ 近似作废）
      if (blank && listStack.length && indentCol(line) < listStack[listStack.length - 1].contentCol) closeListsHere();
      paraToLi = listStack.length > 0;
      // S8 紧项懒延续：无空行紧贴标记行 → 并入该项首段（同段落、不包 <p>，#291/292/312 形态）
      paraLazy = paraToLi && !blank && curLi() != null && lastListLine === i - 1;
    }
    paraEnd = i;
    if (listStack.length && i > lastListLine) lastListLine = i;
    // CommonMark 6.7 硬换行（2026-11-22 P0-CM）：块层保留行原文（只剥行首缩进、**保留行尾空白/反斜杠**），
    // ≥2 空格或行尾 `\` 的 <br> 判定挪进内联叶子（emitTextLeaf）——
    // 代码段/HTML 属性里的行尾空格不再被控制符替换（#640-643），段末反斜杠不再丢字符（#644）。
    para.push(line.replace(/^[ \t]+/, ""));
    i++;
  };
  /** loose 项内块级内容（第六批列模型：缩进 ≥ 当前容器内容列的围栏/$$/引用块）：并进当前 <li>，列表不断掉 */
  const itemBlock = (line: string) =>
    listStack.length > 0 && curLi() != null && indentCol(line) >= listStack[listStack.length - 1].contentCol;
  const emitBlock = (t: string, sLine: number, eLine: number) => {
    const li = curLi();
    if (listStack.length && li) {
      // 空行后还有内容进这一项 → 该容器转 loose（#263/264：fence/代码/引用等吸收也算项内第二块）
      if (blank) listStack[listStack.length - 1].loose = true;
      lastContentEntry = listStack[listStack.length - 1];
      li.arr.splice(li.closeIdx, 0, t); // 文档顺序插入（第六批：头插会把同项多块的顺序倒置）
      li.closeIdx++;
      li.arr[li.tagIdx] = li.arr[li.tagIdx].replace(/data-line-end="\d+"/, `data-line-end="${baseLine + eLine}"`);
      if (eLine > lastListLine) lastListLine = eLine;
      void sLine;
    } else out.push(t);
  };

  while (i < lines.length) {
    const line = lines[i];
    if (fmEnd >= 0 && i === 0) {
      // YAML front matter：元数据卡片直出（键值行两列排，其余原样），区内行不喂状态机
      //——与 Rust line_kinds 跳过头部区完全同构
      const rows = lines.slice(1, fmEnd).map((l) => {
        const kv = /^([^:#\s][^:]*):(?:[ \t]+(.*?))?[ \t]*$/.exec(l);
        return kv && !/^[ \t]/.test(l)
          ? `<div class="fmr"><span class="fmk">${escapeHtml(kv[1].trim())}</span><span class="fmv">${escapeHtml((kv[2] ?? "").trim())}</span></div>`
          : `<div class="fmp">${escapeHtml(l)}</div>`;
      });
      out.push(`<div class="frontmatter"${LA(0, fmEnd)}><div class="fmh"${langAttr()}>${escapeHtml(RO.frontmatter)}</div>${rows.join("")}</div>`);
      i = fmEnd + 1;
      continue;
    }
    const kind = feed(line, i); // 行种类=路由权威；分支顺序与 Rust line_kinds 一致
    if (docTop && FN && FN.starts.has(i)) {
      // 脚注定义块：不内联渲染；行照常喂状态机（Rust 视角它们是段落/项内容行），
      // 块内真任务的隐藏 data-task 占位打在定义位置（与 $$ 块同方案，勾选坐标系不漂）
      const info = FN.starts.get(i)!;
      flushPara();
      closeListsHere();
      const raw = lines.slice(i, info.end + 1).join("\n");
      for (let q = i + 1; q <= info.end; q++) feed(lines[q], q);
      out.push(taskMarksIn(raw));
      i = info.end + 1;
      continue;
    }
    if (kind === "fo") {
      // 围栏（第二档配对）：``` 与 ~~~ 都认，闭栏=同字符且长度 ≥ 开栏；未闭合吃到 EOF（旧策略保留）
      flushPara();
      const inItemF = itemBlock(line);
      if (!inItemF) closeListsHere(); else blank = false;
      const f0 = i;
      const lang = fenceInfo(line) || "text";
      const fInd = indentWidth(line); // CC 4.5（第五批）：内容行按开栏缩进 dedent（#131-133）
      i++;
      const buf: string[] = [];
      while (i < lines.length) {
        const k2 = feed(lines[i], i);
        if (k2 === "fc") break;
        buf.push(fInd > 0 ? stripIndentCols(lines[i], fInd) : lines[i]);
        i++;
      }
      const fEnd = i < lines.length ? i : lines.length - 1; // 闭围栏所在行；未闭合吃到 EOF
      const code = buf.join("\n");
      const ckk = classifyCodeLang(lang);
      if (ckk === "math") {
        emitBlock(mathBlockHtml("math", code, nested, LA(f0, fEnd)), f0, fEnd);
      } else if (ckk === "mermaid") {
        emitBlock(mermaidBlockHtml(code, LA(f0, fEnd)), f0, fEnd);
      } else {
        emitBlock(codeblockHtml(code, lang, f0, fEnd, Math.min(f0 + 1, fEnd), Math.max(f0 + 1, fEnd - 1)), f0, fEnd);
      }
      if (i < lines.length) i++; // 吃掉闭栏行（其种类已在上面 feed 为 fc）
      continue;
    }
    if (kind === "code") {
      // 顶层缩进代码（第二档）：≥4 列且上承不是段落/列表（≥4 列的段落懒延续/项内容
      // 已在 nextKind 三分流里转成 para/head/list，不会走到这里）。
      // run 吸收内部空行——判据是"下一非空行仍 ≥4 列"（↔ Rust prev==Code 续行）。
      flushPara();
      closeListsHere();
      const c0 = i;
      const buf: string[] = [stripIndentCol4(line)];
      i++;
      for (;;) {
        let p = i;
        while (p < lines.length && /^\s*$/.test(lines[p])) p++;
        if (p >= lines.length || indentCol(lines[p]) < 4) break;
        for (; i < p; i++) buf.push(""); // run 内空行照收（逐行 1:1，data-line-end 不错位）
        buf.push(stripIndentCol4(lines[i]));
        feed(lines[i], i);
        i++;
      }
      while (buf.length > 1 && buf[buf.length - 1] === "") buf.pop(); // 尾随空行不占块范围
      const cEnd = c0 + buf.length - 1;
      out.push(codeblockHtml(buf.join("\n"), "text", c0, cEnd, c0, cEnd));
      continue;
    }
    if (MATH_FENCE_RE.test(line)) {
      // $$…$$ 成块（易错点 #1/#2：行首行尾只含 $$ 才算界行；`a = $$x` 这类内嵌写法不进块态机）
      flushPara();
      if (!itemBlock(line)) closeListsHere(); else blank = false;
      const d0 = i;
      i++;
      const buf: string[] = [];
      while (i < lines.length && !MATH_FENCE_RE.test(lines[i])) {
        const k2 = feed(lines[i], i); // Rust 不认 $$：体内行按全文同一状态机记账
        if (!nested && (k2 === "head" || k2 === "setext")) secN++; // 记账：Rust 把 $$ 内的 "# " 也计标题
        buf.push(lines[i]);
        i++;
      }
      const dEnd = i < lines.length ? i : lines.length - 1; // 闭界行（未闭合到 EOF）
      // 未闭合的 $$ 吃到 EOF（与 ``` 未闭合同策略）；空块 → data-code="" 由 mathjax.ts 走退化分支
      emitBlock(mathBlockHtml("tex", buf.join("\n"), nested, LA(d0, dEnd)), d0, dEnd);
      if (i < lines.length) { feed(lines[i], i); i++; } // 闭界行也喂状态机（Rust 视角它是段落行）
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();      // 项内延续正文到此为止（并进 <li>）
      blank = true;     // 不关列表：下一行若仍是列表项 → 同一 <ol> 继续（loose list）；若否 → 各分支经 closeListsHere 以内容行收口
      // 注意：cmark 不按「连续两个空行」关列表（#262/#306 实证）——空行数只影响 loose，边界由列匹配裁决
      i++;
      continue;
    }
    if (kind === "para" && listStack.length > 0 && curLi() != null && para.length === 0 &&
        indentCol(line) >= listStack[listStack.length - 1].contentCol + 4) {
      // S4（第六批）：比项内容列再深 ≥4 列、且非标记/ATX（kind 已排除）、无在积段落 → 项内缩进代码
      //（#254/264/270/286-290 族）。行仍逐行 feed 状态机——kind 是懒 Para，不占标题/任务序号，坐标不动。
      const cc = listStack[listStack.length - 1].contentCol;
      const c0 = i;
      const buf: string[] = [stripIndentCols(line, cc)];
      i++;
      for (;;) {
        let p = i;
        while (p < lines.length && /^\s*$/.test(lines[p])) p++;
        const raw2 = p < lines.length ? lines[p] : undefined;
        if (raw2 === undefined || indentCol(raw2) < cc + 4 || raw2.trimStart()[0] === "#" ||
            afterListMarkerIdx(raw2) >= 0 || fenceOpen(raw2) !== null || /^<[!?/A-Za-z]/.test(raw2.trimStart())) break;
        for (; i < p; i++) buf.push("");
        buf.push(stripIndentCols(lines[i], cc));
        feed(lines[i], i);
        i++;
      }
      while (buf.length > 1 && buf[buf.length - 1] === "") buf.pop();
      const cEnd = c0 + buf.length - 1;
      emitBlock(codeblockHtml(buf.join("\n"), "text", c0, cEnd, c0, cEnd), c0, cEnd);
      blank = false;
      continue;
    }
    const dp = para.length ? null : defParse(lines, i);
    if (dp) {
      // 段落开着时定义行不成立（CC 4.7，第三档 audit 4.7-c）：落到下面的正文积累；
      // 成立时可占 1~3 行（4.7-a 目标/标题换行），续行必须同步喂状态机不漏记账。
      flushPara();
      closeListsHere();
      const key = normLabel(dp.label);
      if (!defs.has(key)) defs.set(key, { url: dp.url, title: dp.title });
      for (let u = 1; u < dp.used; u++) feed(lines[i + u], i + u);
      i += dp.used;
      continue;
    }
    if (isHtmlBlockStart(line)) {
      // 内嵌原始 HTML（需求：README 的徽章/居中块直接生效），第三档按 CC 4.6 分终止模式：
      //  - 类型 2 注释 `<!--`：吃到含 `-->` 的行（空行不算界，audit 4.6-b）；
      //  - 类型 3/5 声明 `<!`/`<?`：吃到含 `>` 的行；正文经 DOMParser 会把声明当噪声丢，
      //    故「起始声明段」原文直出（惰性无害），`>` 之后若有残留走净化（audit 4.6-a）；
      //  - 类型 1 `<script|pre|style|textarea`：吃到对应闭标签行（空行不算界）；svg 同走该模式（产品 2026-11-20 解禁，单行/多行 SVG 都按整块净化）；
      //  - 其余（类型 6/7 标签块）：吃到空行（简化保留——类型 6 的规范终止本就是空行）。
      // 块内 HTML 不跑 markdown 内联解析（GFM 同规则）；坐标记账同 $$：块内行照喂状态机，
      // 标题/任务按 Rust 口径计入（块内 ``` 围栏两侧同步生效）。
      flushPara();
      closeListsHere();
      const hb0 = i;
      const cmtMode = /^ {0,3}<!--/.test(line);
      const declMode = !cmtMode && /^ {0,3}<[!?]/.test(line);
      const t1 = !cmtMode && !declMode ? /^ {0,3}<(script|pre|style|textarea|svg)(?![\w-])/i.exec(line) : null;
      let done = cmtMode ? line.includes("-->") : declMode ? line.includes(">") : false;
      if (t1) { const endTag = new RegExp("</" + t1[1] + ">", "i"); done = endTag.test(line); }
      const buf: string[] = [line]; // 本行已在循环顶 feed 过，不再重复
      i++;
      const blankEnd = !cmtMode && !declMode && !t1; // 只有类型 6/7 以空行收块
      while (i < lines.length && !done) {
        const ln = lines[i];
        if (blankEnd && /^\s*$/.test(ln)) break; // 空行留给 blank 分支处理（不喂两次）
        const k2 = feed(ln, i);
        if (!nested && (k2 === "head" || k2 === "setext")) secN++;
        buf.push(ln);
        i++;
        if (cmtMode) done = ln.includes("-->");
        else if (declMode) done = ln.includes(">");
        else if (t1) done = new RegExp("</" + t1[1] + ">", "i").test(ln);
      }
      const code = buf.join("\n");
      // HTML 注释块（CC 4.6 类型 2）：注释不产生可见输出（GFM 同口径；此前整块转义成可见文本属缺陷，
      // 且与行内注释的"吞掉"行为不一致）。块内真任务仍要占位——Rust 行种类对块内行照常计数，
      // 隐藏 data-task 占位保 taskOrdinalOf 对位（与 $$ 块同方案）；块内行照常 feed（坐标记账）。
      if (cmtMode) {
        out.push(nested ? "" : taskMarksIn(code));
        continue;
      }
      // 跨块容器边界（第三档 audit 10.2）：opener 块内没有同名闭标签 → 裸片段直出（块锚挂首标签），
      // 后续块/正文按普通 Markdown 解析，最后由孤立闭标签块收口——三段拼接后由浏览器完成嵌套。
      if (!cmtMode && !declMode && !t1) {
        const om = /^ {0,3}<([A-Za-z][A-Za-z0-9-]*)([^<>]*)>/.exec(line);
        if (om && isAllowedTag(om[1]) && !VOID_TAGS.test(om[1]) && !/\/\s*$/.test(om[2])
          && !new RegExp("</" + om[1] + "[\\s>]", "i").test(code)) {
          let frag = sanitizeBlockTokens(code);
          const fm = /<[A-Za-z][A-Za-z0-9-]*(?=[\s>])/.exec(frag);
          if (fm) frag = frag.slice(0, fm.index + fm[0].length) + LA(hb0, i - 1) + frag.slice(fm.index + fm[0].length);
          out.push(frag + (nested ? "" : taskMarksIn(code)));
          continue;
        }
        const cm = /^ {0,3}<\/([A-Za-z][A-Za-z0-9-]*)[^<>]*>[ \t]*$/.exec(code);
        if (cm && isAllowedTag(cm[1])) { out.push(`</${cm[1].toLowerCase()}>`); continue; }
      }
      let rendered: string;
      if (declMode && /^ {0,3}<[!?][^<>]*>/.test(code)) {
        const gt = code.indexOf(">");
        rendered = code.slice(0, gt + 1) + (gt + 1 < code.length ? sanitizeHtml(code.slice(gt + 1)) : "");
      } else rendered = sanitizeHtml(code);
      // rawblk 包裹层承载块锚（净化输出可能多元素平铺，无单一根可标）；print 分页选择器组已含 .rawblk
      out.push(`<div class="rawblk"${LA(hb0, i - 1)}>${rendered}${nested ? "" : taskMarksIn(code)}</div>`);
      continue;
    }
    if (kind === "setext") {
      // Setext 标题（第二档）：下划线行贴紧邻段落（空行断开→走 hr 分支），=→h1、-→h2。
      // 坐标 ↔ Rust headings()：标题实体落在**段落首行**（data-line-start=para_run 起点）、secN 在此占用。
      // 段落缓冲为空的兜底（$$ 闭界行/表格行等按 Rust 都是 para 行）：用 runStart 重建文本，两侧同值。
      const lv = line.trim()[0] === "=" ? 1 : 2;
      let text: string;
      let s0: number;
      if (para.length) {
        const ps = para.slice();
        para = [];
        paraToLi = false;
        s0 = paraStart;
        text = ps.join(" ").replace(BR_RE, "").trim();
      } else {
        s0 = runStart >= 0 ? runStart : Math.max(0, i - 1);
        text = lines.slice(s0, i).join(" ").trim();
      }
      emitHeading(lv, text, s0, i);
      i++;
      continue;
    }
    if (kind === "head") {
      const h = headingMatch(line);
      if (h) {
        // 项内容列（缩进 ≥2）的 ATX：标题落进当前 <li>（第三档 audit 5.2-c）；顶格/浅缩进走老路关列表
        const inItem = listStack.length > 0 && curLi() != null && indentCol(line) >= 2;
        emitHeading(h.level, h.text, i, i, inItem);
        i++;
        continue;
      }
      // "#tag" 这类以 # 开场的行：kinds 记 Head 但不产出大纲条目（Rust 同）——落到常规分支当正文
    }
    if (kind === "hr") {
      // 分隔线（第二档起认 "- - -" / "* * *" 变体，判据在 nextKind/isHrLine 内）
      flushPara();
      closeListsHere();
      out.push(`<hr${LA(i, i)}>`);
      i++;
      continue;
    }
    if (
      /\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]*-[\s|:-]*$/.test(lines[i + 1]) &&
      /-/.test(lines[i + 1])
    ) {
      // GFM 4.10 列数门槛（2026-11-21 P0）：表头与分隔行单元数必须一致，否则**不构成表格**——
      // 整组行退回段落积累（flushPara 移到校验成功之后，此前会把待积累的首行提前冲掉）。
      const tHdr = splitRow(line);
      const tDelim = splitRow(lines[i + 1]);
      if (tHdr.length !== tDelim.length) {
        // 列数不符：本行按普通行进段落积累，下一轮分隔行会走它自己的分支（成段/列表等）
        if (!para.length) paraStart = i;
        paraEnd = i;
        para.push(line.trim());
        i++;
        continue;
      }
      flushPara();
      // 第三档 audit 5.2-h：缩进到项内容列（≥2）的表格属于当前 <li>，与项内标题同路
      const inItemTbl = listStack.length > 0 && curLi() != null && indentCol(line) >= 2;
      if (inItemTbl) blank = false; else closeListsHere();
      const t0 = i;
      const header = tHdr;
      // GFM 对齐（需求方 2026-11-21：|:---:| 居中要生效）：分隔行 `:---`=左、`---:`=右、`:---:`=中。
      // 输出走单元格的 inline style——作者 CSS `.prose thead th{text-align:left}` 会盖掉 align 属性的
      // 呈现性提示，只有 inline 样式能赢；无冒号列不输出样式（保持默认左对齐）。列数超出对齐表时不越界。
      const aligns = splitRow(lines[i + 1]).map(cellAlign);
      const al = (k: number) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : "");
      feed(lines[i + 1], i + 1); // 分隔行也是被消费的行（Rust 视角是段落行）——状态机不可漏喂
      i += 2;
      // GFM 表格体终止（2026-11-21 P0）：空行、不含未转义竖线的行、以及块级结构起点（ATX/引用/围栏/hr/列表项）
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i]) && !TABLE_STOP.test(lines[i])) {
        feed(lines[i], i);
        rows.push(splitRow(lines[i]));
        i++;
      }
      // 单元格行内渲染：<br> 系换行自 2026-11-21 起由 renderInline 的行内 HTML 通道统一放行
      //（含 <kbd>/<sup> 等白名单标签，属性净化同块级口径）；其余 HTML 依旧转义，净化面不扩大。
      const cell = (s: string) => inline(s);
      // 表体行与源行逐行 1:1（表头 t0、分隔行 t0+1、第 k 数据行 t0+2+k）；tr 子锚（方案 §4.1(a)）
      const colN = header.length;
      let t = `<div class="tw-tbl"${LA(t0, Math.max(t0 + 1 + rows.length, t0))}><table><thead><tr${LA(t0, t0)}>`;
      header.forEach((c, k) => (t += "<th" + al(k) + ">" + cell(c) + "</th>"));
      t += "</tr></thead>";
      if (rows.length) {
        t += "<tbody>";
        rows.forEach((r, k) => {
          t += `<tr${LA(t0 + 2 + k, t0 + 2 + k)}>`;
          for (let j = 0; j < colN; j++) {
            // 缺列补空单元、多列截断（GFM：数据行对齐表头列数）
            t += "<td" + al(j) + ">" + cell(r[j] ?? "") + "</td>";
          }
          t += "</tr>";
        });
        t += "</tbody>";
      }
      t += "</table></div>";
      if (inItemTbl) emitBlock(t, t0, Math.max(t0 + 1 + rows.length, t0));
      else out.push(t);
      continue;
    }
    if (kind === "quote") {
      // 引用块（第二档起按行种类触发：≥4 列的 "> x" 在 Rust 是缩进代码/懒延续，不再是引用）
      flushPara();
      if (!itemBlock(line)) closeListsHere(); else blank = false;
      const q0 = i;
      const buf: string[] = [lines[i].replace(/^\s*>\s?/, "")]; // 顶行已 feed，循环从下一行起
      i++;
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        feed(lines[i], i); // 每个原始引用行都要喂（"> ```" 以 > 开场→Quote，不开围栏——与 Rust 同）
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      // CommonMark 6.4 懒延续（第二档 P1）：后续行按全文状态机仍判 Para（不是块起点、
      // 不是列表/标题/围栏行）→ 并入引用。Rust 视角这些行也是段落行，坐标不动。
      for (;;) {
        if (i >= lines.length || /^\s*$/.test(lines[i])) break;
        const shadow = nextKind(lines[i], { fence: null, prev: ks.prev, adjPar: ks.adjPar });
        if (shadow !== "para") break;
        feed(lines[i], i);
        buf.push(lines[i]);
        i++;
      }
      // 引用行逐行 1:1：整块范围 [q0, i-1]；Callout 正文从第二行起（首行是 [!TYPE] 标记行）
      const co = parseCallout(buf, defs, true, LA(q0, i - 1), baseLine + q0 + 1);
      emitBlock(co ?? `<blockquote${LA(q0, i - 1)}>` + renderBlocks(buf.join("\n"), defs, true, baseLine + q0) + "</blockquote>", q0, i - 1);
      continue;
    }
    // 空列表项（第三档 audit 5.2-b）：标记后内容可缺省，`-` 独占一行 = 空项
    const li = kind === "list" ? line.match(/^(\s*)([-*+]|\d+[.)])(?:[ \t]+(.*))?$/) : null;
    if (li) {
      flushPara();
      const type = /[-*+]/.test(li[2]) ? "ul" : "ol";
      // 延续判据（第三档 audit 5.4-c/f）：无序=项目符号字符，有序=分隔符（. 或 )）；
      // 同类型但符号/分隔符变化 → 收容器开新表（CC 5.4 例 246/248）
      const markChar = type === "ul" ? li[2] : li[2].slice(-1);
      const markerCol = indentWidth(li[1]);                       // S3：列模型——标记起始列
      const mEnd = markerCol + li[2].length;                      // 标记本体右边界（标记全 ASCII，字符数=列宽；indentWidth 只数空白，误用致内容列少算）
      const afterMarker = line.slice(li[1].length + li[2].length);
      const spAfter = /^[ \t]*/.exec(afterMarker)![0];
      const hasContent = afterMarker.length > spAfter.length;
      // 内容列（cmark）：标记后 1~4 空格→列=边界+空格数；≥5 空格→列=边界+1（多余空格归内容）；空项→边界+1
      const contentCol = !hasContent || indentCol(spAfter) >= 5 ? mEnd + 1 : mEnd + indentCol(spAfter);
      // 源编号=start 双保险：CommonMark 只有首项编号有意义；即便列表被标题/类型切换真实切断，
      // 新容器也从作者写的编号起算——"4. xxx" 永远不会再显示成 "1."（需求方 2026-11-17 缺陷）
      const startNum = type === "ol" ? (Number.isNaN(parseInt(li[2], 10)) ? 1 : parseInt(li[2], 10)) : 1; // 0 是合法起始值（#267，旧 ||1 把它吞成 1）
      let text = li[3] ?? ""; // 空列表项：标记后无内容
      let task: boolean | null = null;
      // \s* 而非 \s+：Rust task_parts 只认 "[x]"/"[ ]" 本身，不强制 ] 后空白（如 "- [ ]x"）。
      // 这里若比 Rust 严格，该行不进序号坐标系，后续任务全部错一位（同 CON-01 的坑）。
      const tm = text.match(/^\[( |x|X)\]\s*(.*)$/);
      if (tm) {
        task = tm[1].toLowerCase() === "x";
        text = tm[2];
      }
      const afterBlank = blank; // 本项前是否隔着空行（loose 判据，audit 5.2-d）
      blank = false;   // 空行后的列表项：同一列表继续（loose list 正是此前编号恒 1 的成因）
      // cmark 列匹配（第六批 S3）：先关「首标记列比本行更靠右」的深层容器；再按列位分派——
      //  m ≥ 内容列 → 子容器嵌套；m ∈ [容器列, 容器列+4) → 同容器兄弟项；
      //  m ∈ [容器列+4, 内容列) → 越界低列：CC 判为**当前项懒延续文本**（#312 尾项形态）；
      //  类型/符号不同 → 收旧开新表（5.4-c/f 口径）。
      while (listStack.length && markerCol < listStack[listStack.length - 1].markerCol) popList(lastListLine);
      let cont: LEntry | undefined = listStack[listStack.length - 1];
      let asLazyText = false;
      if (cont) {
        if (markerCol >= cont.contentCol) cont = undefined;                 // 更深 → push 子容器
        else if (markerCol >= cont.markerCol + 4) asLazyText = true;        // 越界且未及内容列
        else if (cont.type !== type || cont.marker !== markChar) { popList(lastListLine); cont = undefined; }
        else cont.contentCol = contentCol;                                  // 兄弟项：内容列随本项刷新
      }
      // <li> 三段式输出（开标签/正文/闭标签）：落在**当前列表自己的 segs**里，
      // loose 延续正文与子容器都插到闭标签前；行锚尾随正文扩到末行
      const pushLi = (attrs: string, inner: string) => {
        const l = listStack[listStack.length - 1];
        // 层级序号（需求 2026-11-22）：有序容器按 startNum+顺延计 seq；
        // 挂在已编号祖先之下时给该项拼显示串 "父.子"，--mnr 交给 CSS ::marker。
        // 顶层（prefix=""）不挂属性——保持原生标记零回归；纯文本编号只影响显示，源码与坐标系不动。
        let mnr = "";
        if (l.type === "ol") {
          l.seq = l.seq < 0 ? l.startNum : l.seq + 1;
          l.curDisp = l.prefix ? `${l.prefix}.${l.seq}` : String(l.seq);
          if (l.prefix) mnr = ` style="--mnr:'${l.curDisp}. '"`;
        }
        const arr = l.segs;
        const tagIdx = arr.length;
        arr.push(`<li${attrs}${mnr}>`);
        arr.push(inner);
        arr.push("</li>");
        l.openLi = { arr, tagIdx, closeIdx: tagIdx + 2 };
        lastContentEntry = l;
      };
      if (asLazyText) {
        accumulate(line); // 越界标记行按普通文本走段落/懒延续通道
        continue;
      }
      if (!cont) {
        // 前缀取最近的有序祖先（中间的无序列表不占号段，需求口径"更深层级依此类推"）
        let prefix = "";
        for (let z = listStack.length - 1; z >= 0; z--) {
          const p = listStack[z];
          if (p.type === "ol" && p.curDisp !== "") { prefix = p.curDisp; break; }
        }
        listStack.push({ type, markerCol, contentCol, start: i, startNum, segs: [], openLi: null, loose: false, pendingBlank: false, marker: markChar, seq: -1, curDisp: "", prefix });
      }
      // 空行分开的兄弟项 → 当前容器整表转 loose（CC 5.4：一项 loose 全表 loose）。
      // 归属判定（#319）：空行只染「空行前最后一块内容所在的容器」——空行若发生在嵌套子表
      // 内部，外层兄弟项不因这个空行转 loose。lastContentEntry 在 pushLi/emitBlock/项内段落
      // 三处更新；只有目标容器与其同一实例才转 loose。
      if (afterBlank && listStack[listStack.length - 1] === lastContentEntry) {
        listStack[listStack.length - 1].loose = true;
      }
      // CC 4.7（第三档 audit 4.7-f）：链接引用定义可以就是列表项内容——注册进 defs，项体为空
      const idf = defParse([text], 0);
      if (idf) {
        const key = normLabel(idf.label);
        if (!defs.has(key)) defs.set(key, { url: idf.url, title: idf.title });
        pushLi(LA(i, i), "");
        lastListLine = i;
        i++;
        continue;
      }
      if (task === null && text) {
        // S5（第六批）：标记后同行块级内容——ATX 标题/hr（#300、#61）。kind 仍是 List
        //（Rust 不计标题/任务）→ 出块但**不占 data-sec**，两侧序号一致。
        const hh = headingMatch(text);
        if (hh && /^#{1,6}(\s|$)/.test(text)) {
          pushLi(LA(i, i), `<h${hh.level}${LA(i, i)}>${inline(hh.text)}</h${hh.level}>`);
          lastListLine = i; i++; continue;
        }
        if (isHrLine(text.trim())) {
          pushLi(LA(i, i), `<hr${LA(i, i)}>`);
          lastListLine = i; i++; continue;
        }
        // S6：标记后紧跟另一标记（`- - foo`/`1. - 2. foo`，#298/299）→ 同行嵌套列表逐层剥
        const nm = /^([-*+]|\d+[.)])(?:[ \t]+([\s\S]*))?$/.exec(text);
        if (nm) {
          const chain: Array<{ t: "ul" | "ol"; n: number }> = [];
          let rem = text;
          for (;;) {
            const g = /^([-*+]|\d+[.)])(?:[ \t]+([\s\S]*))?$/.exec(rem);
            if (!g) break;
            const t = /[-*+]/.test(g[1]) ? "ul" as const : "ol" as const;
            chain.push({ t, n: t === "ol" ? (parseInt(g[1], 10) || 1) : 1 });
            rem = g[2] ?? "";
          }
          if (chain.length > 0) {
            let inner = inline(rem);
            for (let z = chain.length - 1; z >= 0; z--) {
              const { t, n } = chain[z];
              inner = `<${t}${t === "ol" && n !== 1 ? ` start="${n}"` : ""}${LA(i, i)}><li${LA(i, i)}>${inner}</li></${t}>`;
            }
            pushLi(LA(i, i), inner);
            lastListLine = i; i++; continue;
          }
        }
      }
      if (task !== null) {
        const cbx = (clickable: boolean, t: boolean) =>
          `<span class="cbx${t ? " done" : ""}"` + langAttr() +
          (clickable
            ? ` role="checkbox" tabindex="0" aria-checked="${t}" title="${escapeHtml(RO.taskToggle)}"`
            : ` aria-hidden="true" title="${escapeHtml(RO.taskNestedDisabled)}"`) +
          `><svg class="ico ico-12"><use href="#i-check"/></svg></span>`;
        if (nested) {
          // 引用块/提示块内的任务：只显示不可勾选（Rust toggle_task 不认引用前缀行，
          // 若给出可点击复选框会按错误序号改写别的行——静默损坏源文件，CON-01）
          pushLi(` class="${task ? "done" : "task"}"${LA(i, i)}`, cbx(false, task) + `<span class="tline">${inline(text)}</span>`);
        } else {
          pushLi(` class="${task ? "done" : "task"}"${LA(i, i)} data-task="1"`, cbx(true, task) + `<span class="tline">${inline(text)}</span>`);
        }
      } else {
        pushLi(LA(i, i), inline(text));
      }
      lastListLine = i;
      i++;
      continue;
    }
    accumulate(line); // 正文积累（段落/懒延续/项内 loose 续行；含硬换行标记）
  }
  flushPara();
  if (listStack.length) closeLists(blank ? lastListLine : Math.max(lastListLine, lines.length - 1));
  if (docTop && FN && FN.num.size) {
    // 脚注汇总节（GitHub 样式）：只列被引用的定义、按首次引用编号；体内嵌渲染不占 data-sec，
    // 任务不可勾选——可勾选序号的坐标系占位已打在正文里定义块的位置（与 $$ 隐藏占位同方案）。
    const f = FN;
    const labels = [...f.defs.keys()].filter((l) => f.num.has(l)).sort((a, b) => f.num.get(a)! - f.num.get(b)!);
    let s = `<div class="footnotes" role="doc-endnotes"><hr><div class="fn-title"${langAttr()}>${escapeHtml(RO.footnotes)}</div><ol>`;
    for (const l of labels) {
      const n = f.num.get(l)!;
      // 回跳 ↩ 与正文同行（需求 2026-11-23）：插进最后一段的 </p> 之前（追加在 <p> 之后会被块级换行）；
      // 末块非段落（列表/代码等）时退回末尾追加。
      const fnInner = renderBlocks(f.defs.get(l)!.join("\n"), defs, true, 0);
      const fnBack = `<a class="fnback" href="#fnref-${n}" title="${escapeHtml(RO.footnoteBack)}">↩</a>`;
      const fnWithBack = /<\/p>\s*$/.test(fnInner) ? fnInner.replace(/<\/p>\s*$/, `${fnBack}</p>`) : fnInner + fnBack;
      s += `<li id="fn-${n}">${fnWithBack}</li>`;
    }
    out.push(s + "</ol></div>");
  }
  if (docTop) FN = null; // 文档级状态释放（同步渲染，不交叠）
  return out.join("\n");
}

/** 主渲染入口。opts=渲染 chrome 文案（P4b，设计 §4.6.1）：不传时用 zh-CN 源语言默认值，
 *  tests/unit/md.test.ts 等纯函数用例零影响；Reader 传当前 locale 的 RenderOptions。 */
export function mdToHtml(src: string, opts?: Partial<RenderOptions>): string {
  const prev = RO;
  RO = resolveOpts(opts);
  try {
    // 真实 U+0001（异常字节/GBK 解码噪声）会与转义占位符撞车：入口剥除，可见性无损；
    // NUL→U+FFFD（CommonMark 2.1 输入预处理，P2；仅显示层，内存/磁盘 src 不动）。
    // 尾随 \n：cmark 每块输出都以换行收尾——HTML 解析器的活跃格式元素重建（<a> 跨 </p>）
    // 依赖该换行落位，缺它会让 #476 一类官方例结构比对错位。空文档仍返回空串。
    const body = renderBlocks(normalizeInput(src.split(ESCAPED).join("")), new Map());
    return body === "" ? "" : body + "\n";
  } finally {
    RO = prev;   // 嵌套/外部调用交错也不串文案
  }
}

/** 与 Rust toggle_task 同一坐标系：围栏外第 nth 个任务（0 起）。
 * 选择器为 [data-task]：$$ 块内被吞的任务以隐藏 <span data-task> 占位保持序号对齐（见 mathBlockHtml）。
 * 隐藏占位不可点（无 .cbx），点击永远落在真 <li> 上，其索引与 Rust 计数一致。 */
export function taskOrdinalOf(article: HTMLElement, li: HTMLElement): number {
  const all = [...article.querySelectorAll("[data-task]")];
  return all.indexOf(li);
}

/** 搜索片段 → HTML（SEC-01）：输入是 Rust 返回的**原始源文本**（含 « » 命中标记），
 *  这里先整体 escapeHtml 再把 « » 换成 <em>——恶意 .md 里的 <img onerror> 等只会以字面文本出现。
 *  调用方禁止对片段之外的原始文本直接 innerHTML；片段必须且只能经本函数出口。 */
export function renderSnippet(raw: string): string {
  return escapeHtml(raw).replace(/«([^»]*)»/g, "<em>$1</em>");
}
