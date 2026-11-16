// 编辑区着色核对：把每个 token 的实测颜色与 CSS 变量期望值直接比对（不靠肉眼猜）
// 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动 folio-app.exe
const PORT = 9223;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
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
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result?.value;
};
const shot = async (n) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  (await import("node:fs")).writeFileSync(`_hl_${n}.png`, Buffer.from(data, "base64"));
  console.log("  📄", `_hl_${n}.png`);
};

for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(800);
console.log("当前文档:", await run(`document.querySelector(".tabs .tab")?.innerText?.trim() ?? "(无)"`));

await run(`document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"e",ctrlKey:true,bubbles:true}))`);
await wait(1200);

const res = await run(`(() => {
  const cs = getComputedStyle(document.documentElement);
  const tok = (n) => cs.getPropertyValue(n).trim();
  const toRGB = (c) => { const d = document.createElement("div"); d.style.color = c; document.body.appendChild(d);
    const v = getComputedStyle(d).color; d.remove(); return v; };
  const expect = {
    "cmx-head": tok("--accent"), "cmx-mark": tok("--text-3"), "cmx-strong": tok("--text"),
    "cmx-em": tok("--text-2"), "cmx-del": tok("--text-3"), "cmx-code": tok("--accent-dim"),
    "cmx-link": tok("--accent"), "cmx-url": tok("--text-3"), "cmx-quote": tok("--text-2"),
    "cmx-task": tok("--accent"), "cmx-rule": tok("--text-3"), "cmx-info": tok("--text-3"),
    "cm-bullet": tok("--s-bullet"),
  };
  const found = {};
  for (const cls of Object.keys(expect)) {
    const el = document.querySelector(".cm-content span." + cls + ", .cm-content ." + cls);
    if (el) found[cls] = { 实测: getComputedStyle(el).color, 期望: toRGB(expect[cls]),
      字重: getComputedStyle(el).fontWeight, 下划线: getComputedStyle(el).textDecorationLine,
      文本样例: el.textContent.slice(0, 16) };
  }
  // 默认配色残留检查：非我们的类、却染了色的 span
  const base = getComputedStyle(document.querySelector(".cm-content")).color;
  const stray = [...document.querySelectorAll(".cm-content span")]
    .filter(s => !/cmx-|cm-bullet/.test(s.className) && getComputedStyle(s).color !== base)
    .slice(0, 6).map(s => s.textContent.slice(0, 14) + " → " + getComputedStyle(s).color + " (" + s.className + ")");
  return {
    主题: document.documentElement.dataset.theme,
    出现的类: Object.keys(found),
    逐类比对: found,
    围栏行数: document.querySelectorAll(".cm-fence-line").length,
    引用行数: document.querySelectorAll(".cm-quote-line").length,
    子弹数: document.querySelectorAll(".cm-bullet").length,
    默认配色残留: stray,
    正文色: base,
  };
})()`);
console.log(JSON.stringify(res, null, 1));

// 浅主题再比一次（token 变量必须跟着换）
await run(`document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"e",ctrlKey:true,bubbles:true}))`);
await wait(400);
const toggled = await run(`(() => {
  const btns = [...document.querySelectorAll(".tbar button, .tbar span, .rail button")];
  const b = btns.find(x => (x.title || "").includes("主题"));
  if (b) b.click();
  return !!b;
})()`);
await wait(500);
await run(`document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"e",ctrlKey:true,bubbles:true}))`);
await wait(900);
console.log("\n浅主题核对:", await run(`(() => {
  const cs = getComputedStyle(document.documentElement);
  const el = document.querySelector(".cm-content .cmx-head");
  const mark = document.querySelector(".cm-content .cmx-mark");
  return { theme: document.documentElement.dataset.theme,
    切换成功: ${JSON.stringify(toggled)},
    head实测: el ? getComputedStyle(el).color : "未见标题行",
    head期望: cs.getPropertyValue("--accent").trim(),
    mark实测: mark ? getComputedStyle(mark).color : null,
    mark期望: cs.getPropertyValue("--text-3").trim() };
})()`));
await shot("light");
// 切回深主题，别把用户的偏好改走
await run(`(() => { const b = [...document.querySelectorAll(".tbar button, .tbar span, .rail button")].find(x => (x.title||"").includes("主题")); b?.click(); })()`);
await wait(300);
await run(`document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"e",ctrlKey:true,bubbles:true}))`);
await wait(600);
await shot("dark");
console.log("\n异常:", problems.length ? problems.slice(0, 6).join("\n") : "无");
ws.close(); process.exit(0);
