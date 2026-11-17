// 决定性实验：揭幕完成后导出（明/暗两主题各一次），数每页 #080D18 填充次数；
// 同时改 document.title 验证书签根节点文字是否取自 <title>（为「书签不带图标」提供清洗方案）。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import zlib from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = Number(process.env.PERF_PORT || 9226);
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

function fillCounts(path) {
  const buf = readFileSync(path);
  const raw = buf.toString("latin1");
  let all = raw, i = 0;
  while ((i = raw.indexOf("stream", i)) >= 0) {
    const nl = raw[i + 6] === "\r" ? i + 8 : i + 7;
    const end = raw.indexOf("endstream", nl);
    if (end < 0) break;
    try { all += "\n" + zlib.inflateSync(buf.subarray(nl, end)).toString("latin1"); } catch {}
    i = end + 9;
  }
  const c = (hex) => (all.match(new RegExp(`[\\d.]+ [\\d.]+ [\\d.]+ rg[\\s\\S]{0,400}?[\\d.]+ [\\d.]+ [\\d.]+ [\\d.]+ re`, "g")) || []).length;
  const cnt = {};
  for (const m of all.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)) {
    const hex = [m[1], m[2], m[3]].map(Number).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    cnt[hex] = (cnt[hex] || 0) + 1;
  }
  return cnt;
}
function firstTitle(path) {
  const buf = readFileSync(path);
  const raw = buf.toString("latin1");
  let all = raw, i = 0;
  while ((i = raw.indexOf("stream", i)) >= 0) {
    const nl = raw[i + 6] === "\r" ? i + 8 : i + 7;
    const end = raw.indexOf("endstream", nl);
    if (end < 0) break;
    try { all += "\n" + zlib.inflateSync(buf.subarray(nl, end)).toString("latin1"); } catch {}
    i = end + 9;
  }
  const m = all.match(/\/Title\s*<((?:FEFF)?[0-9A-Fa-f]+)>/);
  if (!m) return "(none)";
  const hex = m[1].replace(/^FEFF/, "");
  const b = Buffer.from(hex, "hex");
  const sw = Buffer.alloc(b.length);
  for (let j = 0; j < b.length - 1; j += 2) { sw[j] = b[j + 1]; sw[j + 1] = b[j]; }
  return sw.toString("utf16le");
}

async function exportAndCount(cdp, out, note) {
  const t0 = Date.now();
  const ex = await cdp.eval(`(async()=>{try{await window.__TAURI_INTERNALS__.invoke('export_pdf',{path:${JSON.stringify(out)}});return 'ok'}catch(e){return 'err:'+String(e)}})()`);
  const cnt = fillCounts(out);
  const dark = cnt["080d18"] || 0;
  const dark2 = cnt["0c1424"] || 0;
  const light = cnt["fcfcfd"] || 0;
  console.log(`${note}: ${ex} ${Date.now() - t0}ms | #080d18×${dark} #0C1424×${dark2} #FCFCFD×${light} | 首书签="${firstTitle(out).slice(0, 50)}"`);
}

killAll(); await sleep(700);
spawn(EXE, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } }).unref();
let target = null;
for (let i = 0; i < 80; i++) { target = await findPage(); if (target) break; await sleep(300); }
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
for (let i = 0; i < 60; i++) { if (await cdp.eval(`!!document.querySelector('.win')`)) break; await sleep(250); }
await cdp.eval(`(async()=>{try{await window.__TAURI_INTERNALS__.invoke('open_doc',{path:${JSON.stringify(FIX)}})}catch(e){}})()`);
console.log("当前主题:", await cdp.eval(`document.documentElement.dataset.theme`));
console.log("splash 在 DOM:", await cdp.eval(`!!document.getElementById('boot-splash')`));
await sleep(7000); // 等揭幕彻底完成（5s 兜底之后）
console.log("等 7s 后 splash 在 DOM:", await cdp.eval(`!!document.getElementById('boot-splash')`));

await exportAndCount(cdp, String.raw`d:\AIProject\Folio\source\_b1_dark.pdf`, "实验1·当前主题（揭幕后）");

// 换浅色主题再导一次
await cdp.eval(`(async()=>{try{const s=await window.__TAURI_INTERNALS__.invoke('get_settings');s.theme='light';await window.__TAURI_INTERNALS__.invoke('set_settings',{settings:s});return 'ok'}catch(e){return 'err:'+String(e)}})()`);
await sleep(1500);
console.log("切浅色后主题:", await cdp.eval(`document.documentElement.dataset.theme`));
await exportAndCount(cdp, String.raw`d:\AIProject\Folio\source\_b2_light.pdf`, "实验2·浅色主题");

// 验证书签根节点 = document.title
await cdp.eval(`document.title='TEST-TITLE-XYZ'`);
await exportAndCount(cdp, String.raw`d:\AIProject\Folio\source\_b3_title.pdf`, "实验3·改 title 后");

killAll(); await sleep(400);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
console.log("done（现场已恢复）");
