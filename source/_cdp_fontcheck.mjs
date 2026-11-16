const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errors = [];
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description || "").split("\n")[0]);
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send("Runtime.enable"); await send("Page.enable");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
const shot = async (n) => { const s = await send("Page.captureScreenshot", { format: "png" }); const fs = await import("node:fs"); fs.writeFileSync(n + ".png", Buffer.from(s.data, "base64")); };

const probe = `(() => { const p = document.querySelector('.prose'); if (!p) return 'NO-PROSE';
  const cs = getComputedStyle(p);
  return JSON.stringify({ fs: cs.fontSize, mw: cs.maxWidth, lh: cs.lineHeight, ff: cs.fontFamily.slice(0, 18) }); })()`;

await wait(1600);
console.log("before:", await ev(probe));

// 点工具栏滑杆图标开弹层（校验真实可见性：display:none 时 offsetHeight 为 0）
await ev(`document.querySelector('#btn-font').click()`);
await wait(300);
console.log("popover visible:", await ev(`(document.querySelector('#font-pop')?.offsetHeight ?? 0) > 0`));
await shot("font-1-open");

// 宽(1120) → 行高宽松(2) → 无衬线 → A+ 两次
await ev(`[...document.querySelectorAll('#font-pop .radio')].find(x=>x.textContent==="宽").click()`);
await wait(150);
await ev(`[...document.querySelectorAll('#font-pop .radio')].find(x=>x.textContent==="宽松").click()`);
await wait(150);
await ev(`[...document.querySelectorAll('#font-pop .radio')].find(x=>x.textContent==="无衬线").click()`);
await wait(150);
await ev(`document.querySelector('#fs-plus').click();document.querySelector('#fs-plus').click()`);
await wait(400);
console.log("after :", await ev(probe));
console.log("fs-val:", await ev(`document.querySelector('.fs-val')?.textContent`),
  "on-states:", await ev(`JSON.stringify([...document.querySelectorAll('#font-pop .radio.on')].map(x=>x.textContent))`));
await shot("font-2-applied");

// 搜索面板：取消焦点环验证
await ev(`document.querySelector('#btn-font').click()`);   // 收起弹层
await ev(`document.querySelectorAll('.rail button')[2].click()`);  // 打开搜索
await wait(300);
console.log("search outline:", await ev(`(()=>{const i=document.querySelector('#search-input');i.focus();const cs=getComputedStyle(i);return cs.outlineStyle+'/'+cs.outlineWidth})()`));
await shot("font-3-searchfocus");
console.log("ERRORS:", errors.length ? errors.slice(0, 4) : "none");
ws.close(); process.exit(0);
