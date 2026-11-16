// 炸弹图回归实测：打开样张 → 切主题触发重渲 → 确认正文永不出现 "Syntax error in text"
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const events = [];
function send(m, p = {}) { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pend.set(i, r)); }
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) events.push(m);
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send("Runtime.enable"); await send("Page.enable");
const E = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHECK = `(() => {
  const art = document.querySelector('#scroll-area article');
  return JSON.stringify({
    theme: document.documentElement.dataset.theme,
    bomb: art ? art.textContent.includes('Syntax error in text') : null,
    bodyBomb: document.body.textContent.includes('Syntax error in text'),
    leftover: document.querySelectorAll('body > [id^="folio-mmd-"]').length,
    menuTop: (()=>{const m=document.querySelector('#menubar');const b=m&&m.getBoundingClientRect();return b?Math.round(b.top):null;})(),
    boxes: art ? art.querySelectorAll('.fb-box').length : 0,
    mermaidOk: art ? art.querySelectorAll('[data-mermaid].f-ready svg').length : 0,
    mathErr: art ? art.querySelectorAll('[data-math].f-error').length : 0,
    mathOk: art ? art.querySelectorAll('[data-math].f-ready').length : 0,
  });
})()`;
const clickTheme = (label) => E(`(() => {
  const b=[...document.querySelectorAll('#titlebar [title], .tb [title]')].find(e=>(e.title||'').includes('设置'));
  if(b) b.click();
  return new Promise(res=>setTimeout(()=>{
    const card=[...document.querySelectorAll('.thc')].find(c=>(c.getAttribute('title')||'').includes(${JSON.stringify(label)}));
    if(card) card.click();
    setTimeout(()=>res(!!card), 1200);
  }, 600));
})()`);

await sleep(1500);
console.log("T0 首开:", await E(CHECK));
console.log("切浅色:", await clickTheme("浅色"));
await sleep(2500);
console.log("T1 浅色重渲后:", await E(CHECK));
console.log("切回深色:", await clickTheme("深色"));
await sleep(2500);
console.log("T2 深色重渲后:", await E(CHECK));
await E(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("d:/AIProject/Folio/artifacts/formula-smoke/_bomb_fixed.png", Buffer.from(shot.result.data, "base64"));
console.log("异常数:", events.filter((e) => e.method === "Runtime.exceptionThrown").length, "| shot → _bomb_fixed.png");
ws.close(); process.exit(0);
