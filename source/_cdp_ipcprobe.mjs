// 启动诊断探针 v2：IPC 时序（defineProperty 拦截 __TAURI_INTERNALS__）+ CPU Profiler 归因。
// 用法：node _cdp_ipcprobe.mjs   （PERF_EXE / PERF_PORT 同 _cdp_perf3.mjs）
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = Number(process.env.PERF_PORT || 9343), EXE = process.env.PERF_EXE || String.raw`D:\aiprogram\Folio\source\target\release\folio-app.exe`;
let child = null; const kill = () => { try { child?.kill(); } catch {} try { execSync("taskkill /IM folio-app.exe /F >NUL 2>NUL", { stdio: "ignore" }); } catch {} };
class Cdp {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); }
  async open() {
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    };
  }
  send(m, pa = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method: m, params: pa })); return new Promise((res, rej) => this.p.set(id, { res, rej })); }
  async eval(x) { const r = await this.send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); return r.result?.value; }
}
// 只认已导航到 tauri.localhost 的 target：冷启动窗口短暂停留在 about:blank，抓它会得到假阴性空页面
async function findPage() { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(400) }); const l = await r.json(); return l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url)) || null; } catch { return null; } }

const INJECT = `(() => {
  window.__pf={ipc:[],longtasks:[],chrome:null,doc:null,docPaint:null,patched:false};
  new PerformanceObserver((l)=>{for(const e of l.getEntries())if(e.duration>50)window.__pf.longtasks.push(Math.round(e.startTime)+'~'+Math.round(e.startTime+e.duration)+' ='+Math.round(e.duration)+'ms');}).observe({type:'longtask',buffered:true});
  const wrap=(t)=>{
    if(!t||typeof t.invoke!=='function'||t.__pfPatched)return false;
    const orig=t.invoke.bind(t);
    t.invoke=function(cmd,args,opts){
      const e={cmd,t0:Math.round(performance.now())};
      window.__pf.ipc.push(e);
      const r=orig(cmd,args,opts);
      if(r&&typeof r.then==='function')r.then(()=>{e.dur=Math.round(performance.now()-e.t0);},err=>{e.dur=Math.round(performance.now()-e.t0);e.err=1;});
      return r;
    };
    t.__pfPatched=true;return true;
  };
  // 三条路全堵：①已存在直接包 ②普通赋值走 setter ③wry 用 defineProperty({value}) 绕过 setter → 钩住 defineProperty 本身
  if(!wrap(window.__TAURI_INTERNALS__)){
    let v=window.__TAURI_INTERNALS__;
    try{
      const d=Object.defineProperty;
      Object.defineProperty=function(o,k,desc){
        if(o===window&&k==='__TAURI_INTERNALS__'&&desc&&'value' in desc){window.__pf.patched=wrap(desc.value);return d.call(this,o,k,{...desc});}
        return d.call(this,o,k,desc);
      };
      Object.defineProperty(window,'__TAURI_INTERNALS__',{
        configurable:true,
        get(){return v;},
        set(nv){v=nv;window.__pf.patched=wrap(nv);}
      });
    }catch{}
  }
  const tick=()=>{
    if(!window.__pf.chrome&&document.querySelector('.win'))window.__pf.chrome=Math.round(performance.now());
    if(!window.__pf.doc&&document.querySelector('article.prose .sub')){
      window.__pf.doc=Math.round(performance.now());
      requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__pf.docPaint=Math.round(performance.now());}));return;
    }
    if(!window.__pf.docPaint)setTimeout(tick,8);
  }; tick();
})();`;

kill(); await sleep(400);
const t0 = Date.now();
child = spawn(EXE, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }, stdio: "ignore" });
let page = null; while (Date.now() - t0 < 20000) { page = await findPage(); if (page) break; await sleep(10); }
const targetMs = Date.now() - t0;
const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open();
await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
// 首轮 boot 导航完成后再 reload（防打断进行中的加载 → 白页假阴性）
while (Date.now() - t0 < 20000) { if (await cdp.eval("document.readyState==='complete'&&!!document.querySelector('.win')") === true) break; await sleep(50); }
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 150 });
await cdp.send("Profiler.start");
await cdp.send("Page.reload", { ignoreCache: false });
await sleep(4500);
const prof = await cdp.send("Profiler.stop");
const out = JSON.parse(await cdp.eval(`JSON.stringify({pf:window.__pf,paints:Object.fromEntries(performance.getEntriesByType('paint').map(p=>[p.name,Math.round(p.startTime)]))})`));
// 聚合 CPU profile：self time by node，取窗口 200ms~doc 之间
const nodes = new Map(prof.profile.nodes.map(n => [n.id, n]));
const selfMs = new Map();
const { samples, timeDeltas } = prof.profile; // µs
for (let i = 0; i < samples.length; i++) {
  const n = nodes.get(samples[i]); if (!n) continue;
  const f = n.callFrame;
  const key = `${f.functionName || "(anon)"} @ ${(f.url || "").split(/[\\\\/]/).pop()}:${f.lineNumber}`;
  selfMs.set(key, (selfMs.get(key) || 0) + (timeDeltas[i] || 0) / 1000);
}
const top = [...selfMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${v.toFixed(1)}ms ${k}`);
// 同名 minify 函数按 position 细分（applyNav 与 hl 都叫 u）
const uf = new Map();
for (let i = 0; i < samples.length; i++) {
  const n = nodes.get(samples[i]); if (!n) continue;
  const f = n.callFrame;
  if (!/index-[A-Za-z0-9]+\.js/.test(f.url || "") || !["u", "i", "r", "c", "d", "p"].includes(f.functionName)) continue;
  const key = `${f.functionName}@pos${f.positionId ?? f.columnNumber}:${f.lineNumber}`;
  uf.set(key, (uf.get(key) || 0) + (timeDeltas[i] || 0) / 1000);
}
const uTop = [...uf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${v.toFixed(1)}ms ${k}`);
console.log(JSON.stringify({ targetMs, ...out, topSelf: top, namedFrames: uTop }, null, 1));
try { cdp.ws.close(); } catch {} kill();
