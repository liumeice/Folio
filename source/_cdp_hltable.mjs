// 编辑区着色 vs 原型着色表：逐构造机械比对
// 1) 从 prototype/prototype.html 抽出 `#hl-pre .hl-*` 规则原文（基准，不写死在脚本里）
// 2) 在正式版的编辑区里造一份覆盖全部构造的样本文档，抓每个 token 的实测样式
// 3) 把原型规则丢进同一个页面解析成 rgb，逐条对照，输出 PASS/FAIL 表
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 9223;
const proto = fs.readFileSync("../prototype/prototype.html", "utf8");
const rules = {};
for (const m of proto.matchAll(/#hl-pre \.hl-([a-z]+)\{([^}]*)\}/g)) rules["hl-" + m[1]] = m[2].trim();
console.log("从原型抽到的着色规则:", Object.keys(rules).length, "条");

const dir = path.join(os.tmpdir(), "folio-hltable-" + process.pid);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "hl-sample.md");
fs.writeFileSync(file, [
  "# 标题一",
  "",
  "正文 **粗** *斜* ~~删~~ `行内码` [链接文](https://a.b) 尾",
  "",
  "- 无序项",
  "- [x] 任务项",
  "",
  "> 引用文字 `引用内码`",
  "",
  "| 甲 | 乙 |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "---",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "<https://auto.link>",
].join("\n"));

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

// 造样本 → 打开 → 刷新（启动恢复会挑打开时间最新的那条 = 样本）→ 进编辑
await run(`(async () => { await window.__TAURI_INTERNALS__.invoke("open_doc", { path: ${JSON.stringify(file)} }); return 1; })()`, true);
await wait(400);
await send("Page.reload", { ignoreCache: false });
for (let i = 0; i < 60; i++) { if (await run(`!!document.querySelector(".rail button")`)) break; await wait(300); }
await wait(1500);
const tabName = await run(`document.querySelector(".tabs .tab")?.innerText?.trim() ?? "(无)"`);
console.log("当前文档:", tabName);
// 实例身份校验：单实例转发会让"启动新版"其实唤醒旧版，必须确认页面加载的 CSS 指纹
const href = await run(`JSON.stringify([...document.styleSheets].map(s=>s.href).filter(Boolean))`);
console.log("页面加载的资源指纹:", href);
await run(`document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"e",ctrlKey:true,bubbles:true}))`);
await wait(1200);

const dump = await run(`(() => {
  const out = [];
  for (const line of document.querySelectorAll(".cm-content .cm-line")) {
    const lineCls = [...line.classList].filter(c => c.startsWith("cm-") && c !== "cm-line");
    for (const el of line.querySelectorAll("span")) {
      const cs = getComputedStyle(el);
      out.push({
        cls: [...el.classList],
        text: el.textContent,
        color: cs.color, weight: cs.fontWeight, style: cs.fontStyle,
        deco: cs.textDecorationLine, bg: cs.backgroundColor,
        lineCls, lineText: line.textContent.slice(0, 22),
      });
    }
  }
  return { total: out.length, spans: out };
})()`);

// 把原型规则在同一页面里解析成实际值（var()/color-mix() 由活的 token 求解）
const expect = await run(`(() => {
  const rules = ${JSON.stringify(rules)};
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;left:-9999px";
  document.body.appendChild(box);
  const res = {};
  for (const [k, decl] of Object.entries(rules)) {
    const s = document.createElement("span");
    s.style.cssText = decl;
    s.textContent = "x";
    box.appendChild(s);
    const cs = getComputedStyle(s);
    res[k] = { color: cs.color, weight: cs.fontWeight, style: cs.fontStyle,
      deco: cs.textDecorationLine, bg: cs.backgroundColor, 原文: decl };
  }
  box.remove();
  return res;
})()`);

const pick = (pred, label) => ({ label, hit: dump.spans.find(pred) });
const LINE = (cls) => (s) => s.lineCls.includes(cls);

const checks = [
  { 构造: "标题文字", got: pick(s => s.cls.includes("cmx-head") && s.text.trim() === "标题一"), want: "hl-head", fields: ["color", "weight", "deco"] },
  { 构造: "标题标记 #", got: pick(s => s.text === "#"), want: "hl-hash", fields: ["color"] },
  { 构造: "粗体", got: pick(s => s.cls.includes("cmx-strong") && s.text === "**"), want: "hl-strong", fields: ["color", "weight"] },
  { 构造: "斜体", got: pick(s => s.cls.includes("cmx-em") && s.text === "*"), want: "hl-em", fields: ["color", "style"] },
  { 构造: "删除线", got: pick(s => s.cls.includes("cmx-del")), want: "hl-del", fields: ["color", "deco"] },
  { 构造: "行内代码（正文）", got: pick(s => s.cls.includes("cmx-code") && !LINE("cm-fence-line")(s) && !LINE("cm-quote-line")(s) && s.text.includes("行内码")), want: "hl-code", fields: ["color", "bg"] },
  { 构造: "链接文字", got: pick(s => s.cls.includes("cmx-link") && s.text === "链接文"), want: "hl-lkt", fields: ["color", "deco"] },
  { 构造: "URL", got: pick(s => s.cls.includes("cmx-url") && s.text.includes("a.b")), want: "hl-url", fields: ["color", "deco"] },
  { 构造: "列表符号", got: pick(s => s.cls.includes("cm-bullet") && s.text === "-"), want: "hl-bullet", fields: ["color", "weight"] },
  { 构造: "任务标记", got: pick(s => s.cls.includes("cmx-task")), want: "hl-task", fields: ["color", "weight"] },
  { 构造: "引用文字", got: pick(s => s.cls.includes("cmx-quote") && s.text.includes("引用文字")), want: "hl-quote", fields: ["color"] },
  { 构造: "分隔线", got: pick(s => s.cls.includes("cmx-rule")), want: "hl-hr", fields: ["color"] },
];

console.log("\n构造".padEnd(12), "期望(原型)".padEnd(26), "实测".padEnd(26), "判定");
let bad = 0, miss = 0;
for (const c of checks) {
  const { hit } = c.got;
  const label = c.构造;
  if (!hit) { console.log(`✗ ${label}：没找到对应 token（期望来自 ${c.want}）`); miss++; continue; }
  const e = expect[c.want] ?? {};
  const diffs = [];
  for (const f of c.fields) {
    const a = String(hit[f] ?? "").replace(/\s+/g, " ");
    const b = String(e[f] ?? "").replace(/\s+/g, " ");
    // 背景类比对：原型用 color-mix，实测可能是 rgba 近似，允许小误差
    if (a === b) continue;
    const pa = parseColor(a), pb = parseColor(b);
    if (pa && pb && near(pa, pb, f === "bg" ? 6 : 1)) continue;
    diffs.push(`${f} 实测 ${a} / 原型 ${b}`);
  }
  const brief = c.fields.map((f) => `${f}=${String(hit[f]).replace(/\s+/g, " ")}`).join(" ");
  if (diffs.length) { bad++; console.log(`✗ ${label.padEnd(16)}[${c.want}] ${diffs.join("；")}`); }
  else console.log(`✓ ${label.padEnd(16)}[${c.want}] ${brief}`);
}

// 围栏整行：原型是 hl-fence 的底色 + text-2；正式版落在行装饰上
const fence = dump.spans.find(s => LINE("cm-fence-line")(s));
console.log("\n围栏行:", fence ? `底色 ${fence.bg} · 行类 ${fence.lineCls.join("+")}` : "✗ 没有围栏行被标记");
console.log("  原型 hl-fence 底色:", expect["hl-fence"]?.bg, "| 原文:", expect["hl-fence"]?.原文);

console.log("\n小结:", `比对项 ${checks.length}，不符 ${bad}，缺 token ${miss}；抓到的 span ${dump.total} 个`);
console.log("异常:", problems.length ? problems.slice(0, 5).join("\n") : "无");

fs.rmSync(dir, { recursive: true, force: true });
ws.close();
process.exit(bad + miss === 0 ? 0 : 1);

function parseColor(s) {
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return null;
  return m[1].split(",").map(x => parseFloat(x.trim()));
}
function near(a, b, tol) {
  if (a.length !== b.length) return false;
  if (a.length === 4 && Math.abs(a[3] - b[3]) > 0.05) return false;
  return a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);
}
