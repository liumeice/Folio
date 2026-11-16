// CDP：切到编辑模式 → 量各层矩形（证据）→ 截图
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ?? list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const events = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else events.push(m);
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send("Runtime.enable"); await send("Page.enable");

const expr = `(() => {
  document.querySelectorAll('.seg button')[1].click();
  return new Promise(r => setTimeout(() => {
    const rect = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const b = e.getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
    r(JSON.stringify({
      mode: document.querySelector('.editor-wrap') ? 'edit' : 'read',
      editor: rect('.editor-wrap'), cm: rect('.cm-editor'),
      tbar: rect('.tbar'), side: rect('.side'), status: rect('.status'),
      cmText: (document.querySelector('.cm-content')?.textContent || '').slice(0, 40),
    }));
  }, 600));
})()`;
const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
console.log("LAYOUT:", res.result?.value);
const errs = events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error"));
errs.slice(0, 5).forEach((e) => console.log("ERR:", (e.params.exceptionDetails?.exception?.description || e.params.entry?.text || "").slice(0, 160)));
const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("_edit_shot.png", Buffer.from(shot.data, "base64"));
console.log("shot saved");
ws.close(); process.exit(0);
