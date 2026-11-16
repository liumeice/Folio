// 文档库树：默认只展开一层 / 全部展开 / 全部收起 / 当前文档 reveal
// 若本机没有已登记的库根，就用临时嵌套目录验证，结束后把原来的库根恢复回去
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const INVOKE = `(async (c,a) => window.__TAURI_INTERNALS__.invoke(c,a))`;
const shot = async (n) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`_tree_${n}.png`, Buffer.from(data, "base64"));
  console.log("  📄", `_tree_${n}.png`);
};

for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(800);
console.log("资源指纹:", await run(`JSON.stringify([...document.styleSheets].map(s=>s.href).filter(Boolean))`));

const originalRoots = await run(`${INVOKE}("list_roots")`, true);
console.log("当前库根:", originalRoots);

let scratch = null;
if (!originalRoots.length) {
  scratch = path.join(os.tmpdir(), "folio-tree-" + process.pid);
  for (const rel of ["L1/L2/L3", "L1/other", "root"]) fs.mkdirSync(path.join(scratch, rel), { recursive: true });
  fs.writeFileSync(path.join(scratch, "root", "r1.md"), "# 根下文件\n");
  fs.writeFileSync(path.join(scratch, "L1", "a.md"), "# A\n");
  fs.writeFileSync(path.join(scratch, "L1", "L2", "b.md"), "# B\n");
  fs.writeFileSync(path.join(scratch, "L1", "L2", "L3", "c.md"), "# C\n");
  fs.writeFileSync(path.join(scratch, "L1", "other", "d.md"), "# D\n");
  console.log("无已登记库根 → 用临时嵌套目录验证:", scratch);
  console.log(await run(`${INVOKE}("scan_folder", { root: ${JSON.stringify(scratch)} })`, true));
}

await run(`[...document.querySelectorAll(".rail button")].find(b=>b.title.startsWith("文档库"))?.click()`);
await wait(500);
const treeState = () => run(`(() => {
  const dirs = [...document.querySelectorAll(".tf.dir")];
  const files = [...document.querySelectorAll(".side-body .tf:not(.dir)")];
  return {
    目录行: dirs.map(d => d.querySelector(".nm").textContent + "@" + (d.style.paddingLeft||"0")),
    文件行: files.map(f => f.querySelector(".nm").textContent),
    展开按钮: !!document.querySelector("#lib-expand"),
    收起按钮: !!document.querySelector("#lib-collapse"),
  };
})()`);
console.log("\n默认展开状态（应只见库根的第一层）:");
console.log(await treeState());
await shot("default");

console.log("\n点「全部展开」:");
await run(`document.querySelector("#lib-expand").click()`);
await wait(600);
const wide = await treeState();
console.log(wide);
await shot("expanded");

console.log("\n点「全部收起」:");
await run(`document.querySelector("#lib-collapse").click()`);
await wait(600);
console.log(await treeState());
await shot("collapsed");

// 打开一个深层文档：它所在的目录链应自动露出来（即使刚全部收起）
if (scratch) {
  await run(`${INVOKE}("open_doc", { path: ${JSON.stringify(path.join(scratch, "L1", "L2", "L3", "c.md"))} })`, true);
  await run(`(() => { const r=[...document.querySelectorAll(".side-body .tf")].find(e=>(e.title||"").endsWith("c.md")); if(r) r.click(); return !!r; })()`);
  await wait(700);
  console.log("\n当前文档在 L1/L2/L3 → 祖先链 reveal:");
  console.log(await treeState());
  await shot("reveal");

  console.log("\n收尾：清空临时库根并恢复原状");
  console.log("remove_root →", await run(`${INVOKE}("remove_root", { path: ${JSON.stringify(scratch)} })`, true));
  for (const r of originalRoots) console.log("恢复", r, "→", await run(`${INVOKE}("scan_folder", { root: ${JSON.stringify(r)} })`, true));
  fs.rmSync(scratch, { recursive: true, force: true });
} else {
  console.log("\n（用了本机已有库根，未做任何扫描/清理）");
}

console.log("\n异常:", problems.length ? problems.slice(0, 6).join("\n") : "无");
console.log("最终库根:", await run(`${INVOKE}("list_roots")`, true));
ws.close();
process.exit(0);
