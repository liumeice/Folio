// 主题切换 ⇄ mermaid 重渲取证：连 9223 → 读当前图形配色 → 点菜单切主题 → 再读配色 + 截图
// 用法：node _cdp_thememmd.mjs [light|dark|sepia]
const TARGET = process.argv[2] ?? "light";
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send("Runtime.enable");
await send("Page.enable");

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

const SNAP = `(() => {
  const el = document.querySelector("[data-mermaid] svg");
  const box = el && (el.querySelector("rect,polygon") || el);
  const fill = box ? getComputedStyle(box).fill : "(无图)";
  const themeAttr = document.documentElement.getAttribute("data-theme");
  const ready = document.querySelectorAll("[data-mermaid].f-ready svg").length;
  const mathReady = document.querySelectorAll("[data-math].f-ready").length;
  const currency = [...document.querySelectorAll("#scroll-area article p")].some(p => p.textContent.includes("$5 和 $10"));
  return JSON.stringify({ themeAttr, fill, ready, mathReady, currency });
})()`;

console.log("BEFORE:", await evalJs(SNAP));

// 走真实 UI：查看 → 主题▸ → 目标项（标题栏菜单为 div.mn 文本 + 子菜单项）
const clicked = await evalJs(`(async () => {
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find(e => e.textContent.trim() === txt);
  const menuBtn = byText("#menubar *, .mn, .menu-item, .tb-item", "查看");
  if (!menuBtn) return "no 查看 item";
  menuBtn.click();
  await new Promise(r => setTimeout(r, 250));
  const subBtn = byText("*", "主题") ?? [...document.querySelectorAll("div,button,span")].find(e => e.childElementCount === 0 && e.textContent.trim() === "主题");
  if (!subBtn) return "no 主题 item";
  subBtn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  subBtn.click();
  await new Promise(r => setTimeout(r, 250));
  const label = ${JSON.stringify({ light: "浅色", dark: "深色", sepia: "米色" })}[${JSON.stringify(TARGET)}];
  const target = [...document.querySelectorAll("div,button,span")].find(e => e.childElementCount === 0 && e.textContent.trim() === label);
  if (!target) return "no " + label + " item";
  target.click();
  return "clicked " + label;
})()`);
console.log("CLICK:", clicked);

// 等主题落库 + settings 信号传播 + mermaid 重渲链跑完
await new Promise((r) => setTimeout(r, 4500));
console.log("AFTER :", await evalJs(SNAP));

const shot = await send("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
writeFileSync(new URL(`../artifacts/formula-smoke/_shot_${TARGET}.png`, import.meta.url), Buffer.from(shot.data, "base64"));
console.log("shot → artifacts/formula-smoke/_shot_" + TARGET + ".png");
ws.close();
process.exit(0);
