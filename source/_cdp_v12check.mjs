import { spawn } from "node:child_process";
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() {
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (!page) throw 0;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(rej, 4000); });
      let mid = 0;
      const api = {
        async eval(x) {
          const i = ++mid;
          return new Promise((res) => {
            const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === i) { ws.removeEventListener("message", h); res(m.result?.result?.value); } };
            ws.addEventListener("message", h);
            ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: x, returnByValue: true, awaitPromise: true } }));
          });
        },
        close: () => ws.close(),
      };
      await api.eval("1"); // 握手
      return api;
    } catch { await sleep(1000); }
  }
}
// 先触发一次"打开失败"（转发给在跑的实例，toast 会出现在统一通知位）
spawn("./target/release/folio-app.exe", ["d:\\AIProject\\Folio\\artifacts\\formula-smoke\\不存在的文件.md"], { stdio: "ignore", detached: true }).unref();
await sleep(1800);
const A = await getWs();
console.log("A 报错toast:", await A.eval(`(() => {
  const t = document.querySelector('.toast');
  if (!t) return 'no toast (窗口或已超时)';
  const b = t.getBoundingClientRect();
  return JSON.stringify({ text: t.textContent.slice(0, 32), top: Math.round(b.top),
    centered: Math.abs(b.left + b.width / 2 - innerWidth / 2) < 40, nearBottom: b.top > innerHeight * 0.7 });
})()`));
// B 新建文档 → 最近打开不应出现"未命名文档"
console.log("B 新建:", await A.eval(`(() => {
  const f = [...document.querySelectorAll('#menubar b')].find(x => x.textContent.trim() === '文件');
  f.click();
  return new Promise(res => setTimeout(() => {
    const mi = document.querySelector('.mi[data-act="new-doc"]');
    mi ? (mi.click(), res('clicked')) : res('no item');
  }, 300));
})()`));
await sleep(2500);
console.log("B 最近打开:", await A.eval(`(() => {
  const b = [...document.querySelectorAll('.rail button')].find(x => (x.title || '').startsWith('最近打开'));
  b.click();
  return new Promise(res => setTimeout(() => {
    const side = document.querySelector('.side')?.textContent || '';
    const rows = [...document.querySelectorAll('.side .tf')].length;
    const dupSet = new Set(); let dup = 0;
    document.querySelectorAll('.side .tf[title]').forEach(e => { const k = (e.getAttribute('title')||'').toLowerCase().replace(/\\\\/g,'/'); if (dupSet.has(k)) dup++; dupSet.add(k); });
    res(JSON.stringify({ hasDraft: side.includes('未命名文档'), rows, dupAfterDedupe: dup }));
  }, 700));
})()`));
const shot = await new Promise((res) => {
  const i = 999;
  const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === i) { A.close(); res(m); } };
  A && (() => { const ws = null; })();
  // 直接再开一条连接截图
  (async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const ws2 = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r2) => { ws2.onopen = r2; });
    ws2.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 7) { ws2.close(); res(m); } };
    ws2.send(JSON.stringify({ id: 7, method: "Page.captureScreenshot", params: { format: "png" } }));
  })();
});
const fs = await import("node:fs");
fs.writeFileSync("d:/AIProject/Folio/artifacts/formula-smoke/_v12_check.png", Buffer.from(shot.result.data, "base64"));
console.log("shot → _v12_check.png");
process.exit(0);
