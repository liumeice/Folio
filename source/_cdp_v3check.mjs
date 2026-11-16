// v3 库/历史解耦的实机核对：连 WebView2 调试口 → 走一遍两个面板 → 截图 + DOM 断言 + 控制台异常
// 用法：set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 && target\release\folio-app.exe
//      node _cdp_v3check.mjs ["D:\\path\\to\\docs"]   // 传目录则顺带登记为库根（用于恢复本机被误关的库）
const PORT = 9223;
const SCAN_ROOT = process.argv[2];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const problems = [];
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
  } else if (msg.method === "Runtime.exceptionThrown") {
    problems.push("异常: " + (msg.params.exceptionDetails.exception?.description
      ?? msg.params.exceptionDetails.text));
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    problems.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send("Runtime.enable");
await send("Page.enable");

async function run(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const fs = await import("node:fs");
  const f = `_v3shot_${name}.png`;
  fs.writeFileSync(f, Buffer.from(data, "base64"));
  console.log("  📄", f);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 页内探针：面板快照
async function inject() {
  await run(`(() => {
  window.__snap = () => {
    const txt = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.replace(/\\s+/g, " ").trim());
    const dirs = [...document.querySelectorAll(".tf.dir")];
    return {
      sideTitle: txt(".side-title").join(" | "),
      chip: txt(".root-chip").join(" · "),
      closeBtn: !!document.querySelector("#lib-close"),
      rescanBtn: !!document.querySelector("#lib-rescan"),
      dirRows: dirs.length,
      dirDetail: dirs.slice(0, 10).map((d) =>
        d.querySelector(".nm").textContent + " pad=" + (d.style.paddingLeft || "0") +
        " n=" + (d.querySelector(".mt")?.textContent ?? "?")),
      fileRows: document.querySelectorAll(".side-body .tf:not(.dir)").length,
      groups: txt(".sec-h").filter(Boolean).slice(0, 12),
      badges: txt(".side-body .badge").slice(0, 12),
      firstRows: txt(".side-body .tf").slice(0, 4),
      empty: document.querySelector(".ol-empty")?.innerText.replace(/\\s+/g, " ") ?? null,
      primary: txt(".btn.primary"),
      foot: document.querySelector(".side-foot")?.innerText.replace(/\\s+/g, " ") ?? "",
      railTitles: [...document.querySelectorAll(".rail button")].map((b) => b.title.split("\\n")[0]),
    };
  };
  window.__rail = (n) => {
    const b = [...document.querySelectorAll(".rail button")].find((x) => x.title.startsWith(n));
    if (b) b.click();
    return !!b;
  };
  return true;
})()`);
}

// 等首屏就绪（骨架揭幕 = 有 .rail 且 splash 已 gone）
for (let i = 0; i < 40; i++) {
  const ok = await run(`!!document.querySelector(".rail button") && !!document.querySelector(".side")`);
  if (ok) break;
  await wait(300);
}

await inject();   // 首屏就绪后注入页内探针（reload 之后还要再注入一次）

console.log("\n=== 1) 文档库面板（当前库根状态）===");
console.log("rail:", JSON.stringify(await run(`__snap().railTitles`)));
await run(`__rail("文档库")`);
await wait(400);
const s1 = await run(`JSON.stringify(__snap())`);
console.log(s1);
await shot("library");

if (SCAN_ROOT) {
  console.log("\n=== 2) 登记库根并扫描（恢复本机库）===", SCAN_ROOT);
  const rep = await run(
    `(async () => {
       const inv = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;
       if (!inv) return "no invoke";
       return await inv("scan_folder", { root: ${JSON.stringify(SCAN_ROOT)} });
     })()`,
    true);
  console.log("  scan:", JSON.stringify(rep));
  await send("Page.reload", { ignoreCache: false });
  await wait(800);
  await inject();   // 刷新后页内 helper 随文档一起没了，必须重注入
  for (let i = 0; i < 40; i++) {
    if (await run(`!!document.querySelector(".rail button")`)) break;
    await wait(300);
  }
  await wait(600);
  console.log("\n=== 3) 文档库目录树 ===");
  await run(`__rail("文档库")`);
  await wait(500);
  console.log(await run(`JSON.stringify(__snap())`));
  await shot("tree");
}

console.log("\n=== 4) 最近打开面板 ===");
await run(`__rail("最近打开")`);
await wait(500);
console.log(await run(`JSON.stringify(__snap())`));
await shot("recents");

console.log("\n=== 5) chip 设计：只显示路径 + 框内 ⟳/✕ ===");
await run(`__rail("文档库")`);
await wait(400);
console.log(await run(`(() => {
  const chip = document.querySelector(".root-chip");
  const title = document.querySelector(".side-title");
  return {
    chipText: chip?.innerText.replace(/\\s+/g, " ").trim(),
    rescanInChip: !!chip?.querySelector("#lib-rescan"),
    closeInChip: !!chip?.querySelector("#lib-close"),
    titleButtons: title ? title.querySelectorAll("span[id]").length : -1,
    foot: document.querySelector(".side-foot")?.innerText.replace(/\\s+/g, " "),
  };
})()`));
await shot("chip");

console.log("\n=== 6) 库根管理器（点 chip 打开）===");
await run(`document.querySelector("#lib-root-chip")?.click()`);
await wait(250);   // 点击与读取分两次求值：Solid 的 Show 更新在本轮事件末尾才落 DOM
console.log(await run(`(() => {
  const m = document.querySelector(".ctxmenu");
  return m ? {
    head: m.querySelector(".mgrp")?.textContent,
    rows: [...m.querySelectorAll(".mi")].map(e => e.textContent.replace(/\\s+/g, " ").trim()),
    rescanActs: m.querySelectorAll(".mi .ract[title^='重新扫描']").length,
    closeActs: m.querySelectorAll(".mi .ract[title^='关闭']").length,
  } : { head: null };
})()`));
await wait(300);
await shot("manager");
await run(`document.body.click()`);   // 关掉菜单，别把弹层留给下一张截图

console.log("\n=== 异常汇总 ===");
console.log(problems.length ? problems.slice(0, 10).join("\n") : "（无）");
ws.close();
process.exit(0);
