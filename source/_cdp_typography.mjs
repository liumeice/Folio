// 排版抽屉实机核对：每个控件推到区间两端，验证正文元素的计算样式真的跟着走；
// 再测样张同源性、恢复默认、重启持久化、Esc 分层退出。
// 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动 folio-app.exe
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
  (await import("node:fs")).writeFileSync(`_ty_${n}.png`, Buffer.from(data, "base64"));
  console.log("  📄", `_ty_${n}.png`);
};

for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(1000);
console.log("资源指纹:", await run(`JSON.stringify([...document.styleSheets].map(s=>s.href).filter(Boolean))`));
console.log("当前文档:", await run(`document.querySelector(".tabs .tab")?.innerText?.trim() ?? "(无)"`));

console.log("\n=== 1) 抽屉结构与控件清单 ===");
await run(`document.querySelector("#btn-font").click()`);
await wait(500);
console.log(await run(`({
  打开: document.querySelector(".tdrawer")?.classList.contains("open"),
  宽度: getComputedStyle(document.querySelector(".tdrawer")).width,
  分区: [...document.querySelectorAll(".td-sec")].map(e=>e.textContent),
  滑块: [...document.querySelectorAll(".tdrawer input[type=range]")].map(i=>i.getAttribute("aria-label")+"["+i.min+","+i.max+"]"),
  分段: [...document.querySelectorAll(".tdrawer .radios")].map(g=>[...g.children].map(x=>x.textContent).join("/")),
  样张: !!document.querySelector(".tsample"),
  底部: [...document.querySelectorAll(".td-foot .btn")].map(b=>b.textContent.trim()),
})`));
await shot("open");

// 推到两端看正文计算值是否变化：target 用选择器，prop 用驼峰 CSS 属性
const SWEEPS = [
  ["字级", ".prose", "fontSize", "衬线字号"],
  ["行高", ".prose", "lineHeight", ".prose 行高（px）"],
  ["字距", ".prose", "letterSpacing", "em → px"],
  ["行宽", ".prose", "maxWidth", ".prose 最大宽度"],
  ["代码字号", ".codeblock pre", "fontSize", "无代码块时跳过"],
  ["段距", ".prose p", "marginBottom", "段落 bottom margin"],
];
console.log("\n=== 2) 滑块推到两端 → 正文计算值 ===");
for (const [label, sel, prop, note] of SWEEPS) {
  const r = await run(`(async () => {
    const el = [...document.querySelectorAll('.tdrawer input[type=range]')].find(i => i.getAttribute('aria-label') === ${JSON.stringify(label)});
    const target = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { 控件: ${JSON.stringify(label)}, 结论: "✗ 没有这个滑块" };
    if (!target) return { 控件: ${JSON.stringify(label)}, 结论: "— 当前文档里没有 ${sel}，跳过（${note}）" };
    const set = (v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const read = () => getComputedStyle(target).${prop};
    const d0 = read();
    set(el.max); await new Promise(r => setTimeout(r, 300)); const hi = read();
    set(el.min); await new Promise(r => setTimeout(r, 300)); const lo = read();
    const moved = hi !== lo && hi !== d0;
    return { 控件: ${JSON.stringify(label)}, 区间: [el.min, el.max], 默认: d0, 上限: hi, 下限: lo,
      结论: moved ? "✓ 生效" : "✗ 正文没跟着变" };
  })()`, true);
  console.log(JSON.stringify(r));
}

console.log("\n=== 3) 对齐与表格密度 ===");
console.log(await run(`(async () => {
  const radios = [...document.querySelectorAll('.tdrawer .radio')];
  const click = (txt) => radios.find(x => x.textContent.trim() === txt)?.click();
  const ta = async (txt) => { click(txt); await new Promise(r => setTimeout(r, 300));
    return getComputedStyle(document.querySelector('.prose')).textAlign; };
  const align = { 两端: await ta("两端对齐"), 左: await ta("左对齐") };
  const dens = {};
  for (const [name, cls] of [["紧凑", "density-compact"], ["标准", "(无)"], ["宽松", "density-loose"]]) {
    click(name); await new Promise(r => setTimeout(r, 300));
    const has = [...document.querySelector('.prose').classList].filter(c => c.startsWith("density")).join("+") || "(无)";
    dens[name] = { 实测: has, 期望: cls, 对: has === cls };
  }
  return { align, dens };
})()`, true));

