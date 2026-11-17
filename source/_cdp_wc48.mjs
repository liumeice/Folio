import { spawn } from "node:child_process";
const PORT = 9223;
spawn("./target/release/folio-app.exe", ["d:\\AIProject\\Folio\\assets\\Mermaid文档.md"], { stdio: "ignore", detached: true }).unref();
await new Promise((r) => setTimeout(r, 10000));
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
  const si = [...document.querySelectorAll('.status .si')].map(x => x.textContent.trim());
  const sub = document.querySelector('#scroll-area article .sub')?.textContent?.replace(/\\s+/g, ' ').trim();
  return JSON.stringify({ statusSlots: si.slice(0, 6), sub });
})()`, returnByValue: true }, 3);
console.log("WC-48:", r.result?.result?.value);
const shot = await call("Page.captureScreenshot", { format: "png" }, 4);
const fs = await import("node:fs");
fs.writeFileSync("d:/AIProject/Folio/artifacts/formula-smoke/_wc48.png", Buffer.from(shot.result.data, "base64"));
console.log("shot → _wc48.png");
ws.close();
process.exit(0);
