// 公式/图表真窗口取证（一次性脚本，_cdp_* 惯例）：连 9223 → DOM 探针 + 控制台异常 + 截图
// 前置：taskkill folio-app → set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
//       → 启动 exe 并带 sample.md 路径参数 → 等 ~9s → node _cdp_mathcheck.mjs
const PORT = 9223;
const OUT = new URL("../artifacts/formula-smoke/_webview_shot.png", import.meta.url);
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
  } else if (msg.method) events.push(msg);
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");
await new Promise((r) => setTimeout(r, 1500));

const probe = `(() => {
  const q = (s) => [...document.querySelectorAll(s)];
  const art = document.querySelector("#scroll-area article") || document.body;
  const pText = (art.querySelector("p")?.textContent) || "";
  return JSON.stringify({
    docTitle: art.querySelector("h1")?.textContent?.trim() || "(无 h1)",
    mathTotal: q("[data-math]", ).length,
    mathReady: art.querySelectorAll(".f-block.f-ready[data-math], [data-math].f-ready").length,
    mathError: art.querySelectorAll("[data-math].f-error").length,
    mathPending: art.querySelectorAll(".f-block[data-math]:not(.f-ready):not(.f-error)").length,
    mathSvg: art.querySelectorAll("[data-math] svg").length,
    mermaidTotal: art.querySelectorAll("[data-mermaid]").length,
    mermaidReady: art.querySelectorAll("[data-mermaid].f-ready svg").length,
    mermaidError: art.querySelectorAll("[data-mermaid].f-error").length,
    mermaidPending: art.querySelectorAll(".f-block[data-mermaid]:not(.f-ready):not(.f-error)").length,
    fallbackPres: art.querySelectorAll(".formula-fallback").length,
    currencyLiteral: pText.includes("$5") && pText.includes("$10"),
    secAnchors: art.querySelectorAll("[data-sec]").length,
    secList: art.querySelectorAll("[data-sec]").length ? [...new Set([...art.querySelectorAll("[data-sec]")].map(h => h.getAttribute("data-sec")))].join(",") : "",
    taskMarks: art.querySelectorAll("[data-task]").length,
    outlineRows: q(".ol-item, .outline-item, #side li").length,
    fontsOk: !!window.MathJax && !!(window.MathJax.startup && window.MathJax.startup.document),
    mermaidGlobal: typeof window.mermaid,
    imgRemoteLoaded: q("img[src^='http'], img[src^='//']").length,
  });
})()`;

const res = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
console.log("PROBE:", res.result?.value ?? JSON.stringify(res));

const errs = events.filter((e) =>
  e.method === "Runtime.exceptionThrown" ||
  (e.method === "Runtime.consoleAPICalled" && ["error"].includes(e.params.type)) ||
  e.method === "Log.entryAdded");
console.log("异常/错误条数:", errs.length);
for (const e of errs.slice(0, 10)) {
  if (e.method === "Runtime.exceptionThrown") {
    const d = e.params.exceptionDetails;
    console.log("EXC:", d.exception?.description || d.text);
  } else if (e.method === "Runtime.consoleAPICalled") {
    console.log("CONSOLE:", e.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  } else {
    console.log("LOG:", e.params.entry.text.slice(0, 160));
  }
}

const shot = await send("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
writeFileSync(OUT, Buffer.from(shot.data, "base64"));
console.log("SCREENSHOT →", OUT.pathname);
ws.close();
process.exit(0);
