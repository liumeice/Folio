import io, re

mo = "d:/aiprogram/mdediter/prototype/"
base = io.open(mo + "assets/base.css", encoding="utf-8").read()
scr = io.open(mo + "screens/06-settings.html", encoding="utf-8").read()

# 图标 sprite：复用 06 屏全套 defs（外壳与内容所需图标都在里面）
d0 = scr.index('<defs>'); d1 = scr.index('</defs>') + len('</defs>')
sprite = scr[d0:d1]

# 去掉 base.css 顶部 @import Google Fonts（离线应回退系统字体，且避免 headless 截图卡网络）。
# URL 里含 ';'（wght@400;500…），必须按 url(...) 括号闭合来切，不能拿 [^;]*; 截——
# 那样只删到第一个内部分号，残余的 …swap'); 会把紧跟的 :root 几何令牌块（--r-1/-2/-3/-win）一起吞成非法 CSS。
base = re.sub(r"@import\s+url\([^)]*\)\s*;", "", base)
# base.css 顶部设计系统注释里的品牌字也中性化（源码不留「墨页 / MoPage」）
base = base.replace('墨页 MoPage · Markdown 编辑查看工具 — 原型设计系统', 'Folio · 设计系统（同源令牌沿用）')

# ─────────────────────────────────────────────────────────────────────────────
# Folio 真实设置内容（唯一权威来源：source/src/lib/settings-spec.ts + typography.ts）
#   分组 GROUPS、每项 label/hint/control/domain/默认值/步长/单位 都照那两个文件抄。
#   MoPage 里 Folio 根本没有的假项（快捷键96 / 扩展7 / 同步 / 强调色 / 等宽连字 / 护眼米色 /
#   字体族名输入…）一律不摆——界面不许说谎。
#   视觉仍走 MoPage 的类名（.scard/.srow/.radio/.slider/.sgroup/.stabs/.stab），
#   所以观感、间距、圆角与 MoPage 完全一致。
#
# kind: seg=分段(segment)  slide=滑杆(range)  step=步进(stepper −值+)
# 每项数据： label, hint, kind, 载荷
# ─────────────────────────────────────────────────────────────────────────────
def seg(options, sel):            # options=[(值,标签)], sel=选中下标
    return {"k": "seg", "opts": options, "sel": sel}
def slide(v, lo, hi, stp, unit):  # 值, 下界, 上界, 步长, 单位后缀
    return {"k": "slide", "v": v, "lo": lo, "hi": hi, "stp": stp, "unit": unit}
def step_(v, lo, hi, stp, unit):
    return {"k": "step", "v": v, "lo": lo, "hi": hi, "stp": stp, "unit": unit}

GROUPS = [
    {
        "id": "appearance", "title": "外观", "icon": "i-contrast",
        "desc": "窗口配色。深浅两套灰阶都过了 WCAG AA，切换即时生效并写入 SQLite。",
        "rows": [
            ("主题", "深浅两套灰阶都过了 WCAG AA，切换即时生效并记住。",
             seg([("dark", "深色"), ("light", "浅色")], 0)),
        ],
    },
    {
        "id": "type", "title": "字体", "icon": "i-type",
        "desc": "正文用衬线还是无衬线；两族各自记住字号，切换不丢设置。",
        "rows": [
            ("字体族", "正文用衬线还是无衬线；两族各自记住字号，切换不丢设置。",
             seg([("serif", "衬线"), ("sans", "无衬线")], 0)),
            # 默认 serif → 域 [12.5,19.5] 步长 .5 默认 15.5（切到 sans 时上限收 18、基准 14.0）
            ("正文字号", "范围随字体族不同（衬线上限更高）；恢复默认回到各族基准。",
             step_(15.5, 12.5, 19.5, 0.5, " px")),
        ],
    },
    {
        "id": "paragraph", "title": "段落", "icon": "i-list",
        "desc": "行高、字距、段距与对齐——中文长文的呼吸感都在这几档。",
        "rows": [
            ("行高", "行距 = 字号 × 倍数。中文正文 1.7–2.0 最舒服。",
             slide(1.85, 1.4, 2.4, 0.05, "×")),
            ("字距", "额外字间距 em，0 为不加；中文长文加一点点更透气。",
             slide(0, 0, 0.12, 0.005, " em")),
            ("段落间距", "段与段之间的空白，按正文字号倍数换算。",
             step_(1.0, 0.6, 2, 0.05, " em")),
            ("对齐方式", "两端对齐让中文右缘整齐；左对齐保留自然参差。",
             seg([("left", "左对齐"), ("justify", "两端对齐")], 0)),
        ],
    },
    {
        "id": "layout", "title": "版面", "icon": "i-columns",
        "desc": "正文一行最宽多少像素；越窄越好读，越宽屏利用率越高。",
        "rows": [
            ("页面最大宽度", "正文一行最宽多少像素；窄了更省力，宽了屏占比更高（上限同窗口再夹）。",
             slide(900, 640, 1280, 20, " px")),
        ],
    },
    {
        "id": "code", "title": "代码与表格", "icon": "i-code",
        "desc": "代码字号与表格密度：只影响代码块与表格，不动正文。",
        "rows": [
            ("代码字号", "代码块比正文略小更耐读；只影响代码块，不动正文。",
             step_(12.5, 10.5, 15.5, 0.5, " px")),
            ("表格密度", "表格单元格的松紧三档。",
             seg([("compact", "紧凑"), ("standard", "标准"), ("loose", "宽松")], 1)),
        ],
    },
]

