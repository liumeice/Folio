// 一次性取证（2026-11-17）：v0.2.1.63 强调色十二枚——双档换档/分墨/直通/空值交回,
// 全部走「set_settings 落库 → reload 启动链 → 读 body 内联变量」真实路径。测完恢复原设置。
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) {
  const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send("Runtime.enable"); await send("Page.enable");
async function evl(expression, awaitPromise = true) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
let fails = 0;
const check = (n, ok, d) => { console.log((ok ? "PASS " : "FAIL ") + n + (d ? "  " + d : "")); if (!ok) fails++; };

for (let i = 0; i < 50; i++) {
  if (await evl(`!!(window.__TAURI_INTERNALS__&&__TAURI_INTERNALS__.invoke)`, false)) break;
  await sleep(200);
}

const baseRaw = await evl(`__TAURI_INTERNALS__.invoke("get_settings").then(s=>JSON.stringify(s))`);
fs.writeFileSync("C:/Users/liumc/AppData/Local/Temp/folio-settings-baseline.json", baseRaw);
console.log("基线已存盘,accent=" + JSON.parse(baseRaw).accent + ", theme=" + JSON.parse(baseRaw).theme);

async function apply(theme, accent) {
  await evl(`__TAURI_INTERNALS__.invoke("set_settings",{settings:Object.assign(${baseRaw},{theme:${JSON.stringify(theme)},accent:${JSON.stringify(accent)}})}).then(()=>1)`);
  await send("Page.reload", {});
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const done = await evl(`document.documentElement.getAttribute("data-theme")===${JSON.stringify(theme)} && !!document.body`, false);
    if (done) { await sleep(350); break; }   // 等 store 的 settings effect 落地
  }
  return JSON.parse(await evl(`JSON.stringify({
    inline:{a:document.body.style.getPropertyValue("--accent"),ink:document.body.style.getPropertyValue("--accent-ink"),bg:document.body.style.getPropertyValue("--accent-bg")},
    computedA:getComputedStyle(document.body).getPropertyValue("--accent").trim(),
    theme:document.documentElement.getAttribute("data-theme")})`));
}

const CASES = [
  ["dark", "#B53825", (r) => r.inline.a === "#FF826D" && r.inline.ink === "#0A1020", "朱砂·暗底→暗档+深墨"],
  ["light", "#B53825", (r) => r.inline.a === "#B53825" && r.inline.ink === "#FFFFFF", "朱砂·浅底→浅档+白墨"],
  ["sepia", "#B53825", (r) => r.inline.a === "#B53825" && r.inline.ink === "#FFFFFF", "朱砂·米色=浅档"],
  ["dark", "#2DD4BF", (r) => r.inline.a === "#2DD4BF" && r.inline.ink === "#0A1020", "旧青绿·单档直通+阈值墨"],
  ["dark", "#1B6372", (r) => r.inline.a === "#6CC8D6" && r.inline.ink === "#0A1020", "石青·暗底→暗档"],
  ["light", "", (r) => r.inline.a === "" && r.computedA.toLowerCase() === "#0d9488", "空值→交回主题内置(浅色 #0D9488)"],
];
for (const [theme, accent, pred, name] of CASES) {
  const r = await apply(theme, accent);
  check(name, pred(r), JSON.stringify(r.inline));
}

await evl(`__TAURI_INTERNALS__.invoke("set_settings",{settings:${baseRaw}}).then(()=>1)`);
await send("Page.reload", {}); await sleep(1500);
const back = await evl(`__TAURI_INTERNALS__.invoke("get_settings").then(s=>JSON.stringify([s.theme,s.accent]))`);
check("基线已还原", back === JSON.stringify([JSON.parse(baseRaw).theme, JSON.parse(baseRaw).accent]), back);

console.log(fails ? "== FAIL " + fails + " ==" : "== ALL PASS ==");
ws.close(); process.exit(fails ? 1 : 0);
