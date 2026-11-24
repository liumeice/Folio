// 多语言设置面板布局实机探针：中/英两态量导航折行、主题行控件是否掉行、hint 行数；
// 结束恢复现场（语言回到探测前的偏好、关闭设置面板）。运行：node _cdp_i18n_layout.mjs
const PORT = 9223;
let page = null;
for (let i = 0; i < 120; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = list.find((t) => t.type === "page");
    if (page) break;
  } catch { /* dev 窗口未就绪 */ }
  await new Promise((r) => setTimeout(r, 500));
}
if (!page) { console.error("未找到 CDP 页面（确认 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 且窗口已启动）"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const problems = [];
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => pending.set(i, { res, rej })); };
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
  else if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails.exception?.description ?? "异常");
};
await new Promise((r) => (ws.onopen = r));
await send("Runtime.enable"); await send("Page.enable");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};
const shot = async (n) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  (await import("node:fs")).writeFileSync(`_st_i18n_${n}.png`, Buffer.from(data, "base64"));
  console.log("  📄", `_st_i18n_${n}.png`);
};

// 等应用挂载
for (let i = 0; i < 80; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(800);
console.log("资源指纹:", await run(`JSON.stringify([...document.querySelectorAll("script[src]")].map(s=>s.src))`));

const measure = `(() => {
  const rows = [...document.querySelectorAll('.st-row')];
  const stabs = [...document.querySelectorAll('.stabs')];
  const nav = stabs[0];
  const themeRow = rows[0];
  const info = themeRow?.querySelector('.st-info');
  const ctl = themeRow?.querySelector('.st-ctlbox');
  const hint = themeRow?.querySelector('.st-hint');
  const lh = hint ? (parseFloat(getComputedStyle(hint).lineHeight) || 19.5) : 19.5;
  const r = (el) => el ? el.getBoundingClientRect() : null;
  const body = document.querySelector('.st-body');
  return {
    lang: document.documentElement.lang,
    winW: Math.round(r(document.querySelector('.st-win')).width),
    navW: Math.round(r(nav).width),
    stabs: [...nav.querySelectorAll('.stab')].map(s => ({
      t: s.textContent.trim(),
      h: Math.round(r(s).height), sh: s.scrollHeight, ch: s.clientHeight,
      over: s.scrollWidth > s.clientWidth + 1,
    })),
    themeRow: themeRow ? {
      h: Math.round(r(themeRow).height),
      infoTop: Math.round(r(info).top), ctlTop: Math.round(r(ctl).top),
      infoW: Math.round(r(info).width), ctlW: Math.round(r(ctl).width),
      hintH: Math.round(r(hint).height), hintLines: Math.round(r(hint).height / lh),
    } : null,
    rowHeights: rows.map(x => Math.round(r(x).height)),
    body: body ? { scrollH: body.scrollHeight, clientH: body.clientHeight } : null,
  };
})()`;

console.log("\n=== 打开设置面板 ===");
// 仅在未打开时点齿轮（.iconbtn 内查找，避免命中菜单里的同名 use）
await run(`(() => {
  if (document.querySelector('.body')?.classList.contains('settings-open')) return;
  [...document.querySelectorAll('.iconbtn')].find((b) => b.querySelector('use[href="#i-sliders"]'))?.click();
})()`);
await wait(500);
console.log("面板状态:", await run(`getComputedStyle(document.querySelector('#settings-panel')).display`));
const prefBefore = await run(`(() => { const b = document.querySelector('.lang-select'); return b ? b.textContent.trim() : '(无语言按钮)'; })()`);
console.log("当前语言按钮:", prefBefore);
// 记录原始选择的菜单项索引，结束时恢复现场（跟随系统=0 / 简体中文=1 / English=2）
const origIndex = /跟随系统|System/.test(prefBefore) ? 0 : prefBefore.includes("简体中文") ? 1 : prefBefore.includes("English") ? 2 : 0;
const zh = await run(measure);
console.log("中文态:", JSON.stringify(zh, null, 1));
await shot("zh");

console.log("\n=== 切到 English ===");
await run(`document.querySelector('.lang-select')?.click()`);
await wait(350);
await run(`(() => { const it = [...document.querySelectorAll('.lang-item')].find(b => b.textContent.includes('English')); it?.click(); })()`);
await wait(700);
const en = await run(measure);
console.log("英文态:", JSON.stringify(en, null, 1));
await shot("en");

console.log("\n=== 结论 ===");
const stabWrapped = en.stabs.filter((s) => s.h > 33 || s.over);
console.log(stabWrapped.length ? `❌ 导航折行/溢出：${JSON.stringify(stabWrapped)}` : "✅ 导航全部单行");
console.log(en.themeRow && en.themeRow.ctlTop - en.themeRow.infoTop > 30 ? "❌ 主题行控件掉到下一排" : "✅ 主题行控件与文字同一排");
console.log(`✅ hint 行数（英文）：${en.themeRow?.hintLines}（高度 ${en.themeRow?.hintH}px）`);
console.log(`设置正文滚动：${en.body?.scrollH} / ${en.body?.clientH}`);

// 恢复现场：语言回到探测前的偏好（按原按钮标签映射的索引），关闭设置
await run(`document.querySelector('.lang-select')?.click()`);
await wait(300);
await run(`(() => { const it = [...document.querySelectorAll('.lang-item')][${origIndex}]; it?.click(); })()`);
await wait(500);
await run(`document.querySelector('.mfb .st-action.primary')?.click()`);
await wait(300);
console.log("\n已恢复：语言回「跟随系统」、关闭设置面板。异常：", problems.length ? problems : "无");
ws.close();