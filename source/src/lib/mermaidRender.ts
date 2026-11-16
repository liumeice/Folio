/* Mermaid 渲染（v11.17.2 vendored UMD）——首次出现图表块才加载（约束 4：懒载）。
 * 加载方式必须是经典 <script> 注入而非 import()：该 UMD 用裸 `var __esbuild_esm_mermaid_nm`
 * 建全局命名空间，ESM 模块作用域下 var 不挂 globalThis，尾部取值会 TypeError（实测文件尾
 * globalThis["mermaid"]=…__esbuild_esm_mermaid_nm["mermaid"].default）。
 * 失败策略（需求方最终定夺）：对应位置「框起源码 + 标注语法错误」；两条错误路都要拦——
 * ① render() reject；② 不抛异常、把炸弹错误图当成功返回（重渲路径实测，见 isMermaidErrorSvg）。 */
import { escapeHtml } from "./md.ts";

interface MermaidLike {
  initialize: (conf: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

const SRC = "/vendor/mermaid/mermaid.min.js";
let loading: Promise<void> | null = null;

/** 经典脚本注入（CSP script-src 回退 'self'，同源自检通过；不走 ESM loader） */
function loadClassic(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => resolve();
    const fail = () => reject(new Error("脚本加载失败：" + src));
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = done;
    s.onerror = fail;
    document.head.appendChild(s);
  });
}

function getMermaid(): Promise<void> {
  if (!loading) {
    loading = loadClassic(SRC).catch((e) => {
      loading = null; // 失败不缓存 rejected promise：下次打开含图文档还可重试
      throw e;
    });
  }
  return loading;
}

function mermaidGlobal(): MermaidLike | null {
  return ((globalThis as unknown as { mermaid?: MermaidLike }).mermaid) ?? null;
}

/** 图表主题跟随应用主题（mermaid 内置主题名映射；米色用 neutral 防深色底突兀） */
/** mermaid 主题映射。themeName 由调用方从 settings 信号显式传入——
 *  App 的 data-theme 落 DOM effect 与本效果同为 settings().theme 的订阅者，执行顺序不保证，
 *  读 DOM 会拿到上一个主题（真窗口实测：切亮色后图仍黑即此因）。dataset 仅作兜底。 */
function initForTheme(m: MermaidLike, themeName?: string): void {
  const t = themeName ?? document.documentElement.dataset.theme ?? "dark";
  m.initialize({
    startOnLoad: false,
    securityLevel: "strict", // XSS 硬线：标签内 HTML/点击脚本全禁（提示词 §1.5）
    theme: t === "dark" ? "dark" : t === "sepia" ? "neutral" : "default",
    fontFamily: "var(--font-ui), 'Segoe UI', 'Microsoft YaHei UI', sans-serif",
  });
}

let idSeq = 0;

/** mermaid 错误回显图判定（不抛异常、把炸弹图当成功返回的那条路）。
 *  只认「Syntax error in text」这条可见文案——class=error-text/error-icon 是禁用的判据：
 *  mermaid 把错误图标样式嵌进**所有**合法图的 <defs>（2026-11-16 实测：按 class 判会把
 *  时序图误杀成错误框）。 */
export function isMermaidErrorSvg(svg: string): boolean {
  return svg.includes("Syntax error in text");
}

function fallback(el: HTMLElement): void {
  // 语法错误退化（需求方最终定夺）：原文位置框起源码 + 标注，尺寸受控（max-height 滚动），绝不炸弹大图
  el.innerHTML = '<div class="fb-box"><div class="fb-label">⚠ 图表语法错误 · 以下为源码原文</div>' +
    `<pre class="formula-fallback">${escapeHtml(el.getAttribute("data-code") ?? "")}</pre></div>`;
  el.classList.add("f-error");
}

/* 全局串行链：初排与主题重排不许交错——mermaid.render 共享全局状态（parse 前清 diagram），
 * 且 initialize() 是覆盖式配置，两次调用并发时后者会让前者产出旧配色。 */
let chain: Promise<void> = Promise.resolve();

/** 渲染/重渲染 scope 内全部 [data-mermaid] 占位块（§5.4 契约签名 (scope, codeOf?) + 主题参数）。
 *  data-code 在成功/失败两路都留在占位符属性上 → 主题切换可原位重渲（MathJax 用 currentColor，
 *  天然随主题，无需重排；mermaid SVG 是烘焙色，必须重渲——需求方反馈「切亮色图还是黑的」）。
 *  每次 await 后复查 el.isConnected——文档切换后旧容器脱离 DOM，残余渲染静默丢弃（易错点 #5）。 */
export function renderMermaid(
  scope: HTMLElement,
  codeOf: (el: Element) => string = (el) => el.getAttribute("data-code") ?? "",
  themeName?: string,
): Promise<void> {
  const step = () => doRender(scope, codeOf, themeName);
  chain = chain.then(step, step);
  return chain;
}

async function doRender(
  scope: HTMLElement,
  codeOf: (el: Element) => string,
  themeName?: string,
): Promise<void> {
  const els = [...scope.querySelectorAll<HTMLElement>("[data-mermaid]")];
  if (!els.length) return;
  try {
    await getMermaid();
  } catch {
    for (const el of els) if (el.isConnected) fallback(el); // 库缺失：全部退化为源码可见
    return;
  }
  const m = mermaidGlobal();
  if (!m) {
    for (const el of els) if (el.isConnected) fallback(el);
    return;
  }
  initForTheme(m, themeName);
  sweepLeftovers(); // 进入前先清场：上一轮失败可能已把炸弹图遗留在 body（2026-11-16 实测：把窗口顶出菜单）
  for (const el of els) {
    if (!el.isConnected) return;
    const tempId = "folio-mmd-" + ++idSeq;
    try {
      const { svg } = await m.render(tempId, codeOf(el));
      // mermaid 语法错误路 A：不抛异常、把"炸弹 + Syntax error in text"错误图当成功返回 → 验身拦截
      if (isMermaidErrorSvg(svg)) throw new Error("mermaid 错误回显图");
      if (!el.isConnected) return; // 渲染期间文档已切换：丢弃结果，不写进脱离 DOM 的容器
      el.innerHTML = svg;
      el.classList.add("f-ready");
      el.classList.remove("f-error"); // 重渲成功要能洗掉上一次的退化态（改对语法后立即正常显示）
    } catch {
      fallback(el); // 路 B：render reject——源码框退化（需求方最终定夺）
    } finally {
      // 路 B 的真实坑（20:2x 实测定位）：reject 时 mermaid 把错误图留在它建于 document.body 的
      // 临时容器里不清理——撑高 body → 菜单被顶出视口、炸弹挂在状态栏下。
      // 但注意（20:3x 二轮实测）：成功返回的 svg 串本身内嵌 id="folio-mmd-N"，写进占位符后
      // getElementById 会命中 **el 内的好图**——无差别 remove 就是把成功渲染删空。
      // 故只清理 scope 之外的同名节点（那才是 mermaid 的 body 级临时容器）。
      const stray = document.getElementById(tempId);
      if (stray && !scope.contains(stray)) stray.remove();
    }
  }
}

/** 清扫 body 层的 mermaid 临时容器遗留（id 前缀是我们发的，误伤半径为零） */
function sweepLeftovers(): void {
  document.querySelectorAll('body > [id^="folio-mmd-"]').forEach((n) => n.remove());
}
