// v0.2.0.16 五项优化取证（一次性）
import fs from "fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t;
for (let i = 0; i < 60; i++) {
  try { const l = await (await fetch("http://127.0.0.1:9223/json")).json();
    t = l.find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (t) break; } catch {}
  await sleep(400);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let n = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; w.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const txt = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
const clickBox = async (sel) => {
  const b = await txt(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;
    const r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
  if (!b) return false;
  const { x, y } = JSON.parse(b);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return true;
};
await sleep(1600);

console.log("== ① rail 钮列表 ==");
console.log(await txt(`[...document.querySelectorAll(".rail button")].map(b=>b.title).join(" / ")`));
console.log("末钮图标:", await txt(`document.querySelector(".rail button:last-child use").getAttribute("href")`));

console.log("== ④ 帮助菜单项（应已无「开发者工具」）==");
await txt(`[...document.querySelectorAll('#menubar > b')][3].click()`); await sleep(200);
console.log(await txt(`[...([...document.querySelectorAll('#menubar > b')][3].querySelectorAll('.mi .t'))].map(e=>e.textContent).join("|")`));
await txt(`document.dispatchEvent(new MouseEvent("click",{bubbles:true}))`); await sleep(150);

console.log("== ② 关于对话框 ==");
await txt(`[...document.querySelectorAll('#menubar > b')][3].click()`); await sleep(150);
await txt(`document.querySelector('.mi[data-act="about"]').click()`); await sleep(400);
console.log("tags:", await txt(`[...document.querySelectorAll('#about-overlay .tag')].map(e=>e.textContent+(e.className.includes("plain")?"·描边":"·accent")).join(" / ")`));
console.log("深链盒:", await txt(`[...document.querySelectorAll('#about-overlay .modal-b div')].pop()?.textContent.slice(0,60)`));
const s1 = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("_v_about.png", Buffer.from(s1.result.data, "base64"));
await txt(`document.querySelector('#about-overlay .x').click()`); await sleep(200);

console.log("== ③ 复制深链浮层 ==");
await txt(`document.getElementById("stat-link-btn").click()`); await sleep(400);
console.log(await txt(`(()=>{const e=document.querySelector(".copypop");if(!e)return "无浮层元素";
  return "on="+e.classList.contains("on")+" text=「"+e.textContent.slice(0,20)+"…」 toast闪="+(document.getElementById("toast")?.className||"").includes("show")})()`));
await sleep(2300);
console.log(await txt(`(()=>{const e=document.querySelector(".copypop");return e?("2.3s后 class="+e.className):"已卸载（Show keyed 移除）"})()`));

console.log("== ⑤a 打开文件夹 → 自动文档库 ==");
await txt(`[...document.querySelectorAll('#menubar > b')][0].click()`); await sleep(150);
await txt(`document.querySelector('.mi[data-act="open-dir"]').click()`); await sleep(1400);
console.log("picker:", await txt(`!!document.getElementById("pick-overlay")`));
console.log("点快速访问首项:", await clickBox(".pk-side .tf")); await sleep(1000);
console.log("path:", await txt(`document.querySelector('.pk-path')?.textContent`));
console.log("按选择文件夹:", await clickBox("#pk-ok")); await sleep(3000);
console.log(await txt(`(()=>{const views=[...document.querySelectorAll('.side-view')].filter(v=>v.offsetParent!==null);
  return "可见面板=" + (views[0]?.textContent.includes("文档库")?"文档库":views[0]?.textContent.includes("大纲")?"大纲":views[0]?.textContent.slice(0,6))})()`));

console.log("== ⑤b rail 打开文件 → 自动大纲 ==");
console.log("点 rail-open:", await clickBox('.rail button[title^="打开文档"]')); await sleep(1200);
console.log("picker files:", await txt(`document.getElementById("pick-title")?.textContent`));
console.log("双击文件行:", await clickBox('#pick-overlay .pk-list .tf[data-k="file"]'));
await sleep(1500);
console.log(await txt(`(()=>{const views=[...document.querySelectorAll('.side-view')].filter(v=>v.offsetParent!==null);
  return "可见面板=" + (views[0]?.textContent.includes("大纲")?"大纲":(views[0]?.textContent.slice(0,6)?? "无"))})()`));
process.exit(0);
