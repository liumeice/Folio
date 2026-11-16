// v1.2 统一口径实测：A toast 顶部居中标题化；B 新建草稿不进「最近打开」；截图留证
import { spawn } from "node:child_process";
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXE = "./target/release/folio-app.exe";

spawn(EXE, ["d:\\AIProject\\Folio\\artifacts\\formula-smoke\\不存在的文件.md"], { stdio: "ignore", detached: true }).unref();
await sleep(5000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let mid = 0;
function call(method, params) {
  const i = ++mid;
  ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  return new Promise((res) => { ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id === i) res(m); }); });
}
await call("Runtime.enable"); await call("Page.enable");
const E = async (x) => (await call("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

console.log("A 报错toast位置:", await E(`(() => {
  const t = document.querySelector('.toast');
  if (!t) return 'no toast';
  const b = t.getBoundingClientRect();
  return JSON.stringify({ text: t.textContent.slice(0, 30), top: Math.round(b.top),
    centered: Math.abs(b.left + b.width / 2 - innerWidth / 2) < 40, nearBottom: b.top > innerHeight * 0.7 });
})()`));

// B：菜单 文件→新建文档
console.log("B 新建:", await E(`(() => {
  const f = [...document.querySelectorAll('#menubar b')].find(x => x.textContent.trim() === '文件');
  f.click();
  return new Promise(res => setTimeout(() => {
    const mi = document.querySelector('.mi[data-act="new-doc"]');
    if (!mi) return res('no new-doc item');
    mi.click(); res('clicked');
  }, 300));
})()`));
await sleep(2500);
console.log("B 最近打开检查:", await E(`(() => {
  const b = [...document.querySelectorAll('.rail button')].find(x => (x.title || '').startsWith('最近打开'));
  b.click();
  return new Promise(res => setTimeout(() => {
    const side = document.querySelector('.side')?.textContent || '';
    res(JSON.stringify({ hasDraft: side.includes('未命名文档'), sample: side.slice(0, 40) }));
  }, 700));
})()`));

const shot = await call("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("d:/AIProject/Folio/artifacts/formula-smoke/_unif_check.png", Buffer.from(shot.result.data, "base64"));
console.log("shot → _unif_check.png");
ws.close(); process.exit(0);
