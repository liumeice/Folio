// 一次性取证：驱动已打包的 folio-app.exe（带 --remote-debugging-port），验证选择对话框/主题子菜单/询问框。
// 用法：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 先启动 exe，再 node _cdp_pickdlg.mjs
import fs from "fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws){ this.ws = ws; this.n = 0; this.waiters = new Map();
    this.ws.addEventListener("message", e => { const m = JSON.parse(e.data);
      if (m.id && this.waiters.has(m.id)) { const { res, rej } = this.waiters.get(m.id); this.waiters.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  static async connect(base) {
    let t;
    for (let i = 0; i < 40; i++) {
      try {
        const l = await (await fetch(base + "/json")).json();
        t = l.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
        if (t) break;
      } catch { /* not up yet */ }
      await sleep(500);
    }
    if (!t) throw new Error("no devtools page target on " + base);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new CDP(ws);
  }
  send(method, params = {}) { const id = ++this.n; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiters.set(id, { res, rej })); }
}
const cdp = await CDP.connect("http://127.0.0.1:9223");
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
const shot = async (name) => {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(name, Buffer.from(data, "base64"));
  console.log("saved " + name);
};
const ev = (expr) => cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });

console.log("theme now:", (await ev(`document.documentElement.dataset.theme`)).result?.value);

// 1) 打开文档对话框（真实盘）：菜单→文件→打开文档…
await ev(`[...document.querySelectorAll('#menubar > b')][0].click()`);
await sleep(200);
await ev(`document.querySelector('.mi[data-act="open"]').click()`);
await sleep(900);
console.log("pick open:", (await ev(`!!document.getElementById("pick-overlay")`)).result?.value);
await shot("_v_pick_files.png");

// 2) 主题子菜单：查看→主题→米色
await ev(`(()=>{const b=[...document.querySelectorAll('#menubar > b')][1]; b.click();})()`);
await sleep(200);
await ev(`document.querySelector('.mi.sub').click()`);
await sleep(200);
await shot("_v_theme_sub.png");
await ev(`document.querySelector('.mi[data-act="theme-sepia"]').click()`);
await sleep(400);
console.log("theme after sepia click:", (await ev(`document.documentElement.dataset.theme`)).result?.value);
await ev(`(()=>{const b=[...document.querySelectorAll('#menubar > b')][1]; b.click();})()`);
await ev(`document.querySelector('.mi[data-act="theme-dark"]').click()`);
await sleep(300);
console.log("theme back:", (await ev(`document.documentElement.dataset.theme`)).result?.value);

// 3) 询问框：打开文件夹…（选个目录再取消，验证零副作用）——仅确认对话框层可截图到「此电脑」
await ev(`[...document.querySelectorAll('#menubar > b')][0].click()`);
await sleep(150);
await ev(`document.querySelector('.mi[data-act="open-dir"]').click()`);
await sleep(700);
await shot("_v_pick_dir.png");
await ev(`document.getElementById("pk-cancel")?.click()`);
await sleep(200);
console.log("done");
process.exit(0);
