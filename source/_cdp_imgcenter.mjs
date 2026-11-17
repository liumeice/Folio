// 一次性取证（2026-11-17）：阅读窗五类图片（本地/远程/多图横行/Mermaid/MathJax）水平居中几何核对
// + export_images 命令落盘实测。前提：folio-app.exe 已用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动。
// 自带现场清理：测完把测试文档从「最近打开」删掉、probe.html/images 移除，不动其余数据。
import fs from "node:fs";

const PORT = 9223;
const DIR = "C:/Users/liumc/AppData/Local/Temp/folio-imgtest";
const MD = DIR + "/imgcenter.md";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
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
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send("Runtime.enable");

async function evl(expression, awaitPromise = true) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

let fails = 0, warns = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
  if (!ok) fails++;
}
function warn(name, detail) { console.log("WARN " + name + (detail ? "  " + detail : "")); warns++; }

// 1) 等 IPC 就绪并打开测试文档
for (let i = 0; i < 100; i++) {
  if (await evl(`!!(window.__TAURI_INTERNALS__ && __TAURI_INTERNALS__.invoke)`, false)) break;
  await sleep(200);
}
await evl(`__TAURI_INTERNALS__.invoke("open_doc",{path:${JSON.stringify(MD)}}).then(d=>d.meta.slug)`);
console.log("opened:", MD);
// 后端登记≠前端切换：reload 走「启动恢复读 recents[0]」的真实渲染路径
await send("Page.enable");
await sleep(600);
await send("Page.reload", { ignoreCache: false });
await sleep(1500);

// 2) 等渲染收敛（图 complete/missing 齐、两个图表块 ready/error 定态），25s 超时
let state = "";
for (let i = 0; i < 125; i++) {
  state = await evl(`(() => {
    const a = document.querySelector("article.prose");
    if (!a) return "noarticle";
    const imgs = [...a.querySelectorAll("img")];
    const fb = [...a.querySelectorAll(".f-block")];
    const imgOk = imgs.length >= 5 && imgs.every((im) => im.complete || im.classList.contains("img-missing"));
    const fbOk = fb.length >= 2 && fb.every((f) => f.classList.contains("f-ready") || f.classList.contains("f-error"));
    return imgOk && fbOk ? "ready" : ("wait imgs=" + imgs.length + " fb=" + fb.length);
  })()`);
  if (state === "ready") break;
  await sleep(200);
}
check("渲染收敛", state === "ready", state);

// 3) 几何核对：元素中心 vs 正文中心,容差 2px
const geo = JSON.parse(await evl(`(() => {
  const a = document.querySelector("article.prose");
  const ar = a.getBoundingClientRect();
  const cx = ar.left + ar.width / 2;
  const rows = [];
  for (const img of a.querySelectorAll("img")) {
    if (img.closest("p.imgrow")) continue;
    const r = img.getBoundingClientRect();
    rows.push({ t: "img", kind: img.dataset.folioLocal ? "local" : /^https?:/i.test(img.getAttribute("src") || "") ? "remote" : "other",
      missing: img.classList.contains("img-missing"), dx: +(r.left + r.width / 2 - cx).toFixed(1), w: Math.round(r.width) });
  }
  for (const p of a.querySelectorAll("p.imgrow")) {
    const rs = [...p.querySelectorAll("img")].map((i) => i.getBoundingClientRect());
    if (!rs.length) continue;
    const L = Math.min(...rs.map((r) => r.left)), R = Math.max(...rs.map((r) => r.right));
    rows.push({ t: "imgrow", n: rs.length, dx: +((L + R) / 2 - cx).toFixed(1) });
  }
  for (const f of a.querySelectorAll(".f-block")) {
    if (f.dataset.math === "inline") continue;
    const sv = f.querySelector("svg");
    const t = sv || f;
    const r = t.getBoundingClientRect();
    rows.push({ t: f.matches("[data-mermaid]") ? "mermaid" : "math",
      ready: f.classList.contains("f-ready"), dx: +(r.left + r.width / 2 - cx).toFixed(1), w: Math.round(r.width) });
  }
  return JSON.stringify({ cx: +cx.toFixed(1), artW: Math.round(ar.width), rows });
})()`));
console.log("article center x=" + geo.cx + ", width=" + geo.artW);
for (const r of geo.rows) {
  console.log("  " + JSON.stringify(r));
  if (r.t === "img" && r.kind === "other") continue;
  if (r.t === "img" && r.missing) { warn("图片缺失(" + r.kind + ")", "dx=" + r.dx); continue; }
  if (r.w === 0 && r.t !== "imgrow") { warn(r.t + " 宽度为 0", "渲染可能失败"); }
  if (r.t === "mermaid" && !r.ready) warn("mermaid 未 ready", "");
  if (r.t === "math" && !r.ready) warn("math 未 ready", "");
  check(r.t + (r.kind ? ":" + r.kind : "") + (r.n ? "x" + r.n : "") + " 居中", Math.abs(r.dx) <= 2, "dx=" + r.dx + "px");
}

// 4) export_images 实测：本地图复制 + 远程图下载
const out = await evl(`__TAURI_INTERNALS__.invoke("export_images",{htmlPath:${JSON.stringify(DIR + "/probe.html")},items:[
  {source:${JSON.stringify(DIR + "/tiny.png")},kind:"file"},
  {source:"https://www.google.com/favicon.ico",kind:"url"}]})`);
console.log("export_images →", JSON.stringify(out));
const local = out.find((o) => o.kind !== "url" && o.source.endsWith("tiny.png")) || out[0];
check("export_images 本地图复制", local?.name === "tiny.png" &&
  fs.existsSync(DIR + "/images/tiny.png") &&
  fs.readFileSync(DIR + "/images/tiny.png").equals(fs.readFileSync(DIR + "/tiny.png")));
const remote = out.find((o) => o.source.includes("favicon"));
if (remote?.name && fs.existsSync(DIR + "/images/" + remote.name)) console.log("PASS export_images 远程图下载 → images/" + remote.name);
else warn("export_images 远程图未落盘", "网络不可达时属预期(前端保留原链)," + JSON.stringify(remote));

// 5) 现场清理：测试文档退出「最近打开」,probe 产物删除
try {
  const ids = JSON.parse(await evl(`__TAURI_INTERNALS__.invoke("list_recents").then(rs=>JSON.stringify(
    rs.filter(r=>((r.meta&&r.meta.path)||"").includes("folio-imgtest")).map(r=>r.meta.id)))`));
  for (const rid of ids) await evl(`__TAURI_INTERNALS__.invoke("remove_recent",{id:${rid}})`);
  console.log("清理 recents:", ids.length, "条");
} catch (e) { warn("recents 清理失败", String(e)); }
fs.rmSync(DIR + "/probe.html", { force: true });
fs.rmSync(DIR + "/images", { recursive: true, force: true });

console.log(fails ? "== FAIL " + fails + " (warn " + warns + ") ==" : "== ALL PASS (warn " + warns + ") ==");
ws.close();
process.exit(fails ? 1 : 0);
