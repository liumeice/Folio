import { spawn } from "node:child_process";
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
spawn("./target/release/folio-app.exe", ["d:\\AIProject\\Folio\\assets\\README.md"], { stdio: "ignore", detached: true }).unref();
const EXPR = `(() => {
  const art = document.querySelector('#scroll-area article');
  const tab = (document.querySelector('.tab.on') || {}).textContent || '';
  return JSON.stringify({
    tab: tab.trim(),
    hasBootstrap: !!(art && art.textContent.includes('Bootstrap')),
    rawP: !!(art && art.querySelector('p[align]')),
    imgInRawP: art ? art.querySelectorAll('p[align] img').length : -1,
    strongInA: art ? art.querySelectorAll('a > strong').length : -1,
    escapedLeak: art ? art.textContent.includes('<p align') : null,
    danger: art ? art.querySelectorAll('script,iframe,input,form,base,link,meta').length : -1,
  });
})()`;
const t0 = Date.now();
for (;;) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const r = await new Promise((res) => {
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: EXPR, returnByValue: true } }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { res(m.result?.result?.value); ws.close(); } };
  });
  const o = JSON.parse(r);
  if (o.hasBootstrap || Date.now() - t0 > 40000) { console.log("耗时", ((Date.now() - t0) / 1000).toFixed(1) + "s :", r); break; }
  await sleep(1500);
}

// 徽章区几何断言 + 截图（滚动到顶部）
const { writeFileSync } = await import("node:fs");
const list2 = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws2 = new WebSocket(list2.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
let mid = 0;
function send2(method, params) {
  const i = ++mid;
  ws2.send(JSON.stringify({ id: i, method, params: params || {} }));
  return new Promise((res) => { ws2.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id === i) res(m); }); });
}
await send2("Runtime.enable"); await send2("Page.enable");
const g = await send2("Runtime.evaluate", { expression: `(() => {
  const view = document.querySelector('#scroll-area'); view.scrollTop = 0;
  const rows = [...document.querySelectorAll('#scroll-area article p.imgrow')];
  const report = rows.slice(0, 4).map(r0 => {
    const kids = [...r0.children].filter(x => x.tagName === 'A' || x.tagName === 'IMG');
    const ys = kids.map(k => Math.round(k.getBoundingClientRect().top));
    return { items: kids.length, sameLine: ys.every(y => Math.abs(y - ys[0]) < 6), wrap: getComputedStyle(r0).flexWrap };
  });
  const htmlP = document.querySelectorAll('#scroll-area article p[align]').length;
  return JSON.stringify({ imgRows: rows.length, first4: report, htmlAlignP: htmlP });
})()`, returnByValue: true });
console.log("GEOMETRY:", g.result?.result?.value);
await sleep(700);
const shot = await send2("Page.captureScreenshot", { format: "png" });
writeFileSync("d:/AIProject/Folio/artifacts/formula-smoke/_readme_badges.png", Buffer.from(shot.result.data, "base64"));
console.log("shot → _readme_badges.png");
ws2.close();
process.exit(0);