def fmt_num(v, stp):
    """按步长小数位格式化，跟 clampNum 同源（paraSpacing 步长 .05→两位）。"""
    digits = len(str(stp).split(".")[1]) if "." in str(stp) else 0
    return f"{round(float(v), digits):.{digits}f}"

def ctl_html(c):
    if c["k"] == "seg":
        radios = ""
        for idx, (val, lab) in enumerate(c["opts"]):
            on = " on" if idx == c["sel"] else ""
            extra = f' data-themeval="{val}"' if val in ("dark", "light", "sepia") else ""
            radios += f'<span class="radio{on}"{extra} data-val="{val}"><span class="rd"></span>{lab}</span>'
        return f'<div class="radios">{radios}</div>'
    if c["k"] == "slide":
        frac = (c["v"] - c["lo"]) / (c["hi"] - c["lo"]) * 100 if c["hi"] != c["lo"] else 0
        disp = fmt_num(c["v"], c["stp"]) + c["unit"]
        return (f'<span class="slider" data-lo="{c["lo"]}" data-hi="{c["hi"]}" data-step="{c["stp"]}" '
                f'data-v="{c["v"]}" data-unit="{c["unit"]}"><i style="width:{frac:.1f}%"></i>'
                f'<b style="left:{frac:.1f}%"></b></span><span class="sv3">{disp}</span>')
    # step（步进）：− 值 +
    disp = fmt_num(c["v"], c["stp"]) + c["unit"]
    return (f'<div class="stepper" data-lo="{c["lo"]}" data-hi="{c["hi"]}" data-step="{c["stp"]}" '
            f'data-v="{c["v"]}" data-unit="{c["unit"]}">'
            f'<button class="stp" data-d="-1" type="button">−</button>'
            f'<span class="stv">{disp}</span>'
            f'<button class="stp" data-d="1" type="button">+</button></div>')

def row_html(label, hint, ctl):
    return (f'<div class="srow"><div class="info"><div class="t">{label}</div>'
            f'<div class="d">{hint}</div></div><div class="ctl">{ctl_html(ctl)}</div></div>')

# 左侧导航（每组一钮，data-gid 关联右侧面板）
stabs = '<div class="stabs-hd"><span class="avatar">F</span>设置<span class="sp" style="flex:1"></span>' \
        '<svg class="ico ico-14"><use href="#i-search"/></svg></div>'
for i, g in enumerate(GROUPS):
    on = " on" if i == 0 else ""
    stabs += f'<div class="stab{on}" data-gid="{g["id"]}"><svg class="ico ico-14"><use href="#i-{g["icon"][2:] if g["icon"].startswith("i-") else g["icon"]}"/></svg>{g["title"]}</div>'

# 右侧面板：每组一个 .spane，只显 active
panes = ""
for i, g in enumerate(GROUPS):
    on = " on" if i == 0 else ""
    rows = "".join(row_html(lab, hint, ctl) for lab, hint, ctl in g["rows"])
    panes += (
        f'<div class="spane{on}" data-gid="{g["id"]}">'
        f'<div class="st-head"><div><div class="t">{g["title"]}</div><div class="d">{g["desc"]}</div></div>'
        f'<span class="sp"></span>'
        f'<div class="btn sm" onclick="resetAll()"><svg class="ico ico-14"><use href="#i-restore"/></svg>恢复默认</div></div>'
        f'<div class="st-body"><div class="sgroup"><div class="scard">{rows}</div></div></div>'
        f'</div>'
    )

