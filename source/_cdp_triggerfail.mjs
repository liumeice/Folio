import { spawn } from "node:child_process";
const PORT = 9223;
spawn("./target/release/folio-app.exe", ["d:\\AIProject\\Folio\\artifacts\\formula-smoke\\不存在的文件.md"], { stdio: "ignore", detached: true }).unref();
await new Promise((r) => setTimeout(r, 1300));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id === 1) { console.log("TOAST:", m.result?.result?.value); ws.close(); process.exit(0); }
});
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
  expression: `(() => { const t = document.querySelector('.toast'); if (!t) return 'no toast'; const b = t.getBoundingClientRect(); return JSON.stringify({ text: t.textContent, top: Math.round(b.top), centered: Math.abs(b.left + b.width / 2 - innerWidth / 2) < 40 }); })()`,
  returnByValue: true } }));
setTimeout(() => { console.log("timeout"); process.exit(1); }, 8000);
