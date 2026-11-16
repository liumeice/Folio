const l = await (await fetch("http://127.0.0.1:9223/json")).json();
const ws = new WebSocket(l.find(t => t.type === "page").webSocketDebuggerUrl);
let id = 0; const p = new Map();
const send = (m, pr = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: pr })); return new Promise(r => p.set(i, r)); };
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); } };
await new Promise(r => ws.onopen = r);
await send("Runtime.enable");
const wait = ms => new Promise(r => setTimeout(r, ms));
const run = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
for (let i = 0; i < 40; i++) { if (await run(`document.querySelector(".brand-chip")?.textContent || ""`)) break; await wait(300); }
console.log("chip:", JSON.stringify(await run(`document.querySelector(".brand-chip").textContent`)));
ws.close();
