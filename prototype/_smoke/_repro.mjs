// 复现用户反馈：①百分比槽宽实测 ②目录选择对话框单击/双击文件夹的行为
import { spawn } from "child_process";
import path from "path";
import os from "os";
const CHROME = path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
const PORT = 9225;
const PAGE = "file:///" + path.resolve(process.argv[2] || "../prototype.html").replace(/\\/g, "/");
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), "folio-repro")}`, "--window-size=1280,860", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  t = l.find((x) => x.type === "page"); if (t) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let n = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; w.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const txt = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: PAGE }); await sleep(1200);

console.log("== ① 百分比槽宽实测 ==");
console.log(await txt(`(()=>{const b=document.getElementById("stat-pct");const out=[];for(const v of ["0%","9%","50%","100%"]){b.textContent=v;
  out.push(v+" → "+b.getBoundingClientRect().width.toFixed(1)+"px 父si "+b.closest(".si").getBoundingClientRect().width.toFixed(1)+"px");}
  b.textContent="0%";return out.join("\\n");})()`));

console.log("== ② 目录选择对话框：单击/双击文件夹 ==");
console.log("open dir picker:", await txt(`openPicker("dir"); "ok"`));
console.log("root rows:", await txt(`[...document.querySelectorAll("#pk-list .tf[data-k='dir']")].map(r=>r.textContent.trim()).join("|")`));
// 单击第一个文件夹（E:）
await txt(`(()=>{const r=document.querySelector("#pk-list .tf[data-k='dir']");
  r.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));})()`);
await sleep(150);
console.log("after SINGLE click:", await txt(`document.getElementById("pk-path").textContent + " | overlay open=" + document.getElementById("pick-overlay").classList.contains("open") + " | fname=" + document.getElementById("pk-name").value`));
// 双击同一文件夹
await txt(`(()=>{const r=document.querySelector("#pk-list .tf[data-k='dir']");
  const q=(k)=>new MouseEvent(k,{bubbles:true,cancelable:true}); r.dispatchEvent(q("dblclick"));})()`);
await sleep(150);
console.log("after DBL click:  ", await txt(`document.getElementById("pk-path").textContent + " | overlay open=" + document.getElementById("pick-overlay").classList.contains("open")`));
// 再进一层双击
await txt(`(()=>{const r=document.querySelector("#pk-list .tf[data-k='dir']"); r.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));})()`);
await sleep(150);
console.log("after DBL deeper: ", await txt(`document.getElementById("pk-path").textContent + " | rows=" + document.querySelectorAll("#pk-list .tf").length`));
// 左树展开状态是否还在
console.log("tree rows:", await txt(`[...document.querySelectorAll("#pk-tree .tf")].filter(r=>r.style.display!=="none").length`));
chrome.kill(); process.exit(0);
