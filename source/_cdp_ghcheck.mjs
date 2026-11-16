// GitHub 观感验收（一次性）：README 徽章行 + gallery 三图——贴邻、折行、无横向滚动
import { spawn } from "node:child_process";
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXPR = `(() => {
  const rows = [...document.querySelectorAll('#scroll-area article p.imgrow')];
  const info = rows.slice(0, 4).map(r0 => {
    const kids = [...r0.children].map(x => x.getBoundingClientRect()).filter(b => b.width > 0);
    const tops = [...new Set(kids.map(b => Math.round(b.top)))];
    let minGap = 999;
    kids.sort((a, b) => a.left - b.left);
    for (let i = 1; i < kids.length; i++) {
      if (Math.abs(kids[i].top - kids[i - 1].top) < 6) minGap = Math.min(minGap, Math.round(kids[i].left - (kids[i - 1].left + kids[i - 1].width)));
    }
    return { items: kids.length, lines: tops.length, noHScroll: r0.scrollWidth <= r0.clientWidth + 2, minGapPx: minGap === 999 ? null : minGap };
  });
  const anyScroll = rows.some(r0 => r0.scrollWidth > r0.clientWidth + 2);
  return JSON.stringify({ doc: (document.querySelector('.tab.on')||{}).textContent?.trim(), rowCount: rows.length, first4: info, anyHScroll: anyScroll });
})()`;
async function probe(docNeedle) {
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
    if (o.doc && o.doc.includes(docNeedle)) return r;
    if (Date.now() - t0 > 30000) return "TIMEOUT " + r;
    await sleep(1200);
  }
}
spawn("./target/release/folio-app.exe", ["d:\\AIProject\\Folio\\assets\\README.md"], { stdio: "ignore", detached: true }).unref();
await sleep(7000);
console.log("README:", await probe("README"));
spawn("./target/release/folio-app.exe", ["d:\\AIProject\\Folio\\artifacts\\formula-smoke\\gallery.md"], { stdio: "ignore", detached: true }).unref();
console.log("GALLERY:", await probe("gallery"));
const list2 = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws2 = new WebSocket(list2.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
await new Promise((res) => {
  ws2.send(JSON.stringify({ id: 9, method: "Page.captureScreenshot", params: { format: "png" } }));
  ws2.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 9) {
    import("node:fs").then(fs => { fs.writeFileSync("d:/AIProject/Folio/artifacts/formula-smoke/_gh_style.png", Buffer.from(m.result.data, "base64")); res(); });
  } };
  setTimeout(res, 4000);
});
ws2.close();
console.log("shot → _gh_style.png");
process.exit(0);
