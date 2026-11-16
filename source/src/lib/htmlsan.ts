/* Markdown 内嵌原始 HTML 的白名单净化器（需求：阅读窗支持嵌入 html 语句显示，如 README 里的
 * <p align="center"><img …> 徽章块）。安全定位=SEC-01 的同族收口：DOMParser 解析后按
 * 标签/属性/URL 三重白名单走树清洗，未知标签拆壳保内容，危险标签整枝删除。
 * 不引入第三方 sanitizer——规则集就是可读的产品契约，逐条有回归测试（tests/html.test.ts）。 */

/** 渲染器自有 HTML 之外，允许 README 作者直接书写的标签（GitHub CommonMark 允许集的子集） */
const ALLOW = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "center", "code", "col", "colgroup",
  "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q",
  "s", "samp", "section", "small", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "var",
]);

/** 整枝删除：可执行/可外联/可表单化容器（svg/math 属性面太宽，v1 先禁） */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "form", "input",
  "textarea", "select", "button", "link", "meta", "base", "noscript", "template", "portal",
  "svg", "math", "audio", "video", "canvas", "marquee",
]);

const ALLOW_ATTR = new Set([
  "href", "src", "alt", "title", "width", "height", "class", "align", "valign",
  "colspan", "rowspan", "headers", "scope", "open", "start", "dir", "lang", "id",
]);

/** URL 属性 scheme 白名单（src 额外允许 data:image/；href 允许 mailto/#/相对/协议相对） */
function safeUrl(attr: string, v: string): boolean {
  const s = v.replace(/[\u0000- ]/g, "").toLowerCase();
  if (/^(javascript|vbscript|file|blob):/.test(s)) return false;
  if (s.startsWith("data:")) return attr === "src" && s.startsWith("data:image/");
  return true; // http(s)/mailto/#/相对/协议相对——外链点击仍受 Reader scheme 白名单二次管辖
}

function scrub(el: Element): void {
  for (const a of [...el.attributes]) {
    const name = a.name.toLowerCase();
    if (!ALLOW_ATTR.has(name) || name.startsWith("on") || name === "srcdoc" || name === "formaction") {
      el.removeAttribute(a.name);
      continue;
    }
    if ((name === "href" || name === "src") && !safeUrl(name, a.value)) el.removeAttribute(a.name);
  }
}

/** 树遍历：删除 DROP 子树；未知标签拆壳保内容；允许标签保结构并清属性 */
function walk(node: Element, doc: Document): void {
  for (const child of [...node.children]) {
    const tag = child.tagName.toLowerCase();
    if (DROP.has(tag)) { child.remove(); continue; }
    if (ALLOW.has(tag)) { scrub(child); walk(child, doc); continue; }
    // 未知元素：拆掉外壳保留子内容（与 GitHub 对 <font> 等的处理同向）
    const frag = doc.createDocumentFragment();
    while (child.firstChild) frag.appendChild(child.firstChild);
    child.replaceWith(frag);
    // frag 里的元素可能未走查——重新拆壳一轮后再继续
    for (const c of [...frag.children]) walk(c, doc);
  }
  // 注释节点保留（无害），processing instruction 会被 DOMParser 吞掉
}

export function sanitizeHtml(raw: string): string {
  if (typeof DOMParser === "undefined") {
    // 无 DOM 环境（node 直跑测试的保守路径）：整体转义为文本，绝不裸注入
    return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  const doc = new DOMParser().parseFromString("<body>" + raw + "</body>", "text/html");
  walk(doc.body, doc);
  // 顶层文本里的裸 "<" 已被解析器处理；返回 body 内容即可直接 innerHTML
  return doc.body.innerHTML;
}
