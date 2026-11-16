/* 设置浮窗实机核对（2026-11-16 形态改版后）：
 * 标题栏 ⚙ 入口、.st-win 几何（1060×640、居中）、主界面不隐藏（side/center/splitter 可见）、
 * 设置行不换行（控件甩到下一行=0）、rail ⚙ 已撤、遮罩点击关闭、控制台零异常、截图。 */
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const problems = [];
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => pending.set(i, { res, rej })); };
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
  else if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails.exception?.description ?? "异常"); };
await new Promise(r => ws.onopen = r);
await send("Runtime.enable"); await send("Page.enable");
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const run = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: false });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 240));
  return r.result?.value;
};
const shot = async (n) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  (await import("node:fs")).writeFileSync(`_stwin_${n}.png`, Buffer.from(data, "base64"));
  console.log("  📄", `_stwin_${n}.png`);
};

for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(800);
const css = (sel, prop) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)}))${prop}`;
console.log("资源指纹:", await run(`JSON.stringify([...document.querySelectorAll("link[rel=stylesheet]")].map(l=>l.href))`));

console.log("\n=== 1) 标题栏 ⚙ 入口存在、rail ⚙ 已撤 ===");
console.log(await run(`({
  标题栏设置钮: !!document.querySelector('.tbar-right .iconbtn[title="设置"]'),
  rail按钮数: document.querySelectorAll('.rail button').length,
  rail含设置钮: [...document.querySelectorAll('.rail button')].some(b=>b.title==="设置"),
})`));

console.log("\n=== 2) 点击 ⚙ 打开浮窗 + 几何 ===");
await run(`document.querySelector('.tbar-right .iconbtn[title="设置"]').click()`);
await wait(600);
console.log(await run(`(() => {
  const p = document.querySelector('.st-panel'), w = document.querySelector('.st-win');
  const pr = p.getBoundingClientRect(), r = w.getBoundingClientRect();
  return {
    settings_open: document.querySelector('.body').classList.contains('settings-open'),
    遮罩position: getComputedStyle(p).position,
    遮罩display: getComputedStyle(p).display,
    窗宽: Math.round(r.width), 窗高: Math.round(r.height),
    居中偏差px: Math.round(Math.abs(r.left - (innerWidth - r.right))),
    圆角: getComputedStyle(w).borderRadius,
    弹入动画: getComputedStyle(w).animationName,
    zindex: getComputedStyle(p).zIndex,
  };
})()`));
console.log("\n=== 3) 主界面保持可见（不再隐藏） ===");
console.log(await run(`({
  side可见: !!document.querySelector('.side')?.offsetParent,
  center可见: !!document.querySelector('.center')?.offsetParent,
  splitter可见: !!document.querySelector('.splitter')?.offsetParent,
  状态栏可见: !!document.querySelector('.statusbar, footer')?.offsetParent,
})`));
await shot("open");

console.log("\n=== 4) 设置行不换行（控件甩下行的行数应为 0） ===");
console.log(await run(`(() => {
  const rows = [...document.querySelectorAll('.st-row')];
  const wrapped = rows.filter(r => {
    const ctl = r.querySelector('.st-ctlbox, .st-ctlrow');
    if (!ctl) return false;
    return ctl.getBoundingClientRect().top - r.getBoundingClientRect().top > 34;
  });
  return { 总行数: rows.length, 控件换行数: wrapped.length,
    行高样本: rows.slice(0,4).map(r=>Math.round(r.getBoundingClientRect().height)) };
})()`));

console.log("\n=== 5) 点遮罩空白处关闭 ===");
await run(`document.querySelector('.st-panel').dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:8, clientY:8}))`);
await wait(300);
console.log("关闭后 settings-open:", await run(`document.querySelector('.body').classList.contains('settings-open')`));
await shot("closed");

console.log("\n=== 6) 再开一次走 Esc 关闭 ===");
await run(`document.querySelector('.tbar-right .iconbtn[title="设置"]').click()`);
await wait(300);
await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
await wait(200);
console.log("Esc 后 settings-open:", await run(`document.querySelector('.body').classList.contains('settings-open')`));

console.log("\n控制台异常:", problems.length ? problems : "无");
ws.close();