console.log("\n=== 4) 样张是否吃同一组变量 ===");
console.log(await run(`(() => {
  const cs = getComputedStyle(document.querySelector('.tsample'));
  const root = getComputedStyle(document.documentElement);
  const prose = getComputedStyle(document.querySelector('.prose'));
  return { 样张字号: cs.fontSize, 正文字号: prose.fontSize, 同源: cs.fontSize === prose.fontSize,
    样张字距: cs.letterSpacing, 正文字距: prose.letterSpacing,
    样张行高比: +(parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)).toFixed(2),
    变量lh: root.getPropertyValue('--prose-lh').trim() };
})()`));

console.log("\n=== 5) 恢复默认 ===");
console.log(await run(`(async () => {
  [...document.querySelectorAll('.td-foot .btn')].find(b => b.textContent.includes('恢复默认')).click();
  await new Promise(r => setTimeout(r, 600));
  const root = getComputedStyle(document.documentElement);
  return { fs: root.getPropertyValue('--prose-fs').trim(), lh: root.getPropertyValue('--prose-lh').trim(),
    ls: root.getPropertyValue('--prose-ls').trim(), para: root.getPropertyValue('--prose-para').trim(),
    w: root.getPropertyValue('--prose-w').trim(), align: root.getPropertyValue('--prose-align').trim(),
    code: root.getPropertyValue('--code-fs').trim(),
    toast: document.querySelector('.toast')?.innerText ?? null };
})()`, true));
await shot("reset");

console.log("\n=== 6) 改行高 2.15 → 刷新 → 是否还在 ===");
await run(`(async () => {
  const el = [...document.querySelectorAll('.tdrawer input[type=range]')].find(i => i.getAttribute('aria-label') === '行高');
  el.value = '2.15'; el.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
})()`, true);
const persisted = await run(`(async () => (await window.__TAURI_INTERNALS__.invoke("get_settings")).lh)()`, true);
await send("Page.reload", { ignoreCache: false });
for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(1400);
console.log({ 刷新前落库: persisted, 刷新后落库: await run(`(async () => (await window.__TAURI_INTERNALS__.invoke("get_settings")).lh)()`, true),
  刷新后变量: await run(`getComputedStyle(document.documentElement).getPropertyValue('--prose-lh').trim()`),
  抽屉不该自动开: await run(`!document.querySelector('.tdrawer')?.classList.contains('open')`) });

console.log("\n=== 7) Esc 分层关闭抽屉，然后收尾恢复默认 ===");
await run(`document.querySelector("#btn-font").click()`);
await wait(400);
console.log("开过之后再 Esc:", await run(`(async () => {
  document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  await new Promise(r => setTimeout(r, 400));
  return !document.querySelector('.tdrawer')?.classList.contains('open');
})()`, true));
await run(`(async () => {
  document.querySelector("#btn-font").click(); await new Promise(r => setTimeout(r, 300));
  [...document.querySelectorAll('.td-foot .btn')].find(b => b.textContent.includes('恢复默认')).click();
  await new Promise(r => setTimeout(r, 500));
})()`, true);
await run(`document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`);
console.log("最终 lh / ls / align:", await run(`(async () => { const s = await window.__TAURI_INTERNALS__.invoke("get_settings"); return [s.lh, s.letterSpacing, s.align]; })()`, true));
console.log("\n异常:", problems.length ? problems.slice(0, 8).join("\n") : "无");
ws.close(); process.exit(0);
