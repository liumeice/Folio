// 多态 UI 巡检：首页 → 搜索面板(空/结果/跳转+浮动条) → 排版弹层 → 关于
// 每态截图 + 关键几何断言；对照原型视觉基线。
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

async function ev(expr, awaitP = false) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: awaitP });
  return r.result?.value;
}
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`ui_${name}.png`, Buffer.from(s.data, "base64"));
  console.log("shot:", name);
}

// 1 首页
await wait(1500);
await shot("1-home");

// 2 搜索面板（空态）——点 rail 搜索
await ev(`document.querySelectorAll('.rail button')[2].click()`);
await wait(400);
await shot("2-palette-empty");
console.log("pal-rect:", await ev(`(()=>{const b=document.querySelector('.pal').getBoundingClientRect();return JSON.stringify({top:Math.round(b.top),w:Math.round(b.width),ph:document.querySelector('.pal-in input').placeholder})})()`));

// 3 输入结果
await ev(`(()=>{const i=document.querySelector('.pal-in input');i.value='大纲';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await wait(900);
await shot("3-palette-results");
console.log("result-counts:", await ev(`JSON.stringify({hgrp:document.querySelectorAll('#search-results .hgrp').length,hit:document.querySelectorAll('#search-results .hit').length,stat:document.querySelector('.pal-foot span:last-child').textContent})`));

// 4 Enter 跳转 → 高亮 + hitnav
await ev(`document.querySelector('.pal-in input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
await wait(1000);
await shot("4-hitnav");
console.log("hitnav:", await ev(`(()=>{const h=document.querySelector('.hitnav');if(!h||h.hidden)return 'hidden';const b=h.getBoundingClientRect();return JSON.stringify({text:h.textContent.trim().slice(0,30),top:Math.round(b.top),marks:document.querySelectorAll('#article mark.hit').length,cur:!!document.querySelector('mark.hit.cur')})})()`));

// 5 F3 下一处
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'F3',bubbles:true,cancelable:true}))`);
await wait(700);
console.log("after-F3 cur:", await ev(`(()=>{const c=document.querySelector('mark.hit.cur');return c?c.parentElement.parentElement.textContent.slice(0,26):'none'})()`));

// 6 Esc 清除
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
await wait(400);
console.log("after-Esc marks:", await ev(`document.querySelectorAll('#article mark.hit').length`), "hitnav hidden:", await ev(`document.querySelector('.hitnav')?.hidden ?? true`));

// 7 排版弹层
await ev(`document.querySelectorAll('.tbar-right .iconbtn')[3].click()`);
await wait(300);
await shot("5-fontpop");

// 8 关于
await ev(`document.querySelector('#font-pop')?.click();document.body.click()`);
await ev(`(()=>{const b=[...document.querySelectorAll('.menu>b')].find(x=>x.textContent.includes('帮助'));b.click();return true})()`);
await wait(200);
await ev(`(()=>{const mi=[...document.querySelectorAll('.mi')].find(x=>x.textContent.includes('关于 Folio'));mi.click();return true})()`);
await wait(300);
await shot("6-about");
await ev(`document.querySelector('#about-overlay .x').click()`);

console.log("ERRORS:", errors.length ? errors.slice(0, 5) : "none");
ws.close(); process.exit(0);
