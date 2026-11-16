import { spawn } from "node:child_process";
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
spawn("./target/release/folio-app.exe", ["d:\\AIProject\\Folio\\artifacts\\formula-smoke\\不存在的文件.md"], { stdio: "ignore", detached: true }).unref();
await sleep(5000);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
function call(method, params, i) {
  ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  return new Promise((res) => { ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id === i) res(m); }); });
}
await call("Runtime.enable", {}, 1);
await call("Page.enable", {}, 2);
const r = await call("Runtime.evaluate", { expression: `(() => {
  const z = document.querySelector('.toast-zone');
  const t = document.querySelector('.toast');
  if (!t) return JSON.stringify({ toast: 'none(yet)' });
  const b = t.getBoundingClientRect();
  const zb = z.getBoundingClientRect();
  return JSON.stringify({
    text: t.textContent.slice(0, 40),
    position: getComputedStyle(z).position,
    topPx: Math.round(b.top), bottomPx: Math.round(b.bottom),
    centerX: Math.round(b.left + b.width / 2), winCenterX: Math.round(innerWidth / 2),
    nearBottom: b.top > innerHeight * 0.75,
  });
})()`, returnByValue: true }, 3);
console.log("TOAST-POS:", r.result?.result?.value);
const shot = await call("Page.captureScreenshot", { format: "png" }, 4);
const fs = await import("node:fs");
fs.writeFileSync("d:/AIProject/Folio/artifacts/formula-smoke/_toast_top.png", Buffer.from(shot.result.data, "base64"));
console.log("shot → _toast_top.png");
ws.close(); process.exit(0);
