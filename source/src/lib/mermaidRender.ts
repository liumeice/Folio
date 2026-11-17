/* Mermaid 渲染（v11.17.2，npm ESM 动态 import）——首次出现图表块才加载。
 * 2026-11-16 由「public/vendor 单文件 UMD + script 注入」切换为 npm 包：
 *   · vite 按动态 import 自动分片，各图类型独立 chunk，入口包更小；
 *   · mermaid v11 上游已移除 zenuml 图类型（且其 dist 内零痕迹）——
 *     首行 `zenuml` 关键字的块由 zenumlRender.ts 走 @zenuml/core 原生渲染，这里显式排除。
 * 失败策略（需求方最终定夺）：对应位置「框起源码 + 标注语法错误」；两条错误路都要拦——
 * ① render() reject；② 不抛异常、把"炸弹 + Syntax error in text"错误图当成功返回。 */
import { escapeHtml } from "./md.ts";
import { compensateAnchor } from "./nav.ts";

interface MermaidLike {
  initialize: (conf: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}

let modPromise: Promise<MermaidLike> | null = null;

async function getMermaid(): Promise<MermaidLike> {
  if (!modPromise) {
    modPromise = import("mermaid")
      .then((m) => {
        const mod = m.default ?? (m as unknown as { default: MermaidLike });
        if (!mod || typeof mod.initialize !== "function") throw new Error("mermaid 模块导出异常");
        return mod as unknown as MermaidLike;
      })
      .catch((e) => { modPromise = null; throw e; }); // 失败不缓存：下次含图文档可重试
  }
  return modPromise;
}

/** mermaid 主题映射。themeName 由调用方从 settings 信号显式传入——
 *  App 落 data-theme 的 effect 与主题重渲效果同为 settings().theme 的订阅者，执行顺序不保证，
 *  读 DOM 会拿到上一个主题（真窗口实测：切亮色后图仍黑即此因）。dataset 仅作兜底。 */
function initForTheme(m: MermaidLike, themeName?: string): void {
  const t = themeName ?? document.documentElement.dataset.theme ?? "dark";
  m.initialize({
    startOnLoad: false,
    securityLevel: "strict", // XSS 硬线：标签内 HTML/点击脚本全禁
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
  compensateAnchor(() => {   // 原地替换即布局推挤事件，经可见锚补偿（滚动同步方案 §4.2）
    el.innerHTML = '<div class="fb-box"><div class="fb-label">⚠ 图表语法错误 · 以下为源码原文</div>' +
      `<pre class="formula-fallback">${escapeHtml(el.getAttribute("data-code") ?? "")}</pre></div>`;
    el.classList.add("f-error");
  });
}

/* 全局串行链：初排与主题重渲不许交错——mermaid.render 共享全局状态（parse 前清 diagram），
 * 且 initialize() 是覆盖式配置，并发时后者会让前者产出旧配色。 */
let chain: Promise<void> = Promise.resolve();

/** 渲染/重渲 scope 内全部 [data-mermaid] 占位块（zenuml 路由块除外——它们归 zenumlRender）。
 *  data-code 在成功/失败两路都留在占位符属性上 → 主题切换可原位重渲。
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
  const els = [...scope.querySelectorAll<HTMLElement>("[data-mermaid]:not([data-zuml])")];
  if (!els.length) return;
  let m: MermaidLike;
  try {
    m = await getMermaid();
  } catch {
    for (const el of els) if (el.isConnected) fallback(el); // 引擎缺失：全部退化为源码可见
    return;
  }
  initForTheme(m, themeName);
  sweepLeftovers(); // 上一轮 reject 可能把错误图遗留进 body——先清场（菜单顶出视口的实测教训）
  for (const el of els) {
    if (!el.isConnected) return;
    const tempId = "folio-mmd-" + ++idSeq;
    try {
      const { svg } = await m.render(tempId, codeOf(el));
      if (isMermaidErrorSvg(svg)) throw new Error("mermaid 错误回显图");
      if (!el.isConnected) return; // 渲染期间文档已切换：丢弃结果
      compensateAnchor(() => {
        el.innerHTML = svg;
        el.classList.add("f-ready");
        el.classList.remove("f-error"); // 重渲成功要能洗掉上一次的退化态
      });
    } catch {
      fallback(el);
    } finally {
      // 清理只按「body 直接子级」定位——不能用 getElementById：mermaid 返回的 svg 根元素
      // 自带我们发的 id，写进占位符后文档里同 id 成对，getElementById 命中正文好图、
      // body 级临时容器反而幸存。且 mermaid v11 建容器时 id 再加 "d" 前缀
      // （2026-11-17 实测残留 'dfolio-mmd-3'），两种形态都要清。
      document.querySelector('body > [id="' + tempId + '"], body > [id="d' + tempId + '"]')?.remove();
    }
  }
  sweepLeftovers(); // 整趟再兜一遍：中途异常/并发遗留都不给它们留在 body 的机会
  // reject 路的容器插入可能晚于 Promise 拒绝到达（异步渲染尾部），延时再兜一次
  setTimeout(sweepLeftovers, 1200);
}

/** 清扫 body 层的 mermaid 临时容器遗留（id 前缀族是我们发的，误伤半径为零；含 mermaid 的 d 前缀形态） */
function sweepLeftovers(): void {
  document.querySelectorAll('body > [id*="folio-mmd-"]').forEach((n) => n.remove());
}
