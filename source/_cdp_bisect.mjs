// 二分定位每页深色矩形：printBackground 开关 × DOM 子树消隐。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import zlib from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = 9229;
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
function darkCount(buf) {
  const raw = buf.toString("latin1");
  let all = "", i = 0;
  while ((i = raw.indexOf("stream", i)) >= 0) {
    const nl = raw[i + 6] === "\r" ? i + 8 : i + 7;
    const end = raw.indexOf("endstream", nl);
    if (end < 0) break;
    try { all += zlib.inflateSync(buf.subarray(nl, end)).toString("latin1") + "\n"; } catch {}
    i = end + 9;
  }
  let dark = 0;
  for (const m of all.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)) {
    const hex = [m[1], m[2], m[3]].map(Number).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    if (hex === "080d18") dark++;
  }
  return dark;
}
const PDF_PARAMS = {
  paperWidth: 8.27, paperHeight: 11.69,
  marginTop: 0.59, marginBottom: 0.59, marginLeft: 0.47, marginRight: 0.47,
  preferCSSPageSize: false, displayHeaderFooter: false,
  generateDocumentOutline: false, transferMode: "ReturnAsBase64",
};

killAll(); await sleep(700);
spawn(EXE, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } }).unref();
let target = null;
for (let i = 0; i < 80; i++) { target = await findPage(); if (target) break; await sleep(300); }
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
for (let i = 0; i < 60; i++) { if (await cdp.eval(`!!document.querySelector('.win')`)) break; await sleep(250); }
await cdp.eval(`(async()=>{try{await window.__TAURI_INTERNALS__.invoke('open_doc',{path:${JSON.stringify(FIX)}})}catch(e){}})()`);
await sleep(7000);

// A：printBackground:true（对照，与正式导出同参）
const ra = await cdp.send("Page.printToPDF", { ...PDF_PARAMS, printBackground: true });
writeFileSync("_bisect_a.pdf", Buffer.from(ra.data, "base64"));
console.log("A·printBackground:true →", darkCount(readFileSync("_bisect_a.pdf")), "次深色");

// B：printBackground:false
const rb = await cdp.send("Page.printToPDF", { ...PDF_PARAMS, printBackground: false });
writeFileSync("_bisect_b.pdf", Buffer.from(rb.data, "base64"));
console.log("B·printBackground:false →", darkCount(readFileSync("_bisect_b.pdf")), "次深色");

// C：#root display:none（DOM 二分）
await cdp.eval(`document.getElementById('root').style.display='none'; 'ok'`);
const rc = await cdp.send("Page.printToPDF", { ...PDF_PARAMS, printBackground: true });
writeFileSync("_bisect_c.pdf", Buffer.from(rc.data, "base64"));
console.log("C·#root 隐藏 + printBackground:true →", darkCount(readFileSync("_bisect_c.pdf")), "次深色");
await cdp.eval(`document.getElementById('root').style.display=''; 'ok'`);

killAll(); await sleep(400);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
console.log("done（现场已恢复）");
