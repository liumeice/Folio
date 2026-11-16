const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errors = [];
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description || "").split("\n")[0]);
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send("Runtime.enable"); await send("Page.enable");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
const fs = await import("node:fs");
const shot = async (n) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync("sync_" + n + ".png", Buffer.from(s.data, "base64")); };

await wait(1800);

// 1) 大纲层级缩进：不同 level 的 padding-left
console.log("indent:", await ev(`JSON.stringify([...document.querySelectorAll('.out-body .ol')].slice(0,8).map(b=>({cls:b.className.replace('ol','').trim()||'h1',pl:getComputedStyle(b).paddingLeft})))`));
await shot("1-indent");

// 2) 阅读滚到中部 → 记 §
await ev(`(()=>{const v=document.querySelector('.view');v.scrollTop=2200;return v.scrollTop})()`);
await wait(700);
const secBefore = await ev(`document.querySelector('#stat-sec')?.textContent.trim()`);
console.log("read §:", secBefore);

// 3) 进编辑 → 编辑器应落在同区段（滚动同步进入）
await ev(`[...document.querySelectorAll('.seg button')][1].click()`);
await wait(1000);
console.log("edit scrollerTop:", await ev(`Math.round(document.querySelector('.cm-scroller')?.scrollTop ?? -1)`));
console.log("edit topLine:", await ev(`document.querySelector('.cm-gutter-lineno .cm-gutter-element')?.textContent`));
await shot("2-edit");

// 4) 编辑态点大纲第 6 条 → 编辑器跳转 + activeSec 跟随 + 顶行文本必须命中该章节标题
const clicked = await ev(`(()=>{const bs=[...document.querySelectorAll('.out-body .ol')];
 const b=bs[Math.min(5,bs.length-1)];window.__tsec=b.getAttribute('data-ol-sec');window.__ttext=b.textContent.trim();b.click();return window.__tsec+"|"+window.__ttext.slice(0,16)})()`);
await wait(900);
console.log("clicked:", clicked);
console.log("landing:", await ev(`(()=>{const sc=document.querySelector('.cm-scroller');
 const r=sc.getBoundingClientRect();
 const line=[...document.querySelectorAll('.cm-content .cm-line')].find(l=>{const b=l.getBoundingClientRect();return b.top>=r.top-1&&b.bottom>r.top+2;});
 return JSON.stringify({topLineText:(line?.textContent||"").slice(0,20),
   headingMatch:(line?.textContent||"").includes((window.__ttext||"#").slice(0,12)),
   activeOl:document.querySelector('.ol.on')?.getAttribute('data-ol-sec'),
   want:window.__tsec})})()`));

// 5) 放弃修改 → 阅读视图应停在大纲指向的章节附近（同步返回）
await ev(`[...document.querySelectorAll('.editor-bar .btn')].find(b=>b.textContent.includes('放弃修改')).click()`);
await wait(900);
const back = await ev(`(()=>{const v=document.querySelector('.view');const hs=[...document.querySelectorAll('.prose h1,.prose h2,.prose h3,.prose h4,.prose h5,.prose h6')];const h=hs.find(x=>x.getAttribute('data-sec')==='6');return JSON.stringify({viewTop:Math.round(v.scrollTop),h6Top:h?Math.round(h.offsetTop):null})})()`);
console.log("back to read:", back);
await shot("3-back");
console.log("ERRORS:", errors.length ? errors.slice(0, 4) : "none");
ws.close(); process.exit(0);
