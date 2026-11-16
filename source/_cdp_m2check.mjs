const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errors = [];
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "").split("\n")[0]);
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send("Runtime.enable"); await send("Page.enable");
const fs = await import("node:fs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
const shot = async (n) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`m2_${n}.png`, Buffer.from(s.data, "base64")); };

await wait(1600);
await ev(`document.querySelectorAll('.rail button')[0].click()`);   // 文档库面板
await wait(400);
const tfCount = await ev(`document.querySelectorAll('#lib-list .tf, .side-body .tf').length`);
console.log("lib items:", tfCount);
await ev(`(()=>{const tf=document.querySelectorAll('.tf')[0];
 const r=tf.getBoundingClientRect();
 tf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+40,clientY:r.top+8}));return true})()`);
await wait(300);
console.log("ctx shown:", await ev(`!!document.querySelector('.ctxmenu')`));
await shot("1-ctx");
await ev(`(()=>{const mi=[...document.querySelectorAll('.ctxmenu .mi')].find(x=>x.textContent.includes('置顶'));mi.click();return true})()`);
await wait(600);
console.log("pinned groups:", await ev(`JSON.stringify([...document.querySelectorAll('.sec-h')].map(s=>s.textContent.trim()))`));
console.log("badge:", await ev(`!!document.querySelector('.tf .badge')`));
await shot("2-pinned");
// 还原
await ev(`(()=>{const tf=document.querySelectorAll('.tf')[0];
 const r=tf.getBoundingClientRect();
 tf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+40,clientY:r.top+8}));return true})()`);
await wait(250);
await ev(`(()=>{const mi=[...document.querySelectorAll('.ctxmenu .mi')].find(x=>x.textContent.includes('取消置顶'));mi&&mi.click();return true})()`);
await wait(500);
console.log("after unpin groups:", await ev(`JSON.stringify([...document.querySelectorAll('.sec-h')].map(s=>s.textContent.trim()))`));
console.log("ERRORS:", errors.length ? errors.slice(0, 4) : "none");
ws.close(); process.exit(0);
