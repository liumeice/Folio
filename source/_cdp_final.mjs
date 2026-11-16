const list = await (await fetch("http://127.0.0.1:9223/json")).json();
const page = list.find(t=>t.type==="page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map(); const errs=[];
const send=(m,p={})=>{const i=++id;ws.send(JSON.stringify({id:i,method:m,params:p}));return new Promise((r,j)=>pend.set(i,{r,j}));};
ws.onmessage=ev=>{const m=JSON.parse(ev.data);
  if(m.id&&pend.has(m.id)){const{r,j}=pend.get(m.id);pend.delete(m.id);m.error?j(new Error(m.error.message)):r(m.result);}
  else if(m.method==="Runtime.exceptionThrown")errs.push(m.params.exceptionDetails.exception?.description??"异常");};
await new Promise(r=>ws.onopen=r);
await send("Runtime.enable");await send("Page.enable");
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const run=async e=>{const r=await send("Runtime.evaluate",{expression:e,returnByValue:true});
  if(r.exceptionDetails)return "ERR:"+JSON.stringify(r.exceptionDetails).slice(0,200);return r.result?.value;};
for(let i=0;i<60;i++){if(await run(`!!document.querySelector(".rail button")`))break;await wait(300);}
await wait(800);
console.log("CSS:", await run(`[...document.querySelectorAll('link[rel=stylesheet]')].map(l=>l.href.split('/').pop()).join()`));
// 真实鼠标点击标题栏 ⚙
const box = await run(`(()=>{const b=document.querySelector('.tbar-right .iconbtn[title="设置"]');const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
await send("Input.dispatchMouseEvent",{type:"mousePressed",x:box.x,y:box.y,button:"left",clickCount:1});
await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:box.x,y:box.y,button:"left",clickCount:1});
await wait(500);
console.log(await run(`(() => {
  const stabs=[...document.querySelectorAll('.stabs .stab')];
  const iconSizes=stabs.map(b=>{const i=b.querySelector('svg');const r=i?.getBoundingClientRect();return i?Math.round(r.width)+'x'+Math.round(r.height):"无"});
  const win=document.querySelector('.st-win')?.getBoundingClientRect();
  return {
    已打开: document.querySelector('.body').classList.contains('settings-open'),
    窗: win?Math.round(win.width)+'x'+Math.round(win.height):null,
    预览残留: !!document.querySelector('.st-sample') || [...document.querySelectorAll('.st-group-title')].some(e=>e.textContent==="预览"),
    床前明月光残留: document.body.innerText.includes("床前明月"),
    导航图标: iconSizes,
    字号: { label: getComputedStyle(document.querySelector('.st-label')).fontSize,
            hint: getComputedStyle(document.querySelector('.st-hint')).fontSize,
            导航: getComputedStyle(document.querySelector('.stab')).fontSize },
    分组: [...document.querySelectorAll('.stabs .stab')].map(b=>b.textContent.trim()),
  };
})()`));
const { data } = await send("Page.captureScreenshot", { format: "png" });
(await import("node:fs")).writeFileSync("_final.png", Buffer.from(data, "base64"));
console.log("📄 _final.png 异常:", errs.length?errs:"无");
ws.close();
