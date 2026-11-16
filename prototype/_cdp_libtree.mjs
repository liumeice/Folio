// 文档库树视觉核对：连 headless Edge，切到文档库/最近打开，截侧栏 + 抽查关键状态
import fs from "fs";
const PORT = process.env.PORT || 9414;
const URL_ = "file:///d:/aiprogram/Folio/prototype/prototype.html";

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = j.find(t => t.type === "page" && /prototype\.html/.test(t.url));
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
await send("Runtime.enable");
const run = async e => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true }); if (r.exceptionDetails) return "<err " + JSON.stringify(r.exceptionDetails.exception?.description || "").slice(0, 200) + ">"; return r.result?.value; };

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await new Promise(r => setTimeout(r, 800));

async function shot(name) {
  const rect = await run(`(()=>{const r=document.getElementById("side").getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`);
  const c = JSON.parse(rect);
  const s = await send("Page.captureScreenshot", { format: "png", clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 } });
  fs.writeFileSync(`_shot_${name}.png`, Buffer.from(s.data, "base64"));
  console.log("saved _shot_" + name + ".png", c.w + "x" + c.h);
}

// 切到浅色 + 文档库
await run(`document.querySelector(".app").dataset.theme="light"; "ok"`);
await run(`$("rail-lib").click(); "ok"`);
await new Promise(r => setTimeout(r, 400));
console.log("chip:", await run(`JSON.stringify({rp:document.querySelector(".root-chip .rp").textContent, acts:document.querySelectorAll(".side-title .act").length, racts:document.querySelectorAll(".ract").length})`));
console.log("tree:", await run(`JSON.stringify([...document.querySelectorAll("#lib-list .tf")].map(e=>({t:e.querySelector(".nm").textContent,d:e.style.paddingLeft||getComputedStyle(e).paddingLeft,vis:e.style.display!=="none",dir:e.classList.contains("dir")})))`));
await shot("lib-default");

// 全部展开
await run(`$("lib-expand").click(); "ok"`);
await new Promise(r => setTimeout(r, 300));
console.log("expanded rust visible:", await run(`document.querySelector('#lib-list .tf[data-doc="rust"]').style.display !== "none"`));
await shot("lib-expanded");

// 筛选 notes（平铺态）
await run(`$("lib-search").value="notes"; $("lib-search").dispatchEvent(new Event("input")); "ok"`);
await new Promise(r => setTimeout(r, 300));
console.log("filter:", await run(`JSON.stringify([...document.querySelectorAll("#lib-list .tf")].filter(e=>e.style.display!=="none").map(e=>({t:e.querySelector(".nm").textContent,pl:e.style.paddingLeft,sd:getComputedStyle(e.querySelector(".src-dir")).display})))`));
await shot("lib-filter");
await run(`$("lib-search").value=""; $("lib-search").dispatchEvent(new Event("input")); "ok"`);

// 最近打开
await run(`$("rail-history").click(); "ok"`);
await new Promise(r => setTimeout(r, 400));
console.log("hist:", await run(`JSON.stringify({heads:[...document.querySelectorAll("#history-list .sec-h")].map(h=>h.textContent.trim()), count:$("hist-count").textContent, rowx:document.querySelectorAll("#history-list .row-x").length})`));
await shot("history");
ws.close(); process.exit(0);
