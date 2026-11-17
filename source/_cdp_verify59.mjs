// 验证 0.2.1.59：白纸边距 + 主题色内容区 + 无 splash 黑框。
import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = 9227;
const EXE = String.raw`d:\AIProject\Folio\source\target\release\folio-app.exe`;
const FIX = String.raw`D:\AIProject\CC-DOCS-MD\docs\1. 快速入门\4. 平台与集成\16. Visual Studio Code.md`;
const OUT = String.raw`d:\AIProject\Folio\source\_verify59.pdf`;
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
await sleep(3000);
console.log("主题:", await cdp.eval(`document.documentElement.dataset.theme`));
const t0 = Date.now();
const ex = await cdp.eval(`(async()=>{try{await window.__TAURI_INTERNALS__.invoke('export_pdf',{path:${JSON.stringify(OUT)}});return 'ok'}catch(e){return 'err:'+String(e)}})()`);
console.log("导出:", ex, Date.now() - t0 + "ms");

// 解码：颜色频次 + 主题色矩形坐标（内容区应在边距内：x≥34、宽≤528；A4=595pt）
const buf = readFileSync(OUT);
const raw = buf.toString("latin1");
let all = "", i = 0;
while ((i = raw.indexOf("stream", i)) >= 0) {
  const nl = raw[i + 6] === "\r" ? i + 8 : i + 7;
  const end = raw.indexOf("endstream", nl);
  if (end < 0) break;
  try { all += zlib.inflateSync(buf.subarray(nl, end)).toString("latin1") + "\n"; } catch {}
  i = end + 9;
}
const cnt = {};
const rgre = /([\d.]+) ([\d.]+) ([\d.]+) rg\s*[\r\n]([^\r\n]*)\r?\n?([^\r\n]*)/g;
let m;
const rects = [];
while ((m = all.match(/([\d.]+) ([\d.]+) ([\d.]+) rg\s*((?:[^\n]*\n){0,2})/))) { break; }
// 频次
for (const mm of all.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)) {
  const hex = [mm[1], mm[2], mm[3]].map(Number).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  cnt[hex] = (cnt[hex] || 0) + 1;
}
const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log("填色频次 TOP6:", top.map(([c, n]) => '#' + c + '×' + n).join(' '));
console.log("黑框 #080D18:", cnt["080d18"] || 0, "次（期望 0）");
console.log("白纸 #ffffff:", cnt["ffffff"] || 0, "次（期望 ≥ 页数）");
// 主题色内容矩形：找 0C1424 或 0E1728 等深色的 re 矩形坐标
const themeHexes = new Set(["0c1424", "0e1728", "101a2c"]);
const rectRe = /([\d.]+) ([\d.]+) ([\d.]+) rg\s*(?:[^\n]+\n)*?\s*([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re/g;
let shown = 0;
for (const rm of all.matchAll(rectRe)) {
  const hex = [rm[1], rm[2], rm[3]].map(Number).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  if (!themeHexes.has(hex)) continue;
  const x = +rm[4], y = +rm[5], w = +rm[6], h = +rm[7];
  if (w < 400 || h < 300) continue; // 只看大面积块
  const inMargins = x >= 30 && (x + w) <= 565;
  console.log(`主题色大块: x=${x.toFixed(0)} y=${y.toFixed(0)} w=${w.toFixed(0)} h=${h.toFixed(0)} ${inMargins ? "✓在内容区（边距内）" : "✗越界到边距/满页"}`);
  if (++shown >= 4) break;
}
if (!shown) console.log("（未检出主题色大块——可能导出时为浅色主题，属正常）");
killAll(); await sleep(400);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
console.log("done（现场已恢复）产物: _verify59.pdf");
