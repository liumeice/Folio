// 用量出来的 computed border-radius 说话：连 Edge 调试端口，读取指定选择器的圆角
const PORT = process.env.PORT || 9333;
const SELS = [":root", "html", "body.app", ".settings", ".st-main", ".sgroup", ".scard", ".srow",
  ".btn", ".btn.sm", ".radio", ".thc", ".swatches i", ".select", ".fontsel", ".field", ".stabs", ".stabs-hd"];
const TOKENS = ["--r-win", "--r-3", "--r-2", "--r-1"];

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const j = await r.json();
      const p = j.find((t) => t.type === "page" && /settings-page/i.test(t.url))
             || j.find((t) => t.type === "page" && !/^edge:/.test(t.url)); if (p) return p; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no page target");
}
const tp = await getTargets();
const ws = new WebSocket(tp.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) {
  const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
await new Promise((r) => (ws.onopen = r));
await send("Runtime.enable");
const run = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true });
  if (r.exceptionDetails) return "<err>"; return r.result?.value; };
await new Promise((r) => setTimeout(r, 500));

console.log("URL:", tp.url);
const out = {};
for (const s of SELS) {
  out[s] = await run(`(()=>{const e=document.querySelector(${JSON.stringify(s)});if(!e)return "无元素";
    const c=getComputedStyle(e);const t=c.borderTopLeftRadius;return t==="0px"?"直角(0)":t;})()`);
}
console.log("\n选择器 → computed border-top-left-radius");
for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(14)} ${v}`);
console.log("\n令牌（在 html / body.app 上解析到的值）");
for (const t of TOKENS) {
  console.log(`  ${t.padEnd(9)} html=${await run(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(t)}).trim()||"空"`)}` +
    `  body=${await run(`getComputedStyle(document.body).getPropertyValue(${JSON.stringify(t)}).trim()||"空"`)}`);
}
ws.close(); process.exit(0);
