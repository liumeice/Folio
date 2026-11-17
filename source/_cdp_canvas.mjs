// 证实：画布深色来自 html 的非打印背景（index.html #080D18）。
// 实验：揭幕后导出（复现用户场景）→ html 加内联白背景再导出 → 对比深色填充数。
import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = 9228;
const EXE = String.raw`d:\AIProject\Folio\source\target\release\folio-app.exe`;
const FIX = String.raw`D:\AIProject\CC-DOCS-MD\docs\1. 快速入门\4. 平台与集成\16. Visual Studio Code.md`;
const OUT1 = String.raw`d:\AIProject\Folio\source\_canvas_a.pdf`;
const OUT2 = String.raw`d:\AIProject\Folio\source\_canvas_b.pdf`;
const killAll = () => { try { execSync("taskkill /IM folio-app.exe /F >NUL 2>NUL", { stdio: "ignore" }); } catch {} };
class Cdp {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); }
  async open() { await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); h(m); } }; }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result?.value; }
}
async function findPage() { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(400) }); const l = await r.json(); return l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url)) || null; } catch { return null; } }
function darkCount(path) {
  const buf = readFileSync(path);
  const raw = buf.toString("latin1");
  let all = "", i = 0;
  while ((i = raw.indexOf("stream", i)) >= 0) {
    const nl = raw[i + 6] === "\r" ? i + 8 : i + 7;
    const end = raw.indexOf("endstream", nl);
    if (end < 0) break;
    try { all += zlib.inflateSync(buf.subarray(nl, end)).toString("latin1") + "\n"; } catch {}
    i = end + 9;
  }
  let dark = 0, white = 0;
  for (const m of all.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)) {
    const hex = [m[1], m[2], m[3]].map(Number).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    if (hex === "080d18") dark++;
    if (hex === "ffffff") white++;
  }
  return { dark, white };
}

killAll(); await sleep(700);
spawn(EXE, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } }).unref();
let target = null;
for (let i = 0; i < 80; i++) { target = await findPage(); if (target) break; await sleep(300); }
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
for (let i = 0; i < 60; i++) { if (await cdp.eval(`!!document.querySelector('.win')`)) break; await sleep(250); }
await cdp.eval(`(async()=>{try{await window.__TAURI_INTERNALS__.invoke('open_doc',{path:${JSON.stringify(FIX)}})}catch(e){}})()`);
await sleep(7000); // 揭幕彻底完成（复现用户手动导出的状态）
console.log("splash 在 DOM:", await cdp.eval(`!!document.getElementById('boot-splash')`));

// 实验 A：现状导出
await cdp.eval(`(async()=>{try{await window.__TAURI_INTERNALS__.invoke('export_pdf',{path:${JSON.stringify(OUT1)}});return 'ok'}catch(e){return 'err:'+String(e)}})()`);
console.log("A·现状:", JSON.stringify(darkCount(OUT1)));

// 实验 B：html 内联白背景（所有介质通吃）再导出
await cdp.eval(`document.documentElement.style.background='#fff'; 'set'`);
await cdp.eval(`(async()=>{try{await window.__TAURI_INTERNALS__.invoke('export_pdf',{path:${JSON.stringify(OUT2)}});return 'ok'}catch(e){return 'err:'+String(e)}})()`);
console.log("B·html内联白背景:", JSON.stringify(darkCount(OUT2)));

killAll(); await sleep(400);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
console.log("done（现场已恢复）");