settings = f'<div class="settings"><div class="st-main">{panes}</div><div class="st-nav">{stabs}</div></div>'
# MoPage 版式是 .stabs(左) .st-main(右)；上面为了 DOM 简单先写 main 再 nav，用 flex order 校正：
settings = settings.replace('<div class="settings"><div class="st-main">', '<div class="settings"><div class="st-main">')  # 顺序交给 CSS .st-nav{order:-1}

# 外壳（Folio 文案，MoPage 结构/类名）——标题栏已按上轮去掉「主题切换/设置」两钮，只留 搜索/右栏/窗口控制
chrome = (
 '<div class="tbar">'
   '<div class="brand"><span class="mark">F</span><span class="brand-name">Folio</span></div>'
   '<nav class="menu"><b>文件</b><b>查看</b><b>文档</b><b>帮助</b></nav>'
   '<div class="tabs"><div class="tab on"><svg class="ico ico-14"><use href="#i-file-text"/></svg><span class="tn">1. 设置.md</span><span class="x"><svg class="ico ico-14"><use href="#i-x"/></svg></span></div></div>'
   '<div class="tbar-right">'
     '<div class="seg"><button class="on"><svg class="ico ico-14"><use href="#i-eye"/></svg>阅读</button><button><svg class="ico ico-14"><use href="#i-type"/></svg>编辑</button></div>'
     '<span class="divv"></span>'
     '<span class="iconbtn"><svg class="ico ico-18"><use href="#i-search"/></svg></span>'
     '<span class="iconbtn"><svg class="ico ico-18"><use href="#i-panel-r"/></svg></span>'
     '<div class="wctl"><i><svg class="ico ico-14"><use href="#i-minus"/></svg></i><i><svg class="ico ico-14"><use href="#i-max"/></svg></i><i class="close"><svg class="ico ico-14"><use href="#i-x"/></svg></i></div>'
   '</div>'
 '</div>'
 '<div class="body">'
   '<div class="rail">'
     '<button title="文档库" class="on" data-rail="files"><svg class="ico ico-20"><use href="#i-folder"/></svg></button>'
     '<button title="最近打开" data-rail="history"><svg class="ico ico-20"><use href="#i-clock"/></svg></button>'
     '<button title="大纲" data-rail="outline"><svg class="ico ico-20"><use href="#i-list"/></svg></button>'
     '<button title="搜索" data-rail="search"><svg class="ico ico-20"><use href="#i-search"/></svg></button>'
     '<div class="sp"></div>'
     '<button title="设置" id="openBtn2" onclick="openPage()"><svg class="ico ico-20"><use href="#i-sliders"/></svg></button>'
   '</div>'
   '<div class="center"><div class="prose reader" style="display:none">'
     '<h1>示例文档</h1><p>关闭设置后回到阅读态。设置整页作为「整个单独页面」呈现，Folio 外壳（顶栏、rail、状态栏）保持不变。</p>'
   '</div>' + settings + '</div>'
 '</div>'
 '<footer class="status"><span class="si"><svg class="ico ico-14"><use href="#i-sliders"/></svg>设置 · 外观</span><span class="sp"></span>'
   '<span class="si">配置文件</span><span class="si">~/.folio/settings.json</span>'
   '<span class="si ok"><svg class="ico ico-14"><use href="#i-check-circle"/></svg>已自动保存</span></footer>'
 '<div class="st-toast" id="toast"></div>'
)

