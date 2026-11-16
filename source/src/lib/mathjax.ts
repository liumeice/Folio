/* MathJax v3（vendored，SVG 输出）排版入口 —— 渲染期只存源码，DOM 插入后延迟排版。
 * 设计源《Mermaid与MathJax渲染集成方案_20260718.md》§2.3；实现提示词 §3.2 / §3.3。
 * 库不在本模块 import：由 index.html 的 <script defer> 挂到全局（同 highlight.js vendored 先例，
 * 且 MathJax es5 包是经典脚本，ESM import() 下 var 不挂全局——必须 script 标签加载）。
 * 失败策略（需求方 2026-11-16 最终定夺）：原文位置「框起源码 + 标注语法错误」；
 * 单块抛错只退化它自己，整篇零中断；MathJax 缺失同样走可见退化，绝不白屏。 */
import { escapeHtml } from "./md.ts";

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

function codeOf(el: Element): string {
  return el.getAttribute("data-code") ?? "";
}

/** 失败退化（需求方最终定夺：阅读窗对应位置把源码框起来并标注语法错误）；
 *  **保留 [data-task] 记账占位**（丢了它，后续任务序号全体错位） */
function fallback(el: HTMLElement, code: string): void {
  const marks = [...el.querySelectorAll("[data-task]")].map((n) => n.outerHTML).join("");
  el.innerHTML = marks + '<div class="fb-box"><div class="fb-label">⚠ 公式语法错误 · 以下为源码原文</div>' +
    `<pre class="formula-fallback">${escapeHtml(code)}</pre></div>`;
  el.classList.add("f-error"); // CSS：.f-block.f-error{opacity:1}，退化态直接可见
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
  const M = await ready();
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
      el.innerHTML = marks + svg.outerHTML;
      el.classList.add("f-ready");
      container.remove?.();
    } catch {
      fallback(el, code);
    }
  }
}
