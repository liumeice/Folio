/* zenuml 原生渲染（需求方 2026-11-16 定夺）。
 * 背景：mermaid v11 上游移除了 zenuml 图类型（依赖弃维护），npm dist 内零痕迹——
 * 所以直连 @zenuml/core 4.13.2：wasm 以 base64 内嵌于 JS（vite 零资产路径处理），
 * 图表字体走包内 data: URI（CSP font-src 'self' data: 已放行，无需放宽）。
 * CSP 仅新增 script-src 'wasm-unsafe-eval'（WebAssembly 编译的规范要求，见 tauri.conf.json）。
 * 首行 `zenuml` 关键字由 md.ts 打上 data-zuml 标记路由到这里；关键字行传给引擎前剥除。 */
import { escapeHtml, DEFAULT_RENDER_OPTIONS, type RenderOptions } from "./md.ts";
import { compensateAnchor } from "./nav.ts";

interface ZumlEngine {
  parse: (code: string) => Promise<{ pass: boolean; errorDetails?: { line: number; column: number; msg: string }[] }>;
  render: (code: string | undefined, cfg: Record<string, unknown> | undefined) => Promise<unknown>;
  getSvg: (opts?: unknown) => Promise<string>;
}

function themeFor(themeName?: string): string {
  const t = themeName ?? (typeof document !== "undefined" ? document.documentElement.dataset.theme : "dark");
  return t === "dark" ? "theme-dark" : t === "sepia" ? "theme-default" : "theme-clean-light";
}

/* 错误框文案（P4b，设计 §4.6.4）：外层标签用当前 UI 语言（opts），引擎原始错误（reason/msg）
 * 是技术详情、原样保留并转义；缺省=zh-CN 目录中文。 */
function fallbackBox(el: HTMLElement, reason: string, ro: RenderOptions): void {
  compensateAnchor(() => {   // 原地替换即布局推挤事件，经可见锚补偿（滚动同步方案 §4.2）
    el.innerHTML = `<div class="fb-box"><div class="fb-label">${escapeHtml(ro.zenumlError)} · ${escapeHtml(reason)}</div>` +
      `<pre class="formula-fallback">${escapeHtml(el.getAttribute("data-code") ?? "")}</pre></div>`;
    el.classList.add("f-error");
  });
}

let chain: Promise<void> = Promise.resolve();

export function renderZenuml(
  scope: HTMLElement,
  themeName?: string,
  opts?: Partial<RenderOptions>,
): Promise<void> {
  const ro = { ...DEFAULT_RENDER_OPTIONS, ...(opts ?? {}) };
  const step = () => doRender(scope, themeName, ro);
  chain = chain.then(step, step);
  return chain;
}

async function doRender(scope: HTMLElement, themeName: string | undefined, ro: RenderOptions): Promise<void> {
  const els = [...scope.querySelectorAll<HTMLElement>("[data-mermaid][data-zuml]")];
  if (!els.length) return;
  let Z: new (el: HTMLElement | string, naked?: boolean, initial?: object) => ZumlEngine;
  try {
    const mod = await import("@zenuml/core") as Record<string, unknown>;
    const cand = (mod.ZenUml ?? (mod.default as Record<string, unknown> | undefined)?.ZenUml ?? mod.default) as unknown;
    // 内部标记错误（catch 后全部走退化框，不上屏）：固定英文技术串，不进 i18n
    if (typeof cand !== "function") throw new Error("Invalid ZenUML module export");
    Z = cand as typeof Z;
  } catch {
    for (const el of els) if (el.isConnected) fallbackBox(el, ro.zenumlLoadError, ro);
    return;
  }
  const theme = themeFor(themeName);
  for (const el of els) {
    if (!el.isConnected) return;
    // 剥掉路由用的 `zenuml` 关键字行，其余原样交给引擎（title/嵌套块等 PlantUML 风语法）
    const code = (el.getAttribute("data-code") ?? "").replace(/^\s*zenuml[ \t]*\r?\n?/, "");
    try {
      const host = document.createElement("div");
      const z = new Z(host, true, { theme });
      const pr = await z.parse(code);
      if (!pr.pass) {
        const d = pr.errorDetails?.[0];
        fallbackBox(el, d ? ro.zenumlLineColumn(d) : ro.zenumlParseError, ro);
        continue;
      }
      await z.render(code, { theme });
      // 真窗口实测教训（2026-11-16）：getSvg() 返回的是 data:image/svg+xml URI 字符串
      // 而非 SVG 标记——直接 innerHTML 会糊出两万字乱码。正解：从挂载 host 里取引擎
      // 渲染出的真实 <svg> DOM；host 无 svg 时才退回 data-URI→<img>（CSP img-src data: 允许）。
      const liveSvg = host.querySelector("svg");
      let markup = liveSvg ? liveSvg.outerHTML : host.innerHTML.trim();
      if (!markup.startsWith("<svg") && !markup.startsWith("<svg ")) {
        const uri = await z.getSvg();
        markup = `<img src="${escapeHtml(uri)}" alt="${escapeHtml(ro.zenumlAlt)}" style="max-width:100%">`;
      }
      if (!el.isConnected) return;
      compensateAnchor(() => {
        el.innerHTML = markup;
        el.classList.add("f-ready");
        el.classList.remove("f-error");
      });
    } catch (e) {
      fallbackBox(el, ro.zenumlRenderError, ro);
    }
  }
}