js = """
<script>
"use strict";
function qsa(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}
function on(root,sel,ev,fn){root.addEventListener(ev,function(e){var t=e.target&&e.target.closest?e.target.closest(sel):null;if(t&&root.contains(t))fn(t,e);});}
function excl(list,el,cls){list.forEach(function(x){x.classList.remove(cls||'on');});el.classList.add(cls||'on');}
var app=document.body; // base.css 令牌挂在 .app[data-theme]，主题写在 body 上
document.addEventListener("DOMContentLoaded",function(){
  var win=document.querySelector('.win');
  on(win,'.seg button','click',function(b){excl(qsa('.seg button',b.parentNode),b);});
  on(win,'.rail button[data-rail]','click',function(b){excl(qsa('.rail button[data-rail]',b.parentNode),b);});
  on(win,'.menu b','click',function(m){excl(qsa('.menu b'),m,'open');});

  // 左侧导航：切组 → 只显示对应 .spane，更新状态栏
  on(win,'.stab[data-gid]','click',function(t){
    excl(qsa('.stab'),t,'on');
    var gid=t.getAttribute('data-gid');
    qsa('.spane').forEach(function(p){p.classList.toggle('on',p.getAttribute('data-gid')===gid);});
    var g=qsa('.stab').filter(function(x){return x.classList.contains('on');})[0];
    var s=document.querySelector('.status .si');if(s&&g)s.textContent='设置 · '+g.textContent.trim();
  });

  // 分段控件：点亮当前项；主题/字体族那组顺带真驱动外观
  on(win,'.radio','click',function(r){
    excl(qsa('.radio',r.parentNode),r,'on');
    var tv=r.getAttribute('data-themeval');
    if(tv){app.setAttribute('data-theme',tv);toast('主题：'+r.textContent.trim());}
  });

  // 步进 −/+：按 data-step 走，夹在 data-lo/data-hi，显示按步长小数位
  on(win,'.stp','click',function(b){
    var box=b.closest('.stepper');
    var lo=+box.dataset.lo,hi=+box.dataset.hi,st=+box.dataset.step,v=+box.dataset.v,d=+b.dataset.d;
    v=Math.min(hi,Math.max(lo,+(v+d*st).toFixed(6)));
    box.dataset.v=v;
    var dig=(''+st).split('.')[1];dig=dig?dig.length:0;
    box.querySelector('.stv').textContent=v.toFixed(dig)+box.dataset.unit;
  });

  // 滑杆：拖动即改填充与读数（纯前端演示，够用）
  function slideSet(sl,cx){
    var r=sl.getBoundingClientRect(),lo=+sl.dataset.lo,hi=+sl.dataset.hi,st=+sl.dataset.step;
    var frac=Math.min(1,Math.max(0,(cx-r.left)/r.width));
    var v=lo+frac*(hi-lo); var dig=(''+st).split('.')[1];dig=dig?dig.length:0;
    v=Math.round(v/st)*st; v=Math.min(hi,Math.max(lo,+v.toFixed(6)));
    var pct=(v-lo)/(hi-lo)*100;
    sl.querySelector('i').style.width=pct+'%'; sl.querySelector('b').style.left=pct+'%';
    sl.dataset.v=v;
    var lab=sl.parentNode.querySelector('.sv3');if(lab)lab.textContent=v.toFixed(dig)+sl.dataset.unit;
  }
  var dragging=null;
  on(win,'.slider','mousedown',function(sl,e){dragging=sl;slideSet(sl,e.clientX);e.preventDefault();});
  document.addEventListener('mousemove',function(e){if(dragging)slideSet(dragging,e.clientX);});
  document.addEventListener('mouseup',function(){dragging=null;});
});
window.resetAll=function(){
  qsa('.stepper').forEach(function(b){b.dataset.v=b.dataset.def||b.dataset.v;});
  // 演示级恢复：刷新各控件读数以回到生成时的默认（数据在生成时即默认值）
  qsa('.radio[data-val]').forEach(function(r){});
  toast('已恢复默认（主题、侧栏宽度不受影响）');
};
window.openPage=function(){document.querySelector('.settings').style.display='';document.querySelector('.reader').style.display='none';document.getElementById('openBtn2').classList.add('on');};
window.closePage=function(){document.querySelector('.settings').style.display='none';document.querySelector('.reader').style.display='';toast('已返回阅读（外壳不变）');};
window.toggleTheme=function(){var o=['dark','light'],c=document.body.getAttribute('data-theme')||'dark';document.body.setAttribute('data-theme',o[(o.indexOf(c)+1)%2]);};
var tt;function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(tt);tt=setTimeout(function(){t.classList.remove('show');},1400);}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closePage();});
</script>
"""

