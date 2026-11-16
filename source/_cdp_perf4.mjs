// 复测：splash / 首绘 / 文档上屏 / 长任务 / 资源
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = Number(process.env.PERF_PORT || 9341);
const EXE = process.env.PERF_EXE || String.raw`D:\aiprogram\Folio\source\target\release\folio-app.exe`;
let child = null;
const kill = () => { try { child?.kill(); } catch {} try { execSync("taskkill /IM folio-app.exe /F >NUL 2>NUL", { stdio: "ignore" }); } catch {} };
class Cdp {
  constructor(u){ this.ws=new WebSocket(u); this.id=0; this.p=new Map(); }
  async open(){ await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});
    this.ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}}; }
  send(m,pa={}){const id=++this.id;this.ws.send(JSON.stringify({id,method:m,params:pa}));return new Promise((res,rej)=>this.p.set(id,{res,rej}));}
  async eval(x){const r=await this.send("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true});return r.result?.value;}
}
async function findPage(){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`,{signal:AbortSignal.timeout(400)});const l=await r.json();return l.find(t=>t.type==='page')||null;}catch{return null;}}
const INJECT = `(() => {
  window.__pf = { splashGone: null, lumen: null, doc: null, docPaint: null, long: [], lcp: [] };
  try { new PerformanceObserver((l)=>{for(const e of l.getEntries()){window.__pf.long.push({s:Math.round(e.startTime),d:Math.round(e.duration)});}}).observe({type:'longtask',buffered:true}); } catch(e){}
  try { new PerformanceObserver((l)=>{for(const e of l.getEntries())window.__pf.lcp.push({t:Math.round(e.startTime),size:e.size});}).observe({type:'largest-contentful-paint',buffered:true}); } catch(e){}
  const sp = document.getElementById('boot-splash');
  if (sp) new MutationObserver(()=>{ if(sp.classList.contains('gone') && !window.__pf.splashGone) window.__pf.splashGone = Math.round(performance.now()); })
    .observe(sp, { attributes: true, attributeFilter: ['class'] });
  const tick = () => {
    if (!window.__pf.doc && document.querySelector('article.prose .sub')) {
      window.__pf.doc = Math.round(performance.now());
      requestAnimationFrame(()=>requestAnimationFrame(()=>{ window.__pf.docPaint = Math.round(performance.now()); }));
    }
    if (!window.__pf.docPaint) setTimeout(tick, 8);
  }; tick();
})();`;
kill(); await sleep(400);
const t0 = Date.now();
child = spawn(EXE, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }, stdio: "ignore" });
let page=null; while(Date.now()-t0<20000){ page=await findPage(); if(page) break; await sleep(10); }
const targetMs = Date.now()-t0;
const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open();
await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
await cdp.send("Page.reload", { ignoreCache: false });
await sleep(4000);
const out = JSON.parse(await cdp.eval(`JSON.stringify({
  pf: window.__pf, title: document.title,
  splashNow: !!document.getElementById('boot-splash'),
  paints: Object.fromEntries(performance.getEntriesByType('paint').map(p=>[p.name,Math.round(p.startTime)])),
  resources: performance.getEntriesByType('resource').map(r=>({n:r.name.split('/').pop(), s:Math.round(r.startTime), d:Math.round(r.duration)}))
})`));
console.log(JSON.stringify({ targetMs, ...out }, null, 1));
try{cdp.ws.close();}catch{} kill();
