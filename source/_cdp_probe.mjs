// CDP 取证：连 WebView2 调试口 → 执行探针 JS → 截图 → 收集异常
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
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
  } else if (msg.method) {
    events.push(msg);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");
await new Promise((r) => setTimeout(r, 1200));

const probe = `(() => {
  const bs = getComputedStyle(document.body);
  return JSON.stringify({
    htmlTheme: document.documentElement.getAttribute('data-theme'),
    bodyTheme: document.body.getAttribute('data-theme'),
    bodyClass: document.body.className,
    bg: bs.backgroundColor,
    color: bs.color,
    varText: bs.getPropertyValue('--text').trim(),
    varBg: bs.getPropertyValue('--bg-view').trim(),
    sheets: [...document.styleSheets].map(s => (s.href||'inline') + ':' + (s.cssRules ? s.cssRules.length : 'ERR')),
    rootChildren: document.getElementById('root')?.children.length ?? -1,
    rootHtmlLen: (document.getElementById('root')?.innerHTML || '').length,
    rootHead: (document.getElementById('root')?.innerHTML || '').slice(0, 260),
    winW: innerWidth, winH: innerHeight,
  });
})()`;

const res = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
console.log("PROBE:", res.result?.value ?? JSON.stringify(res));

const errs = events.filter((e) =>
  e.method === "Runtime.exceptionThrown" ||
  (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) ||
  e.method === "Log.entryAdded");
for (const e of errs.slice(0, 12)) {
  if (e.method === "Runtime.exceptionThrown") {
    const d = e.params.exceptionDetails;
    console.log("EXC:", (d.exception?.description || d.text || "").split("\n").slice(0, 3).join(" | "));
  } else if (e.method === "Log.entryAdded") {
    console.log("LOG:", e.params.entry.level, e.params.entry.text.slice(0, 200));
  } else {
    console.log("CON:", e.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 200));
  }
}

const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("_webview_shot.png", Buffer.from(shot.data, "base64"));
console.log("shot saved _webview_shot.png");
ws.close();
process.exit(0);
