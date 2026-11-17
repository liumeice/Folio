// 探查正文渲染断点：children/innerHTML/标题数/末尾文本。
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = 9231;
const EXE = String.raw`d:\AIProject\Folio\source\target\release\folio-app.exe`;
const FIX = String.raw`D:\AIProject\CC-DOCS-MD\docs\1. 快速入门\4. 平台与集成\16. Visual Studio Code.md`;
const killAll = () => { try { execSync("taskkill /IM folio-app.exe /F >NUL 2>NUL", { stdio: "ignore" }); } catch {} };
class Cdp {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); }
  async open() { await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); h(m); } }; }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return "EXC:" + JSON.stringify(r.exceptionDetails).slice(0, 200); return r.result?.value; }
}
async function findPage() { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); return l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url)) || null; } catch { return null; } }

killAll(); await sleep(700);
spawn(EXE, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } }).unref();
let target = null;
for (let i = 0; i < 80; i++) { target = await findPage(); if (target) break; await sleep(300); }
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
for (let i = 0; i < 60; i++) { if (await cdp.eval(`!!document.querySelector('.win')`)) break; await sleep(250); }
await cdp.eval(`(async()=>{try{await window.__TAURI_INTERNALS__.invoke('open_doc',{path:${JSON.stringify(FIX)}})}catch(e){}})()`);
await sleep(5000);
console.log(await cdp.eval(`(() => {
  const a = document.querySelector('article.prose');
  if (!a) return 'NO ARTICLE';
  const kids = [...a.children];
  const hs = kids.filter(k => /^H[1-6]$/.test(k.tagName));
  return 'children=' + kids.length + ' innerHTML长=' + (a.innerHTML || '').length + ' 高=' + a.scrollHeight
    + ' 标题数=' + hs.length + '（最后3个: ' + hs.slice(-3).map(k => k.tagName + ':' + k.textContent.slice(0, 20)).join(' | ') + '）'
    + ' 末元素=' + (kids[kids.length - 1]?.tagName || 'none')
    + ' 末尾60字=' + JSON.stringify(a.textContent.slice(-60));
})()`));
console.log("src 长度:", await cdp.eval(`window.__store ? '无 __store' : '（无全局引用，跳过）'`));
killAll(); await sleep(400);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
console.log("done（现场已恢复）");
