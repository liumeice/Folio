// 配置窗口头部视觉核对：用法 node _cdp_cfhead.mjs <url> <outname> [前置JS表达式]
import fs from "fs";
const PORT = process.env.PORT || 9414;
const URL_ = process.argv[2];
const NAME = process.argv[3] || "cfg-head";
const PRE = process.argv[4] || "";

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = j.find(t => t.type === "page" && t.url.includes(URL_.split("/").pop()))
             || j.find(t => t.type === "page");
      if (p) return p;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("no page target");
}
const tp = await getTarget();
const ws = new WebSocket(tp.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
await new Promise(r => (ws.onopen = r));
await send("Runtime.enable"); await send("Page.enable");
if (tp.url !== URL_) { await send("Page.navigate", { url: URL_ }); await new Promise(r => setTimeout(r, 1500)); }
await send("Emulation.setDeviceMetricsOverride", { width: 1496, height: 900, deviceScaleFactor: 1, mobile: false });
const run = async e => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true }); if (r.exceptionDetails) return "<err " + (r.exceptionDetails.exception?.description || "").slice(0, 160) + ">"; return r.result?.value; };
if (PRE) console.log("pre:", await run(PRE));
await new Promise(r => setTimeout(r, 500));
const info = await run(`JSON.stringify((()=>{const h=document.querySelector(".st-head");if(!h)return null;const r=h.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,btns:[...h.querySelectorAll(".btn,.iconbtn")].map(b=>({id:b.id,txt:b.textContent.trim(),cls:b.className}))}})())`);
console.log("head:", info);
const c = JSON.parse(info);
const s = await send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, c.x), y: Math.max(0, c.y - 8), width: c.w, height: c.h + 16, scale: 2 } });
fs.writeFileSync(`_shot_${NAME}.png`, Buffer.from(s.data, "base64"));
console.log("saved _shot_" + NAME + ".png");
ws.close(); process.exit(0);
