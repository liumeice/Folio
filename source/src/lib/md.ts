/* 迷你 Markdown 渲染器 —— 自原型移植，内联层升级为递归解析器。
 * 关键契约 1：标题 data-sec 编号必须与 folio-core::markdown::headings 完全一致
 *   （围栏状态也必须一致：统一只认 ``` 围栏，~~~ 不算——此前 TS 多认 ~~~ 是潜在错位 bug）。
 *   headingMatch() 是 Rust headings() 行判定的逐条镜像（前导空白容忍、裸 "#"、闭合 # 串），
 *   引用块/提示块内的标题**不占锚点序号**——Rust 按原始行 trim_start 判定，"> # x" 不是标题。
 * 关键契约 2：任务清单序号坐标系同 Rust toggle_task（围栏外计数；
 *   引用块/提示块内的 "- [ ]" Rust 不认，故前端也不得生成 data-task——审查报告 CON-01）。
 * 安全契约（审查报告 SEC-01）：renderSnippet 自带转义。
 * 远程图片口径（需求方 2026-11-16 定夺）：自动加载（<img src> + loading=lazy），
 *   与通用 Markdown 阅读器一致；「运行期零外联」的旧承诺据此让位于功能性。
 * 内联层支持：嵌套链接包图 [![a](i)](u)、参考式 [x][1] + 定义行、
 *   自动链接 <url>/<mailto>、裸 URL、反引号码段保护、反斜杠转义、强调/删除线、GFM emoji 短代码。 */
import { applyEmojis } from "./emoji.ts";
import { sanitizeHtml } from "./htmlsan.ts";

/** HTML 块起始行（GFM 7 类简化为两类够用）：注释、或 ≤3 空格缩进的 <tag…> / </tag>。
 *  刻意排除 `<https:` 这类自动链接——冒号不让过标签名字符。 */
const HTML_BLOCK_RE = /^ {0,3}(?:<!--|<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$))/;

/** 「图片行」单元：`![alt](url)` 或 README 徽章惯用的套链一层 `[![alt](img)](link)`。
 *  （首版只认裸 ![]()，Bootstrap 的 shields.io 徽章全是套链形态，整段漏判成普通段落竖排——2026-11-16 需求反馈） */
const IMG_LINE_RE = new RegExp(
  "^(?:(?:!\\[[^\\]]*\\]\\([^)]*\\)" +
    "|\\[!\\[[^\\]]*\\]\\([^)]*\\)\\]\\([^)]*\\))" + "[ \\t]*)+$",
);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
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
    const close = s.indexOf(closer, i + 1);
    if (close === -1) return null;
    title = s.slice(i + 1, close);
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
  const tAttr = title ? ` title="${escapeHtml(title)}"` : "";
  // 远程图片自动加载（需求方 2026-11-16 二次定夺：功能优先；此前的占位点击方案废弃）。
  // loading=lazy 保留：浏览器按需就近加载，长文档不一次拉全部。协议相对 // 交给
  // WebView 按当前 origin 解析（http: 文档 → http 图），CSP img-src 已放行 http(s)。
  if (isImg) return `<img alt="${escapeHtml(flattenAlt(label))}" src="${escapeHtml(url)}"${tAttr} loading="lazy">`;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"${title ? ` title="${escapeHtml(title)}"` : ""}>${renderInline(label, defs)}</a>`;
}

/** 纯文本 run：先保护裸 URL 成自动链接，再做强调（强调内不再解析 URL，避免破坏属性） */
function renderRun(seg: string, defs: Defs): string {
  const urlRe = /https?:\/\/[^\s<>"'）)】\]，。；：！？、]+/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(seg)) !== null) {
    let raw = m[0];
    while (raw.length > 1 && /[.,;:!?)\]}'">]+$/.test(raw.slice(-1))) raw = raw.slice(0, -1);
    if (raw.length < 8) continue;
    out += emphasisPass(seg.slice(last, m.index));
    out += `<a href="${escapeHtml(raw)}" target="_blank" rel="noopener">${escapeHtml(raw)}</a>`;
    last = m.index + raw.length;
    urlRe.lastIndex = last;
  }
  out += emphasisPass(seg.slice(last));
  void defs;
  return out;
}

