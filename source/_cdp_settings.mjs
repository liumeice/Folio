// 设置中心实机核对：层次（分组/卡片/每行 hint）+ 每个控件驱动到 CSS 变量/正文计算值 + 恢复默认边界 + 持久化 + 截图
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
const run = async (e, ap = false) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: ap });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 240));
  return r.result?.value;
};
const shot = async (n) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  (await import("node:fs")).writeFileSync(`_st_${n}.png`, Buffer.from(data, "base64"));
  console.log("  📄", `_st_${n}.png`);
};
const varv = (name) => run(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);

for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(900);
console.log("资源指纹:", await run(`JSON.stringify([...document.querySelectorAll("link[rel=stylesheet]")].map(l=>l.href))`));

console.log("\n=== 1) 打开设置面板 + 层次结构 ===");
await run(`document.querySelector("#btn-font").click()`);
await wait(500);
console.log(await run(`({
  打开: document.querySelector(".st-panel")?.classList.contains("open"),
  宽度: getComputedStyle(document.querySelector(".st-panel")).width,
  抬头: document.querySelector(".st-title")?.textContent,
  分组: [...document.querySelectorAll(".st-group-title")].map(e=>e.textContent),
  卡片数: document.querySelectorAll(".st-card").length,
  行数: document.querySelectorAll(".st-row").length,
  带hint的行: document.querySelectorAll(".st-row .st-hint").length,
  控件: { stepper: document.querySelectorAll(".st-btn").length/2|0, segment: document.querySelectorAll(".st-radios").length, range: document.querySelectorAll(".st-slider").length },
  预览: !!document.querySelector(".st-sample"),
})`));
await shot("open");

// 每个控件拨一下，看它声称要驱动的东西是否真的变
const stepBy = (label, dir) => run(`(() => {
  const row=[...document.querySelectorAll('.st-row')].find(r=>r.querySelector('.st-label')?.textContent===${JSON.stringify(label)});
  if(!row) return null;
  const b=row.querySelectorAll('.st-btn')[${dir > 0 ? 1 : 0}];
  if(!b) return "no-stepper";
  b.click(); return true;
})()`);
const segBy = (label, txt) => run(`(() => {
  const row=[...document.querySelectorAll('.st-row')].find(r=>r.querySelector('.st-label')?.textContent===${JSON.stringify(label)});
  if(!row) return null;
  const b=[...row.querySelectorAll('.st-radio')].find(x=>x.textContent.trim()===${JSON.stringify(txt)});
  if(!b) return "no-option"; b.click(); return true;
})()`);
const rangeTo = (label, frac) => run(`(async () => {
  const row=[...document.querySelectorAll('.st-row')].find(r=>r.querySelector('.st-label')?.textContent===${JSON.stringify(label)});
  const el=row?.querySelector('.st-slider'); if(!el) return "no-range";
  el.value=String(Number(el.min)+${frac}*(Number(el.max)-Number(el.min)));
  el.dispatchEvent(new Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,300)); return el.value;
})()`, true);

