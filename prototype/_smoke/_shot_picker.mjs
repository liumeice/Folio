// One-off visual probe: drive headless Chromium over CDP, open prototype dialogs, screenshot.
// Usage: node _shot_picker.mjs   (starts its own headless chrome; outputs _shot_*.png next to this file)
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
const PORT = 9224;
const PAGE = "file:///" + path.resolve(__dirname, "..", "prototype.html").replace(/\\/g, "/");

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "folio-shot-profile")}`,
  "--window-size=1280,860", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { try{ chrome.kill(); }catch{} });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function target(){
  for(let i=0;i<50;i++){
    try{
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find(t => t.type === "page");
      if(page) return page;
    }catch{}
    await sleep(200);
  }
  throw new Error("chrome devtools not up");
}
class CDP{
  constructor(ws){ this.ws=ws; this.n=0; this.waiters=new Map();
    this.ws.addEventListener("message", e=>{ const m=JSON.parse(e.data);
      if(m.id && this.waiters.has(m.id)){ const {res,rej}=this.waiters.get(m.id); this.waiters.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  static async connect(url){ const ws=new WebSocket(url); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;}); return new CDP(ws); }
  send(method, params={}){ const id=++this.n; this.ws.send(JSON.stringify({id,method,params}));
    return new Promise((res,rej)=>this.waiters.set(id,{res,rej})); }
  async eval(expr){ const r=await this.send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails) throw new Error("page eval: "+JSON.stringify(r.exceptionDetails).slice(0,300)); return r.result?.value; }
  async shot(name){ const {data}=await this.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(data,"base64")); console.log("saved "+name); }
}
const t = await target();
const cdp = await CDP.connect(t.webSocketDebuggerUrl);
await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
await cdp.send("Page.navigate",{url:PAGE}); await sleep(1200);
const errs = [];
cdp.ws.addEventListener("message", e=>{ const m=JSON.parse(e.data);
  if(m.method==="Runtime.exceptionThrown") errs.push(JSON.stringify(m.params.exceptionDetails).slice(0,300)); });
const ev = ex => cdp.eval(ex);

// 1) 打开文件对话框：进入 E:\docs\markdown，选中一份文件
await ev(`openPicker("files"); pkGoto(vfsFind(picker.tree, "E:\\\\docs\\\\markdown")); pkPick("file", "E:\\\\docs\\\\markdown\\\\架构设计 v3.md");`);
await sleep(150); await cdp.shot("_shot_pick_files.png");

// 2) 类型下拉展开
await ev(`document.getElementById("pk-fmt").click();`);
await sleep(150); await cdp.shot("_shot_pick_fmtmenu.png");
await ev(`document.getElementById("pk-fmtmenu").classList.remove("open");`);

// 3) 选择文件夹模式（选中 E:\books）
await ev(`closePicker(); openPicker("dir"); pkGoto(vfsFind(picker.tree, "E:\\\\books"));`);
await sleep(150); await cdp.shot("_shot_pick_dir.png");

// 4) 切换库确认框（选完目录后才弹）
await ev(`pkConfirm();`);
await sleep(150); await cdp.shot("_shot_switch_confirm.png");

// 5) 确认切换 → 侧栏文档库视图 = 新库
await ev(`document.getElementById("rootq-ok").click(); switchSide("library");`);
await sleep(250); await cdp.shot("_shot_after_switch.png");

// 6) 关闭库确认框
await ev(`document.getElementById("lib-close").click();`);
await sleep(150); await cdp.shot("_shot_close_confirm.png");

// 7) 关闭后：chip 虚线占位 + 空态
await ev(`document.getElementById("rootq-ok").click();`);
await sleep(250); await cdp.shot("_shot_after_close.png");

// 8) 重开（无旧库不弹确认）
await ev(`openPicker("dir"); pkGoto(vfsFind(picker.tree, "E:\\\\docs")); pkConfirm();`);
await sleep(250); await cdp.shot("_shot_reopen.png");

// 8a2) 等宽按钮组复核：文档信息 / 编辑栏 / 设置抬头
await ev(`openProps();`);
await sleep(150); await cdp.shot("_shot_info_btns.png");
await ev(`document.getElementById("info-ok").click(); toggleEdit();`);
await sleep(200); await cdp.shot("_shot_editor_btns.png");
await ev(`toggleEdit(); openSettings();`);
await sleep(300); await cdp.shot("_shot_settings_btns.png");
await ev(`closeSettings(); openPicker("files"); pkGoto(vfsFind(picker.tree, "E:\\\\docs"));`);
await sleep(150); await cdp.shot("_shot_pick_btns.png");

// 8a3) 查看→主题 子菜单：展开 + 当前打点；切米色整窗效果
await ev(`closePicker(); menuBs[1].click(); document.getElementById("mi-theme").classList.add("subopen");`);
await sleep(150); await cdp.shot("_shot_theme_sub.png");
await ev(`document.querySelector('#thsub .mi[data-theme="sepia"]').click();`);
await sleep(200); await cdp.shot("_shot_sepia.png");
await ev(`setTheme("dark");`);

// 8a4) 深链可读性：导入中文名文档后看状态栏链接（应无 % 编码）
await ev(`importFile(new File(["# 3 管理会话 正文段落"], "3-管理会话.md"), "notes/3-管理会话.md").then(id => renderDoc(id));`);
await sleep(300);
const dl = await ev(`document.getElementById("stat-link").textContent + " || " + deepLink(true)`);
console.log("deeplink:", dl, "| has % encoding?", /%[0-9A-F]{2}/i.test(dl));

// 8b) 搜索框聚焦态（不得出现大号焦点方框）
await ev(`openPicker("files"); pkGoto(vfsFind(picker.tree, "E:")); document.getElementById("pk-q").focus();`);
await sleep(150); await cdp.shot("_shot_focus.png");

console.log("LIB_ROOT=", await ev(`LIB_ROOT + " | open=" + libraryOpen + " | " + $("lib-count").textContent`));
console.log("page exceptions:", errs.length ? errs.join("\n") : "none");
chrome.kill(); process.exit(0);
