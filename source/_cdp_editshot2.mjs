// 编辑区着色取证：造一份含各类 Markdown 构造的临时文档 → 打开 → Ctrl+E 进编辑 → 抓 token 类名与截图
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 9223;
const dir = path.join(os.tmpdir(), "folio-hlshot-" + process.pid);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "hl-sample.md");
fs.writeFileSync(file, `# H1 标题

段落里有 **粗体**、*斜体*、~~删除线~~、\`行内代码\`、[链接文字](https://example.com "标题")、自动链接 <https://x.io>。

## H2 列表

- 无序项一
- [ ] 待办
- [x] 已完成
  - 嵌套项

1. 有序项

> 引用行，含 **粗体**。

| 列 A | 列 B |
| --- | --- |
| 1 | 2 |

---

\`\`\`js
const x = 1; // 注释
function f(a, b) { return a + b; }
\`\`\`

正文结束。
`);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
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
  }
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send("Runtime.enable");
await send("Page.enable");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (e, ap = false) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: ap });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result?.value;
};

for (let i = 0; i < 40; i++) {
  if (await run(`!!document.querySelector(".rail button")`)) break;
  await wait(300);
}

// 走真实 UI：先 open_doc 让它进「最近打开」，再在面板里点开那一行（避免直接改 store 状态失真）
await run(`(async () => { await (window.__TAURI_INTERNALS__?.invoke)("open_doc", { path: ${JSON.stringify(file)} }); return 1; })()`, true);
await wait(500);
await run(`[...document.querySelectorAll(".rail button")].find(b=>b.title.startsWith("最近打开"))?.click()`);
await wait(400);
const opened = await run(`(() => {
  const row = [...document.querySelectorAll(".side-body .tf")].find(e => (e.title||"").startsWith(${JSON.stringify(file)}));
  if (row) row.click();
  return !!row;
})()`);
console.log("从最近打开点开样本文档:", opened);
await wait(900);
// 进编辑模式（Ctrl+E 走全局 keydown）
await run(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true }))`);
await wait(1000);

console.log("=== 编辑区 token 类名与实测颜色 ===");
console.log(await run(`(() => {
  const spans = [...document.querySelectorAll(".cm-content .cm-line span[class]")].filter(s=>/cmx-|cm-bullet/.test(s.className));
  const seen = new Map();
  for (const s of spans) {
    const cls = s.className;
    if (seen.has(cls)) continue;
    const cs = getComputedStyle(s);
    seen.set(cls, { color: cs.color, weight: cs.fontWeight, style: cs.fontStyle,
      deco: cs.textDecorationLine, bg: cs.backgroundColor, text: s.textContent.slice(0, 18) });
  }
  return { 类名统计: Object.fromEntries(seen),
    围栏行: document.querySelectorAll(".cm-fence-line").length,
    引用行: document.querySelectorAll(".cm-quote-line").length,
    子弹: document.querySelectorAll(".cm-bullet").length };
})()`));
console.log("\n=== 编辑区整体是否有着色（无 class 的纯文本比例）===");
console.log(await run(`(() => {
  const all = [...document.querySelectorAll(".cm-content .cm-line span")];
  const ours = all.filter(s => /cmx-|cm-bullet/.test(s.className));
  const stray = all.filter(s => !/cmx-|cm-bullet/.test(s.className) && getComputedStyle(s).color !== getComputedStyle(document.querySelector(".cm-content")).color);
  return { spans: all.length, 我们的着色: ours.length, 仍被默认配色染色的: stray.length,
    样例: stray.slice(0, 4).map(s => s.textContent.slice(0, 12) + " → " + getComputedStyle(s).color) };
})()`));
const { data } = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("_edits_hot_after.png", Buffer.from(data, "base64"));
console.log("\n📄 _edits_hot_after.png");
console.log("异常：", problems.length ? problems.join("\n") : "无");

await run(`(async () => {
  const inv = window.__TAURI_INTERNALS__?.invoke;
  await inv("remove_doc", { id: window.__probeDocId });
  return "unregistered";
})()`, true).catch(() => console.log("（登记清理需手动：remove_doc 已下线，跳过）"));
fs.rmSync(dir, { recursive: true, force: true });
ws.close();
process.exit(0);
