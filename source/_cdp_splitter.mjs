// 分隔条实机核对：拖动 / 双击回默认 / 键盘步进 / 偏好落盘与重启恢复
// 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动 folio-app.exe
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const problems = [];
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => pending.set(i, { res, rej })); };
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
  else if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails.exception?.description ?? "异常"); };
await new Promise(r => ws.onopen = r);
await send("Runtime.enable"); await send("Page.enable");
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const run = async (e, ap = false) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: ap });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 240));
  return r.result?.value;
};
const shot = async (n) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  (await import("node:fs")).writeFileSync(`_split_${n}.png`, Buffer.from(data, "base64"));
  console.log("  📄", `_split_${n}.png`);
};
const W = `getComputedStyle(document.querySelector(".side")).width`;
// 注意：这个表达式会被塞进对象字面量里，必须自带 await 语义 → 用同步读缓存的方式拿不到，
// 所以改成每次都单独求值（顶层 awaitPromise），不要再嵌进对象里（嵌进去会被序列化成 {}）
const savedNow = () => run(`(async () => (await window.__TAURI_INTERNALS__.invoke("get_settings")).sideWidth)()`, true);

for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(900);

console.log("=== 起点 ===");
console.log(await run(`({ side宽: ${W}, splitter存在: !!document.querySelector(".splitter"),
  持久值: null, aria: document.querySelector(".splitter")?.getAttribute("aria-valuenow") })`));
console.log("重启前已存的 sideWidth:", await savedNow());

console.log("\n=== 1) 拖动 +140px ===");
await run(`(() => {
  const el = document.querySelector(".splitter");
  const r = el.getBoundingClientRect();
  const x0 = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x0, clientY: y, button: 0, bubbles: true }));
  for (let d = 20; d <= 140; d += 20) {
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 + d, clientY: y, buttons: 1, bubbles: true }));
  }
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: x0 + 140, clientY: y, bubbles: true }));
  return { 起点: x0 };
})()`);
await wait(600);
console.log(await run(`({ side宽: ${W}, resizing类残留: !!document.querySelector(".win.resizing"),
  toast: document.querySelector(".toast")?.innerText ?? null })`), "已存:", await savedNow());
await shot("dragged");

console.log("\n=== 2) 键盘：聚焦后 →→（步长 16）与 Home ===");
await run(`document.querySelector(".splitter").focus()`);
await run(`document.querySelector(".splitter").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))`);
await wait(200);
await run(`document.querySelector(".splitter").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",shiftKey:true,bubbles:true}))`);
await wait(400);
console.log("→ + Shift→ 后:", await run(`({ side宽: ${W} })`), "已存:", await savedNow());
await run(`document.querySelector(".splitter").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}))`);
await wait(400);
console.log("Home 后:", await run(`({ side宽: ${W} })`), "已存:", await savedNow());

console.log("\n=== 3) 双击回默认 ===");
await run(`(() => { const el = document.querySelector(".splitter");
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return 1; })()`);
await wait(400);
console.log(await run(`({ side宽: ${W} })`), "已存:", await savedNow());

console.log("\n=== 4) 拖宽后重启（刷新页面）看恢复 ===");
await run(`(() => {
  const el = document.querySelector(".splitter");
  const r = el.getBoundingClientRect();
  const x0 = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x0, clientY: y, button: 0, bubbles: true }));
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 + 90, clientY: y, buttons: 1, bubbles: true }));
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: x0 + 90, clientY: y, bubbles: true }));
  return 1;
})()`);
await wait(500);
const beforeReload = await run(`({ side宽: ${W} })`); beforeReload.已存 = await savedNow();
console.log("刷新前:", beforeReload);
await send("Page.reload", { ignoreCache: false });
for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(1200);
console.log("刷新后:", await run(`({ side宽: ${W} })`), "已存:", await savedNow());
await shot("restored");

console.log("\n=== 5) 专注模式下分隔条应隐藏 ===");
await run(`(() => { const b=[...document.querySelectorAll(".tbar button,.rail button,button")].find(x=>(x.title||"").includes("专注")); if(b) b.click(); return !!b; })()`);
await wait(500);
console.log(await run(`({ 专注类: document.querySelector(".win").classList.contains("focus"),
  分隔条可见: document.querySelector(".splitter")?.offsetParent !== null,
  侧栏可见: document.querySelector(".side")?.offsetParent !== null })`));
await run(`document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`);
await wait(400);

console.log("\n异常:", problems.length ? problems.slice(0, 6).join("\n") : "无");
ws.close(); process.exit(0);
