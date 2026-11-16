// 复现取证：进编辑 → 改一字 → 点「放弃修改」→ 检查顶部控件活性/DOM 形态 + 控制台异常 + 截图
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const events = [];
function send(m, p = {}) { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res) => pend.set(i, res)); }
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method) events.push(m);
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send("Runtime.enable"); await send("Page.enable"); await send("Log.enable");
const E = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SNAP = `(() => JSON.stringify({
  editChipActive: !!document.querySelector('.tb-seg .on, .seg .on, [class*=seg] .on'),
  chips: [...document.querySelectorAll('.togs *, .tb button, .tb [role=button]')].filter(e=>['阅读','编辑'].includes(e.textContent.trim())).map(e=>e.textContent.trim()+':'+e.className).join(' | '),
  editorWrap: !!document.querySelector('.editor-wrap'),
  cmContent: !!document.querySelector('.cm-content'),
  paneBar: (()=>{const p=document.querySelector('.pane-bar'); return p?getComputedStyle(p).display+'/'+p.getBoundingClientRect().height:'missing';})(),
  crumbBar: (()=>{const c=document.querySelector('.crumb-bar'); return c?getComputedStyle(c).display+'/'+c.getBoundingClientRect().height:'missing';})(),
  tabRow: (()=>{const t=document.querySelector('.tabs'); return t?getComputedStyle(t).display+'/'+t.getBoundingClientRect().height:'missing';})(),
  titlebar: (()=>{const t=document.querySelector('#menubar')?.closest('header, .tb, [class*=title]'); const h=document.querySelector('.tb'); return h?h.getBoundingClientRect().height:'?';})(),
  bodyH: document.body.getBoundingClientRect().height,
  centerChildren: [...document.querySelector('.center').children].map(e=>e.className||e.tagName).join(','),
  readerVisible: (()=>{const r=document.querySelector('#scroll-area'); return r?getComputedStyle(r).display+'/'+getComputedStyle(r).opacity:'missing';})(),
}))()`;

console.log("STEP0 (阅读态):", await E(SNAP));

// 1) 点「编辑」chip
await E(`(() => { const b=[...document.querySelectorAll('button,[role=button],.togs *')].find(e=>e.textContent.trim()==='编辑'); if(b) b.click(); return !!b; })()`);
await sleep(1200);
console.log("STEP1 (进编辑):", await E(SNAP));

// 2) 在 CodeMirror 里插一个字
await E(`(() => { const cm=document.querySelector('.cm-content'); if(!cm) return 'no cm'; cm.focus(); document.execCommand('insertText', false, 'x'); return 'typed'; })()`);
await sleep(400);

// 3) 点「放弃修改」
const disc = await E(`(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('放弃修改')); if(b){b.click(); return 'clicked';} return 'no discard btn: '+[...document.querySelectorAll('button')].map(x=>x.textContent.trim()).filter(t=>t).slice(0,12).join('/'); })()`);
console.log("STEP2 (放弃修改):", disc);
await sleep(1500);
console.log("STEP3 (返回后):", await E(SNAP));

// 4) 顶部活性：点一次「大纲」rail 钮看 side 是否切换
const react = await E(`(() => {
  const before=(document.querySelector('.side')?.textContent||'').slice(0,20);
  const b=[...document.querySelectorAll('.rail .ri')].find(x=>(x.title||'').startsWith('大纲'));
  if(b) b.click();
  return new Promise(r=>setTimeout(()=>r(JSON.stringify({before, after:(document.querySelector('.side')?.textContent||'').slice(0,20), changed:(document.querySelector('.side')?.textContent||'')!==before})),500));
})()`);
console.log("STEP4 (rail 反应):", react);

const errs = events.filter((e) => e.method === "Runtime.exceptionThrown" || e.method === "Log.entryAdded" || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"));
console.log("EXCEPTIONS:", errs.length);
for (const e of errs.slice(0, 8)) {
  if (e.method === "Runtime.exceptionThrown") console.log("EXC:", (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text || "").split("\n").slice(0, 4).join(" ⏎ "));
  else if (e.method === "Log.entryAdded") console.log("LOG:", e.params.entry.text.slice(0, 200));
  else console.log("CON:", e.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
}
const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync(new URL("../artifacts/formula-smoke/_repro_shot.png", import.meta.url), Buffer.from(shot.data, "base64"));
console.log("shot → _repro_shot.png");
ws.close(); process.exit(0);
