// POC：WebView2 内核是否支持 CDP Page.printToPDF 的 generateDocumentOutline（PDF 书签）。
// 用法：node _cdp_pdfpoc.mjs   —— 会 taskkill 现有实例、带调试端口启动取证、结束后**无端口重启原实例恢复现场**。
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = Number(process.env.PERF_PORT || 9223);
const EXE = process.env.PERF_EXE || String.raw`d:\AIProject\Folio\source\target\release\folio-app.exe`;
const killAll = () => { try { execSync("taskkill /IM folio-app.exe /F >NUL 2>NUL", { stdio: "ignore" }); } catch {} };

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
async function findPage() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(400) }); const l = await r.json(); return l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url)) || null; } catch { return null; }
}

killAll();
await sleep(600);
const child = spawn(EXE, [], { detached: true, stdio: "ignore",
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } });
child.unref();

let target = null;
for (let i = 0; i < 60; i++) { target = await findPage(); if (target) break; await sleep(300); }
if (!target) { console.log("FAIL: 找不到 tauri.localhost 页面 target"); killAll(); process.exit(1); }

const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
// 等正文渲染完（至少一个标题）
for (let i = 0; i < 40; i++) {
  const ok = await cdp.eval(`!!document.querySelector('article.prose h1, article.prose h2, article.prose h3')`);
  if (ok) break;
  await sleep(300);
}
const headings = await cdp.eval(`document.querySelectorAll('article.prose h1,article.prose h2,article.prose h3,article.prose h4').length`);
console.log("页内标题数:", headings);

const params = {
  printBackground: true,
  paperWidth: 8.27, paperHeight: 11.69,          // A4（英寸）
  marginTop: 0.59, marginBottom: 0.59, marginLeft: 0.47, marginRight: 0.47, // 15/15/12/12mm
  preferCSSPageSize: false,
  displayHeaderFooter: false,
  generateDocumentOutline: true,                  // ← 本次 POC 的主角
  transferMode: "ReturnAsBase64",
};
try {
  const t0 = Date.now();
  const r = await cdp.send("Page.printToPDF", params);
  console.log("printToPDF 成功，用时", Date.now() - t0, "ms，b64 长度", r.data.length);
  const buf = Buffer.from(r.data, "base64");
  writeFileSync("_poc_outline.pdf", buf);
  const txt = buf.toString("latin1");
  const outlines = (txt.match(/\/Outlines/g) || []).length;
  const titleCount = (txt.match(/\/Title/g) || []).length;
  const pages = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log("落盘 _poc_outline.pdf:", buf.length, "bytes | /Outlines:", outlines, "| /Title 节点:", titleCount, "| /Page:", pages);
  console.log(outlines > 0 && titleCount > 0 ? "★ 书签生成：内核支持 generateDocumentOutline" : "★ 无书签：该 runtime 不支持或条件未满足");
} catch (e) {
  console.log("printToPDF 失败:", e.message.slice(0, 400));
}
killAll();
await sleep(500);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();   // 恢复现场：无调试端口重启
console.log("现场已恢复（folio-app 正常重启，不带调试端口）");
