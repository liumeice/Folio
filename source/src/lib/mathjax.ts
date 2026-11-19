/* MathJax v3（vendored，SVG 输出）排版入口 —— 渲染期只存源码，DOM 插入后延迟排版。
 * 设计源《Mermaid与MathJax渲染集成方案_20260718.md》§2.3；实现提示词 §3.2 / §3.3。
 * 库不在本模块 import：由 index.html 的 <script defer> 挂到全局（同 highlight.js vendored 先例，
 * 且 MathJax es5 包是经典脚本，ESM import() 下 var 不挂全局——必须 script 标签加载）。
 * 失败策略（需求方 2026-11-16 最终定夺）：原文位置「框起源码 + 标注语法错误」；
 * 单块抛错只退化它自己，整篇零中断；MathJax 缺失同样走可见退化，绝不白屏。 */
import { escapeHtml } from "./md.ts";
import { compensateAnchor } from "./nav.ts";

interface MathJaxLike {
  startup?: { promise?: Promise<unknown> };
  tex2svgPromise?: (code: string, opts: { display: boolean }) => Promise<HTMLElement>;
}

function mathJax(): MathJaxLike | null {
  return ((globalThis as unknown as { MathJax?: MathJaxLike }).MathJax) ?? null;
}

/** 就绪门：startup.promise 决议后才许转换（否则 tex2svgPromise 未挂载）；未加载则立即失败 */
async function ready(): Promise<MathJaxLike | null> {
  const M = mathJax();
  if (!M?.tex2svgPromise) return null;
  try { await M.startup?.promise; } catch { return M; }
  return typeof M.tex2svgPromise === "function" ? M : null;
}

/** 按需加载 MathJax（2026-11-18 性能复检）：无公式文档不再在启动时解析 2.2MB 脚本。
 *  必须 config.js → tex-svg-full.js 顺序执行（config 注释的硬约束）；加载失败走可见退化。
 *  同一进程只尝试一次；成功后 globalThis.MathJax 常驻，后续文档零成本。 */
let loader: Promise<MathJaxLike | null> | null = null;
function loadMathJax(): Promise<MathJaxLike | null> {
  if (mathJax()?.tex2svgPromise) return ready();
  // 纯 Node 测试环境没有 document：保持原有「库缺失 → 退化」语义
  if (typeof document === "undefined") return Promise.resolve(null);
  if (!loader) {
    loader = new Promise((resolve) => {
      const cfg = document.createElement("script");
      cfg.src = "/vendor/mathjax/config.js";
      cfg.async = false;
      cfg.onerror = () => resolve(null);
      cfg.onload = () => {
        const main = document.createElement("script");
        main.src = "/vendor/mathjax/tex-svg-full.js";
        main.async = false;
        main.onerror = () => resolve(null);
        main.onload = () => resolve(mathJax());
        document.head.appendChild(main);
      };
      document.head.appendChild(cfg);
    });
  }
  return loader.then(() => ready());
}

function codeOf(el: Element): string {
  return el.getAttribute("data-code") ?? "";
}

/** 失败退化（需求方最终定夺：阅读窗对应位置把源码框起来并标注语法错误）；
 *  **保留 [data-task] 记账占位**（丢了它，后续任务序号全体错位） */
function fallback(el: HTMLElement, code: string): void {
  const marks = [...el.querySelectorAll("[data-task]")].map((n) => n.outerHTML).join("");
  // 原地替换即布局推挤事件：经可见锚补偿（滚动同步方案 §4.2 第一层），用户正在读也不跳
  compensateAnchor(() => {
    el.innerHTML = marks + '<div class="fb-box"><div class="fb-label">⚠ 公式语法错误 · 以下为源码原文</div>' +
      `<pre class="formula-fallback">${escapeHtml(code)}</pre></div>`;
    el.classList.add("f-error"); // CSS：.f-block.f-error{opacity:1;min-height:0!important}，退化态直接可见
  });
}

/** 对 scope 内所有 [data-math] 元素排版（§5.4 契约签名：(scope, codeOf?, isBlockOf?)）。
 *  默认从 data-code 属性取源码、按 data-math 判块/行内；调用方可注入自定义取码器。 */
export async function typesetMathIn(
  scope: HTMLElement,
  codeOfFn: (el: Element) => string = codeOf,
  isBlockOf: (el: Element) => boolean = (el) => el.getAttribute("data-math") !== "inline",
): Promise<void> {
  const els = [...scope.querySelectorAll<HTMLElement>("[data-math]")];
  if (!els.length) return;
  const M = await loadMathJax();
  if (!M) { // 库缺失/未就绪：全部走可见退化，绝不留 opacity:0 的空白
    for (const el of els) fallback(el, codeOfFn(el));
    return;
  }
  for (const el of els) {
    if (!el.isConnected) return;
    const code = codeOfFn(el);
    if (!code.trim()) { fallback(el, code); continue; }
    const display = isBlockOf(el);
    try {
      const container = await M.tex2svgPromise!(code.trim(), { display });
      const svg = container?.querySelector?.("svg");
      if (!svg || container.querySelector("mjx-merror, [data-mml-node='merror']")) {
        fallback(el, code);
        continue;
      }
      const marks = [...el.querySelectorAll("[data-task]")].map((n) => n.outerHTML).join("");
      compensateAnchor(() => {
        el.innerHTML = marks + svg.outerHTML;
        el.classList.add("f-ready");
        container.remove?.();
      });
    } catch {
      fallback(el, code);
    }
  }
}
