/* 设置窗字号+导航图标实机核对 */
const list = await (await fetch("http://127.0.0.1:9223/json")).json();
const ws = new WebSocket(list.find(t=>t.type==="page").webSocketDebuggerUrl);
let id=0; const pend=new Map(); const errs=[];
const send=(m,p={})=>{const i=++id;ws.send(JSON.stringify({id:i,method:m,params:p}));return new Promise((r,j)=>pend.set(i,{r,j}));};
ws.onmessage=ev=>{const m=JSON.parse(ev.data);
  if(m.id&&pend.has(m.id)){const{r,j}=pend.get(m.id);pend.delete(m.id);m.error?j(new Error("cdp")):r(m.result);}
  else if(m.method==="Runtime.exceptionThrown")errs.push(m.params.exceptionDetails.exception?.description??"异常");};
await new Promise(r=>ws.onopen=r);
await send("Runtime.enable");await send("Page.enable");
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const run=async e=>{const r=await send("Runtime.evaluate",{expression:e,returnByValue:true});
  if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,200));return r.result?.value;};
for(let i=0;i<60;i++){if(await run(`!!document.querySelector(".rail button")`))break;await wait(300);}
await wait(700);
await run(`document.querySelector('.tbar-right .iconbtn[title="设置"]').click()`);
await wait(500);
console.log(await run(`(() => {
  const stabs=[...document.querySelectorAll('.stabs .stab')];
  const fs=sel=>{const e=document.querySelector(sel);return e?getComputedStyle(e).fontSize:null;};
  return {
    导航项数: stabs.length,
    每项含图标: stabs.map(b=>!!(b.querySelector('svg use')&&document.querySelector(b.querySelector('svg use').getAttribute('href')))),
    图标可见: stabs.map(b=>{const i=b.querySelector('svg');const r=i?.getBoundingClientRect();return r?Math.round(r.width)+'x'+Math.round(r.height):null;}),
    字号: { 标签: fs('.st-label'), hint: fs('.st-hint'), 分组标题: fs('.st-group-title'),
      导航文字: fs('.stab'), 抬头标题: fs('.st-title'), 抬头描述: fs('.st-desc'), 底部计数: fs('.st-foot-hint') },
  };
})()`));
const { data } = await send("Page.captureScreenshot", { format: "png" });
(await import("node:fs")).writeFileSync("_setfont.png", Buffer.from(data, "base64"));
console.log("📄 _setfont.png  控制台异常:", errs.length?errs:"无");
ws.close();
