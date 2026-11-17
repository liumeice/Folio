// 找出打印时还在画 #080D18 深色的元素（黑边框元凶点名）。
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = Number(process.env.PERF_PORT || 9225);
const EXE = String.raw`d:\AIProject\Folio\source\target\release\folio-app.exe`;
const FIX = String.raw`D:\AIProject\CC-DOCS-MD\docs\1. 快速入门\4. 平台与集成\16. Visual Studio Code.md`;
const killAll = () => { try { execSync("taskkill /IM folio-app.exe /F >NUL 2>NUL", { stdio: "ignore" }); } catch {} };
class Cdp {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); }
  async open() { await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); h(m); } }; }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result?.value; }
}
async function findPage() { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(400) }); const l = await r.json(); return l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url)) || null; } catch { return null; } }

killAll(); await sleep(700);
spawn(EXE, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } }).unref();
let target = null;
for (let i = 0; i < 80; i++) { target = await findPage(); if (target) break; await sleep(300); }
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
for (let i = 0; i < 60; i++) { if (await cdp.eval(`!!document.querySelector('.win')`)) break; await sleep(250); }
await cdp.eval(`(async()=>{try{await window.__TAURI_INTERNALS__.invoke('open_doc',{path:${JSON.stringify(FIX)}})}catch(e){}})()`);
await sleep(4000); // 等 splash 揭幕完成（5s 兜底之前/之后各看一次）

await cdp.send("Emulation.setEmulatedMedia", { media: "print" });
await sleep(300);
console.log(await cdp.eval(`(() => {
  const dark = 'rgb(8, 13, 24)';
  const hits = [...document.querySelectorAll('html,body,#root,*')].filter(el => {
    const cs = getComputedStyle(el);
    return cs.backgroundColor === dark;
  }).map(el => {
    const cs = getComputedStyle(el);
    return (el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : ''))
      + ' pos=' + cs.position + ' disp=' + cs.display + ' op=' + cs.opacity + ' z=' + cs.zIndex + ' bg=' + cs.backgroundColor;
  });
  const sp = document.getElementById('boot-splash');
  const spcs = sp ? getComputedStyle(sp) : null;
  return '【print 模拟下 bg=#080D18 的元素】\\n' + (hits.join('\\n') || '(无)')
    + '\\n\\nboot-splash: ' + (sp ? ('classList=' + JSON.stringify([...sp.classList]) + ' pos=' + spcs.position + ' disp=' + spcs.display + ' op=' + spcs.opacity + ' bg=' + spcs.backgroundColor) : '不在 DOM')
    + '\\nhtml.bg=' + getComputedStyle(document.documentElement).backgroundColor
    + '\\nbody.bg=' + getComputedStyle(document.body).backgroundColor
    + '\\n#root.bg=' + getComputedStyle(document.getElementById('root')).backgroundColor;
})()`));
await cdp.send("Emulation.setEmulatedMedia", { media: "" });
killAll(); await sleep(400);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
console.log("done（现场已恢复）");
