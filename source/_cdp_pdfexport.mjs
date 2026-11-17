// FR-13.2 导出 PDF 正式版验收探针：命令全链路（进程内 CDP）+ 书签树 + A4 + 版本号。
// 用法：node _cdp_pdfexport.mjs  —— 自管理实例（taskkill→带端口启动→取证→无端口重启恢复现场）。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const PORT = Number(process.env.PERF_PORT || 9223);
const EXE = process.env.PERF_EXE || String.raw`d:\AIProject\Folio\source\target\release\folio-app.exe`;
const FIX = String.raw`d:\AIProject\Folio\source\_tmp_pdfexport_fixture.md`;
const OUT = String.raw`d:\AIProject\Folio\source\_tmp_pdfexport_out.pdf`;
const killAll = () => { try { execSync("taskkill /IM folio-app.exe /F >NUL 2>NUL", { stdio: "ignore" }); } catch {} };

// 测试文档：多级标题（书签素材）+ 代码块/表格/长段（分页规则素材），足够打出 ≥2 页
writeFileSync(FIX, `# 导出 PDF 验收文档

## 第一章 结构

${"这是正文段落，用来把内容推过页边界以验证多页与书签映射。".repeat(240)}

### 1.1 小节

代码块不许拦腰斩：

\`\`\`ts
function bookmark(depth: number): string { return "·".repeat(depth) + " 标题"; }
\`\`\`

## 第二章 表格

| 项目 | 口径 | 状态 |
|---|---|---|
| 书签 | 大纲 h1–h6 | 本文件即是 |
| 纸张 | A4 纵向 | 8.27×11.69in |
| 边距 | 15/12mm | 0.59/0.47in |

${"第二段长文，翻页见。".repeat(300)}

## 第三章 收尾

结束行。
`, "utf8");

class Cdp {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); }
  async open() {
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const h = this.p.get(m.id); this.p.delete(m.id); h(m); }
    };
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; }
}
async function findPage() { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(400) }); const l = await r.json(); return l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url)) || null; } catch { return null; } }

let fail = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  — " + extra : "")); if (!ok) fail++; };

killAll(); await sleep(700);
spawn(EXE, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } }).unref();

const target = await (async () => { for (let i = 0; i < 80; i++) { const t = await findPage(); if (t) return t; await sleep(300); } return null; })();
if (!target) { console.log("FAIL  启动超时：拿不到页面 target"); process.exit(1); }
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();

// 等应用挂载
for (let i = 0; i < 60; i++) { if (await cdp.eval(`!!document.querySelector('.win')`)) break; await sleep(250); }

const chip = await cdp.eval(`document.querySelector('.brand-chip')?.textContent?.trim() || ''`);
check("版本 chip 基线 0.2.1", chip.startsWith("v0.2.1"), chip);

const menuHas = await cdp.eval(`!!document.querySelector('.mi[data-act="export-pdf"]')`);
check("菜单含「导出为 PDF…」", menuHas);

// 打开测试文档（走正式 IPC，进最近打开），等正文标题渲染
const openRes = await cdp.eval(`(async () => { try { const d = await window.__TAURI_INTERNALS__.invoke('open_doc', { path: ${JSON.stringify(FIX)} }); return 'ok:' + d.meta.title; } catch (e) { return 'err:' + String(e); } })()`);
check("open_doc 测试文档", String(openRes).startsWith("ok:"), String(openRes));
await sleep(1200);
const hcnt = await cdp.eval(`document.querySelectorAll('article.prose h1,article.prose h2,article.prose h3').length`);
check("正文标题数 ≥ 4（书签素材在 DOM）", hcnt >= 4, `h=${hcnt}`);

// 命令全链路：直接 invoke export_pdf（前端流程已由守卫+单测覆盖；这里验 Rust+CDP+落盘）
try { if (existsSync(OUT)) { /* 覆盖 */ } } catch {}
const t0 = Date.now();
const ex = await cdp.eval(`(async () => { try { await window.__TAURI_INTERNALS__.invoke('export_pdf', { path: ${JSON.stringify(OUT)} }); return 'ok'; } catch (e) { return 'err:' + String(e); } })()`);
check("export_pdf 命令返回", ex === "ok", String(ex) + " (" + (Date.now() - t0) + "ms)");

// 产物结构断言
if (existsSync(OUT)) {
  const buf = readFileSync(OUT);
  const txt = buf.toString("latin1");
  const outlines = (txt.match(/\/Outlines/g) || []).length;
  const titleCount = (txt.match(/\/Title/g) || []).length;
  const pages = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
  check("PDF 落盘且非空", buf.length > 1000, buf.length + " bytes");
  check("书签树存在（/Outlines）", outlines > 0);
  check("书签条目 ≈ 标题数（/Title ≥ 4）", titleCount >= 4, "title=" + titleCount);
  check("多页（分页规则生效前提）", pages >= 2, "pages=" + pages);
  const m = txt.match(/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)/);
  check("纸张 A4（595×842pt±2）", !!m && Math.abs(+m[1] - 595.28) < 2 && Math.abs(+m[2] - 841.89) < 2, m ? m[1] + "x" + m[2] : "n/a");
  console.log("产物保留：" + OUT + "（可人工打开核对书签面板与版式）");
} else {
  check("PDF 落盘", false, OUT + " 不存在");
}

killAll(); await sleep(500);
spawn(EXE, [], { detached: true, stdio: "ignore" }).unref();
console.log(fail ? `\n== ${fail} 项失败 ==` : "\n== 全部通过，现场已恢复 ==");
process.exit(fail ? 1 : 0);
