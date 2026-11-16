/* 搜索弹层加宽实机核对（2026-11-16：640→760）：
 * Ctrl+F 开层 → .pal 宽度、pal-foot 各 span 是否同一行（top 一致、foot 不溢出 38px）、截图。 */
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
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
const run = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 240));
  return r.result?.value;
};
const shot = async (n) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  (await import("node:fs")).writeFileSync(`_pal_${n}.png`, Buffer.from(data, "base64"));
  console.log("  📄", `_pal_${n}.png`);
};

for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(800);
await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'f', ctrlKey:true, bubbles:true}))`);
await wait(500);
console.log(await run(`(() => {
  const pal = document.querySelector('.pal');
  const foot = document.querySelector('.pal-foot');
  if (!pal || !foot) return { 打开: false };
  const spans = [...foot.querySelectorAll(':scope > span')].filter(s => s.textContent.trim() || s.querySelector('kbd'));
  const tops = spans.map(s => Math.round(s.getBoundingClientRect().top));
  const fr = foot.getBoundingClientRect();
  return {
    打开: true,
    弹层宽: Math.round(pal.getBoundingClientRect().width),
    foot高: Math.round(fr.height),
    foot可见高: foot.clientHeight,
    同一行: new Set(tops).size === 1,
    各spanTop: tops,
    右侧状态文本: (foot.lastElementChild?.textContent || '').trim().slice(0, 40),
  };
})()`));
await shot("foot");
console.log("控制台异常:", problems.length ? problems : "无");
ws.close();