# 追加：toast + 让新面板在 center 里撑满 + 左侧导航占位（.st-nav 用 order 排到 .st-main 左）
extra = """
<style>
.center > .settings{flex:1;min-width:0}
/* 我们的 .settings 内先写 .st-main 再写 .st-nav，用 flex order 把导航挪到左侧，视觉等同 MoPage .stabs 左栏 */
.settings{display:flex;min-width:0;min-height:0;background:var(--bg-edit)}
.st-nav{order:-1;width:216px;flex:none;background:var(--bg-side);border-right:1px solid var(--line);padding:12px 10px;display:flex;flex-direction:column;gap:2px;overflow:auto}
.st-nav .stab{display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border-radius:var(--r-2);font-size:13px;color:var(--text-2);cursor:pointer;transition:background .14s,color .14s}
.st-nav .stab:hover{background:var(--bg-hover);color:var(--text)}
.st-nav .stab.on{background:var(--accent-bg);color:var(--accent);font-weight:600}
.st-nav .stabs-hd{font-size:14px;font-weight:650;color:var(--text);padding:6px 10px 10px;display:flex;align-items:center;gap:8px}
.st-nav .avatar{width:22px;height:22px;font-size:10px;border-radius:6px;background:var(--brand-hi);color:#05201C;display:inline-flex;align-items:center;justify-content:center;font-weight:700}
.st-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:auto}
.spane{display:none;flex-direction:column;min-width:0}
.spane.on{display:flex}
.sgroup{margin-bottom:24px}
.scard{background:var(--bg-raise);border:1px solid var(--line);border-radius:var(--r-3);overflow:hidden}
.srow{display:flex;align-items:center;gap:16px;padding:13px 15px;border-bottom:1px solid var(--line)}
.srow:last-child{border-bottom:0}
.srow .info{flex:1;min-width:0}
.srow .info .t{font-size:13px;color:var(--text);font-weight:550}
.srow .info .d{font-size:11.5px;color:var(--text-3);margin-top:3px;line-height:1.5}
.srow .ctl{display:flex;align-items:center;gap:8px;flex:none}
.radios{display:flex;gap:6px}
.radio{display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:var(--r-2);border:1px solid var(--line);background:var(--bg-edit);font-size:12.5px;color:var(--text-2);cursor:pointer;transition:border-color .12s,color .12s}
.radio .rd{width:12px;height:12px;border-radius:50%;border:1px solid var(--line-hi);flex:none}
.radio.on{border-color:var(--accent);color:var(--text)}
.radio.on .rd{border-color:var(--accent);background:radial-gradient(circle,var(--accent) 0 45%,transparent 46%)}
.slider{position:relative;width:150px;height:4px;border-radius:2px;background:var(--line);cursor:pointer}
.slider i{position:absolute;left:0;top:0;height:100%;border-radius:2px;background:var(--accent)}
.slider b{position:absolute;top:50%;width:12px;height:12px;margin-left:-6px;margin-top:-6px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.sv3{font-size:12px;color:var(--text-2);min-width:52px;text-align:right;font-variant-numeric:tabular-nums}
.stepper{display:flex;align-items:center;gap:6px}
.stp{width:26px;height:26px;border-radius:var(--r-2);border:1px solid var(--line);background:var(--bg-edit);color:var(--text-2);cursor:pointer;font-size:15px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.stp:hover{border-color:var(--line-hi);background:var(--bg-hover);color:var(--text)}
.stv{font-size:12.5px;color:var(--text);min-width:60px;text-align:center;font-variant-numeric:tabular-nums}
.st-head{flex:none;padding:16px 26px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px}
.st-head .t{font-size:17px;font-weight:650;color:var(--text)}
.st-head .d{font-size:12.5px;color:var(--text-3);margin-top:4px}
.st-head .sp{flex:1}
.st-body{padding:18px 26px 26px}
.btn.sm{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:var(--r-1);font-size:11.5px;font-weight:550;cursor:pointer;border:1px solid var(--line);background:var(--bg-raise);color:var(--text)}
.btn.sm:hover{border-color:var(--line-hi);background:var(--bg-hover)}
.st-toast{position:fixed;bottom:44px;left:50%;transform:translateX(-50%);background:var(--bg-raise);border:1px solid var(--line-hi);border-radius:15px;padding:7px 16px;font-size:12px;color:var(--text-2);box-shadow:var(--shadow-pop);opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.st-toast.show{opacity:1}
</style>
"""

doc = ('<!doctype html>\n<html lang="zh">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=1496">\n<title>Folio · 设置中心</title>\n'
       '<style>' + base + '</style>' + extra + '\n</head>\n'
       '<body class="app" data-theme="dark">\n<svg width=0 height=0 style="position:absolute" aria-hidden="true">' + sprite + '</svg>\n'
       '<div class="stage"><div class="win">\n' + chrome + '\n</div></div>\n' + js + '\n</body>\n</html>\n')

io.open("settings-page.html", "w", encoding="utf-8").write(doc)
print("wrote", len(doc), "bytes; 分组", len(GROUPS), "行合计", sum(len(g["rows"]) for g in GROUPS))
