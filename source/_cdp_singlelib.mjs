// v4 单库策略实机核对：迁移净效果 → 空库 UI → 用临时目录跑一遍"切换库"→ 关闭 → 复原检查
// 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动 folio-app.exe
// 只碰临时目录，不动用户真实库路径；结束后临时目录会删掉。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 9223;
const scratch = path.join(os.tmpdir(), "folio-singlelib-" + process.pid);
const A = path.join(scratch, "libA");
const B = path.join(scratch, "libB");
fs.mkdirSync(A, { recursive: true });
fs.mkdirSync(B, { recursive: true });
fs.writeFileSync(path.join(A, "one.md"), "# One\n\n甲\n");
fs.writeFileSync(path.join(A, "two.md"), "# Two\n\n乙\n");
fs.writeFileSync(path.join(B, "three.md"), "# Three\n\n丙\n");

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const problems = [];
function send(m, p = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    problems.push("异常: " + (msg.params.exceptionDetails.exception?.description ?? ""));
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    problems.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send("Runtime.enable");
await send("Page.enable");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(expr, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`_v4shot_${name}.png`, Buffer.from(data, "base64"));
  console.log("  📄", `_v4shot_${name}.png`);
}
const INVOKE = `(async (cmd, args) => {
  const inv = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;
  return inv(cmd, args ?? {});
})`;

for (let i = 0; i < 40; i++) {
  if (await run(`!!document.querySelector(".rail button")`)) break;
  await wait(300);
}

console.log("=== 1) v4 迁移后的真实库状态（应：roots 空、库成员 0，其余一项不少）===");
console.log(await run(`${INVOKE}("list_roots")`, true));
const docs = await run(`${INVOKE}("list_docs")`, true);
console.log("登记", docs.length, "· 在库", docs.filter((d) => d.inLibrary).length,
  "· 置顶", docs.filter((d) => d.pinned).length, "· 内置", docs.filter((d) => d.builtin).length);
console.log("历史", (await run(`${INVOKE}("list_recents")`, true)).length,
  "条 · 进度", (await run(`${INVOKE}("get_positions")`, true)).length, "条");

console.log("\n=== 2) 空库 UI：只给目录入口 ===");
await run(`[...document.querySelectorAll(".rail button")].find(b=>b.title.startsWith("文档库"))?.click()`);
await wait(400);
console.log(await run(`({
  chipText: document.querySelector(".root-chip")?.innerText.replace(/\\s+/g," ").trim(),
  chipActions: document.querySelectorAll(".root-chip .ract").length,
  empty: document.querySelector(".ol-empty")?.innerText.replace(/\\s+/g," "),
  primary: [...document.querySelectorAll(".btn.primary")].map(b=>b.textContent.trim()),
})`));
await shot("empty");

console.log("\n=== 3) 打开库 A（两个文件）===");
console.log(await run(`${INVOKE}("scan_folder", { root: ${JSON.stringify(A)} })`, true));
console.log("roots:", await run(`${INVOKE}("list_roots")`, true));

console.log("\n=== 4) 切换到库 B：应报出被关的 A 与出库条数 ===");
console.log(await run(`${INVOKE}("scan_folder", { root: ${JSON.stringify(B)} })`, true));
console.log("roots（最多一行）:", await run(`${INVOKE}("list_roots")`, true));
const after = await run(`${INVOKE}("list_docs")`, true);
const mine = after.filter((d) => d.path.startsWith(scratch));
console.log("临时条目归属：", mine.map((d) => `${path.basename(d.path)}=${d.inLibrary ? "在库" : "出库"}`).join(" · "));
console.log("用户 145+7 篇未被牵连：", after.filter((d) => !d.path.startsWith(scratch)).length, "条登记仍在");

await send("Page.reload", { ignoreCache: false });
for (let i = 0; i < 40; i++) {
  if (await run(`!!document.querySelector(".rail button")`)) break;
  await wait(300);
}
await wait(600);
await run(`[...document.querySelectorAll(".rail button")].find(b=>b.title.startsWith("文档库"))?.click()`);
await wait(400);
console.log("\n=== 5) 切换后的树与 chip（应只剩 B 的 1 篇）===");
console.log(await run(`({
  chipText: document.querySelector(".root-chip")?.innerText.replace(/\\s+/g," ").trim(),
  chipTitle: document.querySelector(".root-chip")?.title.replace(/\\n/g," ⏎ "),
  dirRows: [...document.querySelectorAll(".tf.dir")].map(d=>d.querySelector(".nm").textContent),
  fileRows: [...document.querySelectorAll(".side-body .tf:not(.dir)")].map(f=>f.querySelector(".nm").textContent),
  foot: document.querySelector(".side-foot")?.innerText.replace(/\\s+/g," "),
})`));
await shot("switched");

console.log("\n=== 6) ✕ 关闭当前库（remove_root）→ 回到空库 ===");
console.log("出库条数:", await run(`${INVOKE}("remove_root", { path: ${JSON.stringify(B)} })`, true));
console.log("roots:", await run(`${INVOKE}("list_roots")`, true));
const fin = await run(`${INVOKE}("list_docs")`, true);
console.log("全部登记仍在：", fin.length, "条 · 在库：", fin.filter((d) => d.inLibrary).length);
console.log("临时文件仍在磁盘：", fs.existsSync(path.join(B, "three.md")));

fs.rmSync(scratch, { recursive: true, force: true });
console.log("\n=== 异常汇总 ===");
console.log(problems.length ? problems.slice(0, 8).join("\n") : "（无）");
ws.close();
process.exit(0);
