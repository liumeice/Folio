const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
function call(method, params, i) {
  ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  return new Promise((res) => { ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id === i) res(m); }); });
}
await call("Runtime.enable", {}, 1);
await call("Page.enable", {}, 2);
const EXPR = `(() => {
  const t = document.querySelector('.toast');
  if (!t) return 'no toast (已过 2.6s 窗口)';
  const b = t.getBoundingClientRect();
  return JSON.stringify({ text: t.textContent, top: Math.round(b.top),
    centered: Math.abs(b.left + b.width / 2 - innerWidth / 2) < 40 });
})()`;
for (let k = 0; k < 3; k++) {
  const r = await call("Runtime.evaluate", { expression: EXPR, returnByValue: true }, 10 + k);
  console.log("TOAST:", r.result?.result?.value);
  if (String(r.result?.result?.value).startsWith("no toast")) break;
  break;
}
const shot = await call("Page.captureScreenshot", { format: "png" }, 20);
const fs = await import("node:fs");
fs.writeFileSync("d:/AIProject/Folio/artifacts/formula-smoke/_toast42.png", Buffer.from(shot.result.data, "base64"));
console.log("shot → _toast42.png");
ws.close(); process.exit(0);