/* 强调正则。粗体分支刻意允许定界符与内容之间的内侧空白并剔掉（星号星号+空格+加粗+空格+星号星号 → 加粗）：
 * 原型的粗体替换本就容忍这种写法，升级成递归解析器时一度比原型严格，属回归——
 * 带引号/逗号等内容的粗体（内侧有空格）因此整个不渲染。空格才是元凶，引号无辜。 */
const EMPH_RE = /(\*\*|__)[ \t]*([\s\S]+?)[ \t]*\1|(?<![\w"'])\*(?=\S)([^*\n]*?\S)\*(?![\w"'])|(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w)|~~(?=\S)([\s\S]*?\S)~~/g;

function emphasisPass(text: string): string {
  // 纯文本叶子：转义后再做 emoji 短代码替换（代码段/URL/属性不经过这里，天然免疫）
  const esc = (t: string) => applyEmojis(escapeHtml(t));
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  EMPH_RE.lastIndex = 0;
  while ((m = EMPH_RE.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    if (m[2] !== undefined) out += `<strong>${esc(m[2])}</strong>`;
    else if (m[3] !== undefined) out += `<em>${esc(m[3])}</em>`;
    else if (m[4] !== undefined) out += `<em>${esc(m[4])}</em>`;
    else if (m[5] !== undefined) out += `<del>${esc(m[5])}</del>`;
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

export function renderInline(src: string, defs: Defs): string {
  let out = "";
  let buf = "";
  let i = 0;
  const n = src.length;
  const flush = () => {
    if (buf) { out += renderRun(buf, defs); buf = ""; }
  };
  while (i < n) {
    const c = src[i];
    if (c === "\\" && i + 1 < n && PUNCT.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (c === "`") {
      let run = 0;
      while (i + run < n && src[i + run] === "`") run++;
      const token = "`".repeat(run);
      let j = i + run;
      let ci = -1;
      for (;;) {
        j = src.indexOf(token, j);
        if (j === -1) break;
        if (src[j + run] !== "`") { ci = j; break; }
        j += run;
      }
      if (ci !== -1) {
        flush();
        let code = src.slice(i + run, ci);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        out += `<code>${escapeHtml(code.replace(/\n/g, " "))}</code>`;
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
          flush();
          out += `<span class="f-block" data-math="inline" data-lang="tex" data-code="${escapeHtml(body)}"></span>`;
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
            flush();
            out += `<span class="f-block" data-math="inline" data-lang="tex" data-code="${escapeHtml(body)}"></span>`;
            i = hit + 1;
            continue;
          }
        }
      }
      buf += c;
      i++;
      continue;
    }
    const isImg = c === "!" && src[i + 1] === "[";
    if (c === "[" || isImg) {
      const open = isImg ? i + 1 : i;
      const close = matchBracket(src, open);
      if (close !== -1) {
        const label = src.slice(open + 1, close);
        const j = close + 1;
        if (src[j] === "(") {
          if (src[j + 1] === ")") { flush(); out += emitLinkOrImg(isImg, label, "", "", defs); i = j + 2; continue; }
          const tgt = parseInlineTarget(src, j);
          if (tgt) { flush(); out += emitLinkOrImg(isImg, label, tgt.url, tgt.title, defs); i = tgt.end; continue; }
        } else if (src[j] === "[") {
          const rc = matchBracket(src, j);
          if (rc !== -1) {
            const rl = src.slice(j + 1, rc);
            const def = defs.get(normLabel(rl === "" ? label : rl));
            if (def) { flush(); out += emitLinkOrImg(isImg, label, def.url, def.title, defs); i = rc + 1; continue; }
          }
        } else {
          const def = defs.get(normLabel(label));
          if (def) { flush(); out += emitLinkOrImg(isImg, label, def.url, def.title, defs); i = j; continue; }
        }
      }
    }
    if (c === "<") {
      const close = src.indexOf(">", i + 1);
      if (close !== -1) {
        const inner = src.slice(i + 1, close);
        if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/.test(inner)) {
          flush();
          out += `<a href="${escapeHtml(inner)}" target="_blank" rel="noopener">${escapeHtml(inner)}</a>`;
          i = close + 1;
          continue;
        }
        if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(inner)) {
          flush();
          out += `<a href="mailto:${escapeHtml(inner)}">${escapeHtml(inner)}</a>`;
          i = close + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/* ══════════════ 块层 ══════════════ */

/** 表格分列：代码段内的 |、反斜杠转义 \| 都不算分隔符（GFM 语义） */
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
const CALLOUT_TYPES = {
  note: { label: "说明", icon: "i-co-note" },
  tip: { label: "提示", icon: "i-co-tip" },
  important: { label: "重要", icon: "i-co-important" },
  warning: { label: "警告", icon: "i-co-warning" },
  caution: { label: "危险", icon: "i-co-caution" },
} as const;

const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([+-])?(?:[ \t]+(.*))?$/i;

function parseCallout(buf: string[], defs: Defs, nested: boolean): string | null {
  if (!buf.length) return null;
  const m = buf[0].trim().match(CALLOUT_RE);
  if (!m) return null;
  const key = m[1].toLowerCase() as keyof typeof CALLOUT_TYPES;
  const spec = CALLOUT_TYPES[key];
  const fold = m[2] === "-" || m[2] === "+";
  const collapsed = m[2] === "-";
  const title = (m[3] ?? "").trim() || spec.label;
  const body = buf.length > 1 ? renderBlocks(buf.slice(1).join("\n"), defs, nested) : "";
  return (
    `<div class="callout co-${key}${collapsed ? " folded" : ""}" data-callout="${key}"${fold ? ` data-fold="1"` : ""}>` +
      `<div class="co-head"${fold ? ` role="button" tabindex="0" aria-expanded="${!collapsed}"` : ""}>` +
        `<svg class="ico ico-14"><use href="#${spec.icon}"/></svg><span>${escapeHtml(title)}</span>` +
        (fold ? `<svg class="ico ico-12 co-chev"><use href="#i-chev-d"/></svg>` : "") +
      `</div><div class="co-body">${body}</div>` +
    `</div>`
  );
}

/** 参考式链接定义行（CommonMark 子集，≤3 空格缩进） */
const DEF_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(<([^\s>]*)>|([^\s]+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;

/** 围栏判定：与 Rust folio-core::markdown::is_fence 同口径（trim_start 后以 ``` 起始；~~~ 不算） */
export function isFenceLine(line: string): boolean {
  return /^\s*```/.test(line);
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

/** 隐藏任务占位数 = 该段原文按 Rust task_parts 口径命中的行数（行首空白+列表符+空白+[x/空格]） */
function taskMarksIn(code: string): string {
  const n = (code.match(/(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/g) ?? []).length;
  return n ? '<span class="f-marks">' + '<span data-task="1" hidden></span>'.repeat(n) + "</span>" : "";
}

function mathBlockHtml(lang: string, code: string, nested: boolean): string {
  return `<div class="f-block" data-math="block" data-lang="${escapeHtml(lang)}" data-code="${escapeHtml(code)}">${nested ? "" : taskMarksIn(code)}</div>`;
}

function mermaidBlockHtml(code: string): string {
  return `<div class="f-block" data-mermaid="1" data-lang="mermaid" data-code="${escapeHtml(code)}"></div>`;
}

/** nested=true：引用块/提示块内的递归渲染——标题不占 data-sec 序号（Rust 的 outline 不认 "> # x"），
 *  任务项不生成 data-task/role=checkbox（Rust toggle_task 不认引用前缀行；CON-01/CON-02） */
function renderBlocks(src: string, defs: Defs, nested = false): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  // CommonMark 语义：链接定义全文预扫描（引用可以在定义之前出现）。围栏内的行不算定义。
  {
    let inF = false;
    for (const ln of lines) {
      if (/^\s*```/.test(ln)) { inF = !inF; continue; }
      if (inF) continue;
      const d = ln.match(DEF_RE);
      if (d && !defs.has(normLabel(d[1]))) {
        defs.set(normLabel(d[1]), { url: d[3] ?? d[4] ?? "", title: d[5] ?? d[6] ?? d[7] ?? "" });
      }
    }
  }
  const out: string[] = [];
  let i = 0;
  let secN = 0;
  let inFence = false;
  const listStack: { type: "ul" | "ol"; indent: number }[] = [];
  let para: string[] = [];

  const closeLists = () => {
    while (listStack.length) {
      const l = listStack.pop()!;
      out.push(l.type === "ul" ? "</ul>" : "</ol>");
    }
  };
  const flushPara = () => {
    if (para.length) {
      // join("\n")：段内换行保留给行内公式扫描判「跨行 miss」；HTML 折叠空白，渲染结果与 join(" ") 相同
      // 纯图片段（需求补充：多个连续图片横向排列不换行）：整段只有 ![]() 语法 → imgrow flex 行
      const imgOnly = para.every((l) => IMG_LINE_RE.test(l.trim()));
      out.push((imgOnly ? '<p class="imgrow">' : "<p>") + renderInline(para.join("\n"), defs) + "</p>");
      para = [];
    }
  };
  const inline = (s: string) => renderInline(s, defs);
  // 与 Rust folio-core::markdown::is_fence 同口径：只认 ```
  const isFence = isFenceLine;

  while (i < lines.length) {
    const line = lines[i];
    if (isFence(line)) {
      flushPara();
      closeLists();
      inFence = !inFence;
      if (inFence) {
        const lang = line.trim().slice(3).trim() || "text";
        i++;
        const buf: string[] = [];
        while (i < lines.length && !isFence(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        const kind = classifyCodeLang(lang);
        if (kind === "math") {
          out.push(mathBlockHtml("math", buf.join("\n"), nested));
        } else if (kind === "mermaid") {
          out.push(mermaidBlockHtml(buf.join("\n")));
        } else {
          out.push(
            `<div class="codeblock"><div class="cbh"><span class="lang">${escapeHtml(lang)}</span><span class="sp"></span>` +
              `<button class="cb-copy" type="button" title="复制代码块"><svg class="ico ico-14"><use href="#i-copy"/></svg>复制</button></div>` +
              `<pre><code class="language-${escapeHtml(lang.toLowerCase())}">${escapeHtml(buf.join("\n"))}</code></pre></div>`,
          );
        }
        if (i < lines.length) i++;
        inFence = false;
        continue;
      }
      i++;
      continue;
    }
    if (MATH_FENCE_RE.test(line)) {
      // $$…$$ 成块（易错点 #1/#2：行首行尾只含 $$ 才算界行；`a = $$x` 这类内嵌写法不进块态机）
      flushPara();
      closeLists();
      i++;
      const buf: string[] = [];
      while (i < lines.length && !MATH_FENCE_RE.test(lines[i])) {
        const ln = lines[i];
        if (!nested && headingMatch(ln)) secN++; // 记账：Rust 把 $$ 内的 "# " 也计标题
        buf.push(ln);
        i++;
      }
      // 未闭合的 $$ 吃到 EOF（与 ``` 未闭合同策略）；空块 → data-code="" 由 mathjax.ts 走退化分支
      out.push(mathBlockHtml("tex", buf.join("\n"), nested));
      if (i < lines.length) i++; // 吃掉闭界行
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      closeLists();
      i++;
      continue;
    }
    const dm = line.match(DEF_RE);
    if (dm && !/[|>]/.test(line.slice(0, 1))) {
      flushPara();
      closeLists();
      defs.set(normLabel(dm[1]), { url: dm[3] ?? dm[4] ?? "", title: dm[5] ?? dm[6] ?? dm[7] ?? "" });
      i++;
      continue;
    }
    if (HTML_BLOCK_RE.test(line)) {
      // 内嵌原始 HTML（需求：README 的徽章/居中块直接生效）：吃到空行为止，白名单净化后注入。
      // 块内 HTML 不再跑 markdown 内联解析（GFM 同规则）；<script>/on*/javascript: 由净化器拦死。
      // 坐标记账同 $$：Rust 不认识 html 块——块内的 "# " 标题与 "- [ ]" 任务照样计数。
      flushPara();
      closeLists();
      const buf: string[] = [];
      while (i < lines.length && !/^\s*$/.test(lines[i])) {
        const ln = lines[i];
        if (!nested && headingMatch(ln)) secN++;
        buf.push(ln);
        i++;
      }
      const code = buf.join("\n");
      out.push(sanitizeHtml(code) + (nested ? "" : taskMarksIn(code)));
      continue;
    }
    const h = headingMatch(line);
    if (h) {
      flushPara();
      closeLists();
      const lv = h.level;
      const text = h.text;
      if (nested) {
        // 引用块/提示块内的标题：照常渲染成标题元素，但绝不占用 data-sec 序号、不产出 id——
        // Rust headings() 按原始行判定（"> # x" 不是标题），两侧必须同坐标系（CON-02）
        out.push(`<h${lv}>${inline(text)}</h${lv}>`);
      } else {
        secN++;
        out.push(
          `<h${lv} id="sec-${secN}" data-sec="${secN}" data-sec-text="${escapeHtml(text)}">${inline(text)}</h${lv}>`,
        );
      }
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushPara();
      closeLists();
      out.push("<hr>");
      i++;
      continue;
    }
    if (
      /\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]*-[\s|:-]*$/.test(lines[i + 1]) &&
      /-/.test(lines[i + 1])
    ) {
      flushPara();
      closeLists();
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      let t = '<div class="tw-tbl"><table><thead><tr>';
      header.forEach((c) => (t += "<th>" + inline(c) + "</th>"));
      t += "</tr></thead><tbody>";
      rows.forEach((r) => {
        t += "<tr>";
        r.forEach((c) => (t += "<td>" + inline(c) + "</td>"));
        t += "</tr>";
      });
      t += "</tbody></table></div>";
      out.push(t);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      closeLists();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const co = parseCallout(buf, defs, true);
      out.push(co ?? "<blockquote>" + renderBlocks(buf.join("\n"), defs, true) + "</blockquote>");
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const indent = Math.floor(li[1].length / 2);
      const type = /[-*+]/.test(li[2]) ? "ul" : "ol";
      let text = li[3];
      let task: boolean | null = null;
      // \s* 而非 \s+：Rust task_parts 只认 "[x]"/"[ ]" 本身，不强制 ] 后空白（如 "- [ ]x"）。
      // 这里若比 Rust 严格，该行不进序号坐标系，后续任务全部错一位（同 CON-01 的坑）。
      const tm = text.match(/^\[( |x|X)\]\s*(.*)$/);
      if (tm) {
        task = tm[1].toLowerCase() === "x";
        text = tm[2];
      }
      while (listStack.length && listStack[listStack.length - 1].indent > indent) {
        const l = listStack.pop()!;
        out.push(l.type === "ul" ? "</ul>" : "</ol>");
      }
      if (!listStack.length || listStack[listStack.length - 1].indent < indent) {
        listStack.push({ type, indent });
        out.push(type === "ul" ? "<ul>" : "<ol>");
      } else if (listStack[listStack.length - 1].type !== type) {
        const l = listStack.pop()!;
        out.push(l.type === "ul" ? "</ul>" : "</ol>");
        listStack.push({ type, indent });
        out.push(type === "ul" ? "<ul>" : "<ol>");
      }
      if (task !== null) {
        if (nested) {
          // 引用块/提示块内的任务：只显示不可勾选（Rust toggle_task 不认引用前缀行，
          // 若给出可点击复选框会按错误序号改写别的行——静默损坏源文件，CON-01）
          out.push(
            `<li class="${task ? "done" : "task"}">` +
              `<span class="cbx${task ? " done" : ""}" aria-hidden="true" title="引用块内的任务不可勾选（不写回源文件）">` +
              `<svg class="ico ico-12"><use href="#i-check"/></svg></span>` +
              `<span class="tline">${inline(text)}</span></li>`,
          );
        } else {
          out.push(
            `<li class="${task ? "done" : "task"}" data-task="1">` +
              `<span class="cbx${task ? " done" : ""}" role="checkbox" tabindex="0" aria-checked="${task}" title="点击勾选 / 取消（写回源文件）">` +
              `<svg class="ico ico-12"><use href="#i-check"/></svg></span>` +
              `<span class="tline">${inline(text)}</span></li>`,
          );
        }
      } else {
        out.push("<li>" + inline(text) + "</li>");
      }
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  closeLists();
  return out.join("\n");
}

export function mdToHtml(src: string): string {
  return renderBlocks(src, new Map());
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
