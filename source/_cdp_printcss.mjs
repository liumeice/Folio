// 诊断：print 介质下滚动链每一环的 computed 样式，找裁掉正文的那一环。
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = Number(process.env.PERF_PORT || 9223);
const EXE = String.raw`d:\AIProject\Folio\source\target\release\folio-app.exe`;
const FIX = String.raw`d:\AIProject\Folio\source\_tmp_pdfexport_fixture.md`;
const killAll = () => { try { execSync("taskkill /IM folio-app.exe /F >NUL 2>NUL", { stdio: "ignore" }); } catch {} };
class Cdp {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); }
  async open() {
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); h(m); } };
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; }
}
async function findPage() { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(400) }); const l = await r.json(); return l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url)) || null; } catch { return null; } }

killAll(); await sleep(600);
spawn(EXE, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } }).unref();
let target = null;
for (let i = 0; i < 80; i++) { target = await findPage(); if (target) break; await sleep(300); }
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
for (let i = 0; i < 60; i++) { if (await cdp.eval(`!!document.querySelector('.win')`)) break; await sleep(250); }
await cdp.eval(`(async()=>{await window.__TAURI_INTERNALS__.invoke('open_doc',{path:${JSON.stringify(FIX)}});return 1})()`);
await sleep(1200);

console.log(await cdp.eval(`(() => {
  const probe = () => ['#root','.win','.body','.center','.view','article.prose'].map(sel => {
    const el = sel === '#root' ? document.getElementById('root') : document.querySelector(sel);
    if (!el) return sel + ': MISSING';
    const cs = getComputedStyle(el);
    return sel + ': disp=' + cs.display + ' pos=' + cs.position + ' h=' + cs.height + ' minH=' + cs.minHeight + ' maxH=' + cs.maxHeight
      + ' ovf=' + cs.overflow + ' rect=' + Math.round(el.getBoundingClientRect().height) + ' scroll=' + el.scrollHeight;
  }).join('\\n') + '\\nbody: ovf=' + getComputedStyle(document.body).overflow + ' h=' + getComputedStyle(document.body).height
    + ' | html: h=' + getComputedStyle(document.documentElement).height
    + ' | viewport=' + innerWidth + 'x' + innerHeight + ' | matchMedia print=' + matchMedia('print').matches
    + ' | sheets=' + document.styleSheets.length;
  const before = probe();
  return '【screen】\\n' + before;
})()`));

await cdp.send("Emulation.setEmulatedMedia", { media: "print" });
await sleep(300);
console.log(await cdp.eval(`(() => {
  const probe = () => ['#root','.win','.body','.center','.view','article.prose'].map(sel => {
    const el = sel === '#root' ? document.getElementById('root') : document.querySelector(sel);
    if (!el) return sel + ': MISSING';
    const cs = getComputedStyle(el);
    return sel + ': disp=' + cs.display + ' pos=' + cs.position + ' h=' + cs.height + ' minH=' + cs.minHeight + ' maxH=' + cs.maxHeight
      + ' ovf=' + cs.overflow + ' rect=' + Math.round(el.getBoundingClientRect().height) + ' scroll=' + el.scrollHeight;
  }).join('\\n');
  const anyPrintRule = [...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => r.media && [...r.media].join(',').includes('print')); } catch { return false; } });
  const bc = getComputedStyle(document.body), hc = getComputedStyle(document.documentElement);
  const docRect = document.body.getBoundingClientRect().height;
  return '【print 模拟】\\n' + probe() + '\\nbody: disp=' + bc.display + ' h=' + bc.height + ' ovf=' + bc.overflow + ' rect=' + Math.round(docRect)
    + ' | html: h=' + hc.height + ' ovf=' + hc.overflow
    + '\\n含 print 规则表=' + anyPrintRule + ' | matchMedia print=' + matchMedia('print').matches
    + '\\nsheets: ' + [...document.styleSheets].map((ss, i) => { try { return i + ':' + (ss.href ? ss.href.split('/').pop() : 'inline') + '(' + ss.cssRules.length + '条,disabled=' + ss.disabled + ')'; } catch { return i + ':?'; } }).join('  ');
})()`));
await cdp.send("Emulation.setEmulatedMedia", { media: "" });
killAll(); await sleep(400);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
console.log("done（现场已恢复）");
