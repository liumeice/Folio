// 分层诊断：用户的真实大文档上，print 布局是否展开（链式 computed 样式）与打印是否分页（外部 CDP 直调 + 页数解析）。
// 用法：node _cdp_pdfdiag.mjs   （自管实例，结束后恢复现场）
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import zlib from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = Number(process.env.PERF_PORT || 9224);
const EXE = String.raw`d:\AIProject\Folio\source\target\release\folio-app.exe`;
const FIX = String.raw`D:\AIProject\CC-DOCS-MD\docs\1. 快速入门\4. 平台与集成\16. Visual Studio Code.md`;
const OUT = String.raw`d:\AIProject\Folio\source\_diag_direct.pdf`;   // 外部 CDP 直调产物
const OUT2 = String.raw`d:\AIProject\Folio\source\_diag_cmd.pdf`;     // export_pdf 命令产物
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

function pdfPages(buf) {
  const raw = buf.toString("latin1");
  let all = raw;
  let i = 0;
  while ((i = raw.indexOf("stream", i)) >= 0) {
    const nl = raw[i + 6] === "\r" ? i + 8 : i + 7;
    const end = raw.indexOf("endstream", nl);
    if (end < 0) break;
    try { all += "\n" + zlib.inflateSync(buf.subarray(nl, end)).toString("latin1"); } catch { /* 非 deflate 段 */ }
    i = end + 9;
  }
  const pageDicts = (all.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const pagesNode = all.match(/\/Type\s*\/Pages[\s\S]{0,120}?\/Count\s+(\d+)/);
  return { pageDicts, treeCount: pagesNode ? +pagesNode[1] : null, size: buf.length };
}

killAll(); await sleep(700);
spawn(EXE, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } }).unref();
let target = null;
for (let i = 0; i < 80; i++) { target = await findPage(); if (target) break; await sleep(300); }
if (!target) { console.log("FAIL 启动超时"); process.exit(1); }
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
for (let i = 0; i < 60; i++) { if (await cdp.eval(`!!document.querySelector('.win')`)) break; await sleep(250); }

// 打开用户真实文件
const openRes = await cdp.eval(`(async()=>{try{const d=await window.__TAURI_INTERNALS__.invoke('open_doc',{path:${JSON.stringify(FIX)}});return 'ok:'+d.meta.title+' | 字数:'+d.meta.wordCount;}catch(e){return 'err:'+String(e)}})()`);
console.log("open_doc:", String(openRes).slice(0, 120));
await sleep(6000); // 等渐进式初排完成（正式 UI 流程里有 waitArticleStable，探针直调命令需自等）

console.log(await cdp.eval(`(() => {
  const v = document.querySelector('.view'); const a = document.querySelector('article.prose');
  return '【screen】article.scroll=' + (a && a.scrollHeight) + ' view.scrollHeight=' + (v && v.scrollHeight) + ' view.clientHeight=' + (v && v.clientHeight) + ' imgs=' + (a ? a.querySelectorAll('img').length : 0);
})()`));

const CHAIN = `['html','body','#root','.win','.body','.center','.view','article.prose'].map(sel=>{
  const el = sel==='html'?document.documentElement:sel==='body'?document.body:sel==='#root'?document.getElementById('root'):document.querySelector(sel);
  if(!el) return sel+':MISSING';
  const cs=getComputedStyle(el);
  return sel+' pos='+cs.position+' h='+cs.height+' minH='+cs.minHeight+' maxH='+cs.maxHeight+' ovf='+cs.overflowY+' rect='+Math.round(el.getBoundingClientRect().height)+' scroll='+el.scrollHeight;
}).join('\\n')`;

await cdp.send("Emulation.setEmulatedMedia", { media: "print" });
await sleep(400);
console.log("【print 模拟 · 期望链上全部 height:auto/overflow:visible】\n" + await cdp.eval(CHAIN));
await cdp.send("Emulation.setEmulatedMedia", { media: "" });

// 外部 CDP 直调 printToPDF（与 Rust 参数一致）
const t0 = Date.now();
const r1 = await cdp.send("Page.printToPDF", {
  printBackground: true, paperWidth: 8.27, paperHeight: 11.69,
  marginTop: 0.59, marginBottom: 0.59, marginLeft: 0.47, marginRight: 0.47,
  preferCSSPageSize: false, displayHeaderFooter: false,
  generateDocumentOutline: true, transferMode: "ReturnAsBase64",
});
writeFileSync(OUT, Buffer.from(r1.data, "base64"));
console.log("【外部 CDP 直调】", Date.now() - t0, "ms →", JSON.stringify(pdfPages(readFileSync(OUT))));

// 走应用命令（同一 CDP 方法、经 Rust base64→写盘）
const t1 = Date.now();
const ex = await cdp.eval(`(async()=>{try{document.title='Visual Studio Code';const v=document.querySelector('.view');const cm=v?getComputedStyle(v).backgroundColor.match(/[\\d]+/g):null;const bg=cm?'#'+cm.slice(0,3).map(n=>(+n).toString(16).padStart(2,'0')).join(''):'#FFFFFF';await window.__TAURI_INTERNALS__.invoke('export_pdf',{path:${JSON.stringify(OUT2)},bgColor:bg});return 'ok:'+bg}catch(e){return 'err:'+String(e)}})()`);
console.log("【export_pdf 命令】", ex, Date.now() - t1, "ms →", JSON.stringify(pdfPages(readFileSync(OUT2))));

killAll(); await sleep(400);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
console.log("done（现场已恢复）；产物 _diag_direct.pdf / _diag_cmd.pdf");