console.log("\n=== 2) 控件 → 正文/变量 实际驱动 ===");
const probe = [];
probe.push(["主题→data-theme", await segBy("主题", "浅色"), await run(`document.documentElement.dataset.theme`)]);
await segBy("主题", "深色");
probe.push(["侧栏宽度 stepper→--w-side", await stepBy("侧栏宽度", 1), await varv("--w-side")]);
const fs0 = await varv("--prose-fs");
await stepBy("正文字号", 1); await stepBy("正文字号", 1);
probe.push(["正文字号 stepper→--prose-fs", `${fs0}→`, await varv("--prose-fs")]);
const lhLo = await varv("--prose-lh"); await rangeTo("行高", 0.95);
probe.push(["行高 range→--prose-lh", `${lhLo}→`, await varv("--prose-lh")]);
await rangeTo("字距", 1);
probe.push(["字距 range→正文 letterSpacing", "→", await run(`getComputedStyle(document.querySelector('.prose')).letterSpacing`)]);
await rangeTo("行宽", 1);
probe.push(["行宽 range→.prose maxWidth", "→", await run(`getComputedStyle(document.querySelector('.prose')).maxWidth`)]);
await stepBy("代码字号", 1);
probe.push(["代码字号 stepper→--code-fs", "→", await varv("--code-fs")]);
await segBy("表格密度", "宽松");
probe.push(["表格密度→.prose 类", "→", await run(`[...document.querySelector('.prose').classList].filter(c=>c.startsWith('density')).join(',')`)]);
await segBy("对齐方式", "两端对齐");
probe.push(["对齐→.prose textAlign", "→", await run(`getComputedStyle(document.querySelector('.prose')).textAlign`)]);
for (const [name, act, result] of probe) console.log(`  ${name}: 操作=${JSON.stringify(act)} 结果=${JSON.stringify(result)}`);

console.log("\n=== 3) 预览是否与正文同源 ===");
console.log(await run(`(() => {
  const a=getComputedStyle(document.querySelector('.st-sample')), p=getComputedStyle(document.querySelector('.prose'));
  return { 样张字号: a.fontSize, 正文字号: p.fontSize, 同源: a.fontSize===p.fontSize,
    样张对齐: a.textAlign, 正文对齐: p.textAlign };
})()`));
await shot("tweaked");

console.log("\n=== 4) 恢复默认：排版回落，主题/侧栏宽度不该被动 ===");
const beforeTheme = await run(`document.documentElement.dataset.theme`);
const beforeSide = await varv("--w-side");
await run(`[...document.querySelectorAll('.st-foot .st-action')].find(b=>b.textContent.includes('恢复默认')).click()`);
await wait(500);
console.log({ 恢复后lh: await varv("--prose-lh"), ls: await varv("--prose-ls"), align: await varv("--prose-align"),
  width: await varv("--prose-w"), code: await varv("--code-fs"),
  主题未被改: (await run(`document.documentElement.dataset.theme`)) === beforeTheme,
  侧栏未被改: await varv("--w-side") === beforeSide });

console.log("\n=== 5) 持久化：改行高 → 刷新 → 还在；面板不该自动开 ===");
await run(`document.querySelector("#btn-font").click()`); await wait(300);
await rangeTo("行高", 0.85);
const savedLh = await run(`(async () => (await window.__TAURI_INTERNALS__.invoke("get_settings")).lh)()`, true);
await send("Page.reload", { ignoreCache: false });
for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(1200);
console.log({ 刷新前落库: savedLh, 刷新后变量: await varv("--prose-lh"),
  面板不该自动开: await run(`!document.querySelector('.st-panel')?.classList.contains('open')`) });

console.log("\n=== 6) Esc 分层关闭 ===");
await run(`document.querySelector("#btn-font").click()`); await wait(300);
console.log("关掉了:", await run(`(async () => {
  document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  await new Promise(r=>setTimeout(r,300));
  return !document.querySelector('.st-panel')?.classList.contains('open');
})()`, true));
// 收尾：恢复默认排版，别把行高留在拨动值上交给用户
await run(`document.querySelector("#btn-font").click()`); await wait(300);
await run(`[...document.querySelectorAll('.st-foot .st-action')].find(b=>b.textContent.includes('恢复默认')).click()`); await wait(400);
// 侧栏宽度不在「恢复默认」范畴（那是用户拖动决定的），但探针不该把它留在拨动值上：写回默认
await run(`(async () => { const inv=window.__TAURI_INTERNALS__.invoke; const s=await inv("get_settings"); s.sideWidth=null; await inv("set_settings",{settings:s}); })()`, true);
console.log("收尾 lh:", await varv("--prose-lh"));
console.log("\n异常:", problems.length ? problems.slice(0, 8).join("\n") : "无");
ws.close(); process.exit(0);
