// 文件夹面板结构取证（一次性脚本）：切到文档库面板 → 统计树形态 → 截图
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send("Runtime.enable");
await send("Page.enable");
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

// 用真实 UI 切到「文件夹」面板（rail 第二钮）
console.log("RAIL:", await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.rail .ri, .rail button, aside.rail *')];
  const b = btns.find(e => (e.title || e.textContent || '').includes('文件夹'));
  if (!b) return 'no folder rail button';
  b.click(); return 'clicked: ' + (b.title || b.textContent);
})()`));
await new Promise((r) => setTimeout(r, 800));

console.log("PANEL:", await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.tf')];
  const dirs = rows.filter(r => r.classList.contains('dir')).length;
  const loose = rows.filter(r => r.textContent.includes('其他库条目')).length;
  const sideText = (document.querySelector('.side')?.textContent || '').slice(0, 120);
  const libCount = (window).__FOLIO_LIB_COUNT ?? -1;
  return JSON.stringify({ totalRows: rows.length, dirRows: dirs, looseBucketRows: loose, sideText,
    docCountChip: (document.querySelector('#lib-root-chip')?.textContent || '').trim().slice(0, 60) });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("../artifacts/formula-smoke/_panel_shot.png", import.meta.url), Buffer.from(shot.data, "base64"));
console.log("shot → artifacts/formula-smoke/_panel_shot.png");
ws.close();
process.exit(0);
