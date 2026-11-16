// 四需求实机验收（一次性）：HTML内嵌 / 图片横排 / 光标取色 / 窄窗Tab
// 前置：带 --remote-debugging-port=9223 启动新包
import { spawn } from "node:child_process";
const PORT = 9223;
const EXE = "./target/release/folio-app.exe";
const openDoc = (p) => { spawn(EXE, [p], { stdio: "ignore", detached: true }).unref(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const win = {};
function send(m, p = {}) { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res) => pend.set(i, res)); }
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send("Runtime.enable"); await send("Page.enable"); await send("Browser.enable");
const E = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
const wait = async (expr, ms = 12000) => { const t0 = Date.now(); for (;;) { const v = await E(expr); if (v && v !== "null") return v; if (Date.now() - t0 > ms) return "TIMEOUT"; await sleep(600); } };

// ① 内嵌 HTML：打开 assets/README.md（Bootstrap 徽章块）
openDoc("d:\\AIProject\\Folio\\assets\\README.md");
console.log("HTML-EMBED:", await wait(`(() => {
  const art = document.querySelector('#scroll-area article');
  if (!art || !art.querySelector('h1')) return null;
  return JSON.stringify({
    title: art.querySelector('h1')?.textContent?.trim(),
    rawParP: !!art.querySelector('p[align]'),
    imgInHtml: art.querySelectorAll('p[align] img').length,
    escapedLeak: art.textContent.includes('<p align'),
    dangerous: art.querySelectorAll('script,iframe,input,form,base,link,meta').length,
  });
})()`));

// ② 连续图片横排
openDoc("d:\\AIProject\\Folio\\artifacts\\formula-smoke\\gallery.md");
console.log("IMG-ROW:", await wait(`(() => {
  const row = document.querySelector('#scroll-area article p.imgrow');
  if (!row) return null;
  const imgs = [...row.querySelectorAll('img')];
  const ys = imgs.map(i => Math.round(i.getBoundingClientRect().top));
  return JSON.stringify({
    rowFound: true, count: imgs.length, sameRow: ys.every(y => Math.abs(y - ys[0]) < 6), ys,
    nowrap: getComputedStyle(row).flexWrap, singleOk: document.querySelectorAll('p.imgrow').length,
  });
})()`));

// ③ 深色编辑光标
openDoc("d:\\AIProject\\Folio\\artifacts\\formula-smoke\\sample.md");
await sleep(2500);
await wait(`document.querySelector('#scroll-area article h1')?.textContent?.includes('公式与图表') ? 1 : null`, 15000);
await sleep(1200);
await E(`(() => { const b=[...document.querySelectorAll('.tbar button,.tbar [role=button]')].find(e=>e.textContent.trim()==='编辑'); if(b) b.click(); return 1; })()`);
await sleep(3000);
console.log("CARET:", await E(`(() => {
  const cm = document.querySelector('.cm-content'); if (!cm) return 'no cm';
  cm.focus();
  const c = document.querySelector('.cm-cursor');
  return JSON.stringify({ theme: document.documentElement.dataset.theme, cursor: c ? getComputedStyle(c).borderLeftColor : 'none' });
})()`));

// ④ 窄窗 Tab 可见 + 拖拽属性
const winfo = (await send("Browser.getWindowForTarget")).result;
await send("Browser.setWindowBounds", { windowId: winfo.windowId, bounds: { width: 1024, height: 760 } });
await sleep(900);
console.log("TABS@1024:", await E(`(() => {
  const tabs = document.querySelector('.tabs');
  return JSON.stringify({
    display: getComputedStyle(tabs).display, visible: tabs.getBoundingClientRect().height > 10,
    hasDragAttr: tabs.hasAttribute('data-tauri-drag-region'),
    tabCount: tabs.querySelectorAll('.tab').length, brandName: getComputedStyle(document.querySelector('.brand-name')||document.body).display,
  });
})()`));
const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("d:/AIProject/Folio/artifacts/formula-smoke/_ui_final.png", Buffer.from(shot.result.data, "base64"));
await send("Browser.setWindowBounds", { windowId: winfo.windowId, bounds: { width: 1280, height: 820 } });
console.log("shot → _ui_final.png");
ws.close(); process.exit(0);
