import io, re

mo = "d:/aiprogram/mdediter/prototype/"
base = io.open(mo + "assets/base.css", encoding="utf-8").read()
scr = io.open(mo + "screens/06-settings.html", encoding="utf-8").read()

# 图标 sprite：复用 06 屏全套 defs（外壳与内容所需图标都在里面）
d0 = scr.index('<defs>'); d1 = scr.index('</defs>') + len('</defs>')
sprite = scr[d0:d1]

# .settings 内容块：按 div 配平裁到自身闭合
i = scr.index('<div class="settings">'); depth = 0; end = i
for m in re.finditer(r'<(/?)div\b[^>]*>', scr[i:]):
    if m.group(1) == '': depth += 1
    else:
        depth -= 1
        if depth == 0: end = i + m.end(); break
mo_content = scr[i:end]

# 正文最大宽度 → 720 / 900(默认) / 1280 / 填满（Folio 真实档；界面密度那组含"紧凑"不匹配此正则）
def rd(txt, on=False):
    return '<span class="radio' + (" on" if on else "") + '"><span class="rd"></span>' + txt + '</span>'
MEASURE_NEW = '<div class="radios">' + rd("720 px") + rd("900 px", True) + rd("1280 px") + rd("填满") + '</div>'
mo_content, n = re.subn(r'<div class="radios"><span class="radio"><span class="rd"></span>720 px</span>.*?</div>',
                        MEASURE_NEW, mo_content, count=1, flags=re.S)
assert n == 1, "正文最大宽度 radios 未匹配"

# 去 MoPage 品牌：头像「墨」→「F」、「墨页 设置」→「设置」、色名「墨绿」→「青绿」
mo_content = mo_content.replace('<span class="avatar">墨</span>墨页 设置', '<span class="avatar">F</span>设置')
mo_content = mo_content.replace('墨绿', '青绿')

# 不做「正文字体」下拉：Folio 真实模型里没有字体名字段（只有 serif 布尔 + fsSerif/fsSans），
# 下拉既落不了库、又与下面的「字体族」重复。下面把 MoPage 的「正文字体」整行就地换成「字体族」。
def div_end(s, start):
    """从 start 处的 <div> 起，做 div 配平，返回其闭合标签结束位置（不含前导内容）。"""
    depth = 0
    for m in re.finditer(r'<(/?)div\b[^>]*>', s[start:]):
        depth += 1 if m.group(1) == '' else -1
        if depth == 0:
            return start + m.end()
    raise ValueError("div 未闭合")

# ── 补充 Folio 真实设置（原样式/原内容一律不动，只在末尾追加一组 + 一个左导航按钮）──────
# 数据来源：source/src/lib/settings-spec.ts（有哪些项/文案/控件）+ typography.ts（默认值/区间/步长）
# 只补 MoPage 页面上「Folio 有、但没演示到」的那几项：字体族 / 行高 / 字距 / 段落间距 / 对齐 / 代码字号 / 表格密度。
# （主题/字号/宽度/字体这几项 MoPage 版已有，按「保留原样」不重复添加。）
def srow(label, hint, ctl):
    return ('<div class="srow"><div class="info"><div class="t">' + label + '</div>'
            '<div class="d">' + hint + '</div></div><div class="ctl">' + ctl + '</div></div>')
def seg_labels(opts, sel):
    return '<div class="radios">' + "".join(rd(l, i == sel) for i, l in enumerate(opts)) + '</div>'
def slide(v, lo, hi, unit, digits):
    pct = (v - lo) / (hi - lo) * 100
    return ('<span class="slider"><i style="width:' + f'{pct:.1f}%' + '"></i>'
            '<b style="left:' + f'{pct:.1f}%' + '"></b></span>'
            '<span class="sv3">' + f'{v:.{digits}f}' + unit + '</span>')
def stepper(v, lo, hi, stp, unit, digits):
    return ('<div class="stepper" data-lo="' + str(lo) + '" data-hi="' + str(hi) + '" data-step="' + str(stp) +
            '" data-v="' + str(v) + '" data-unit="' + unit + '">'
            '<button class="stp" data-d="-1" type="button">−</button>'
            '<span class="stv">' + f'{v:.{digits}f}' + unit + '</span>'
            '<button class="stp" data-d="1" type="button">+</button></div>')

# 分组按「各管一件事」切干净，避免组间重叠：
#   排版   = 字号 / 字体 / 字体族 / 最大宽度  （用什么字、多大、多宽）
#   段落   = 行高 / 字距 / 段落间距 / 对齐    （字与字、段与段之间的节奏）
#   代码与表格 = 代码字号 / 表格密度
# 字体族属于「用什么字」，归到排版，不放段落（原来它俩都在讲字体，界线才糊）。
def group(title, rows):
    return '<div class="sgroup"><div class="gt">' + title + '</div><div class="scard">' + "".join(rows) + '</div></div>'
FOLIO_GROUPS = group("段落", [
    srow("行高", "行距 = 字号 × 倍数。中文正文 1.7–2.0 最舒服。", slide(1.85, 1.4, 2.4, "×", 2)),
    srow("字距", "额外字间距 em，0 为不加；中文长文加一点点更透气。", slide(0.0, 0, 0.12, " em", 3)),
    srow("段落间距", "段与段之间的空白，按正文字号倍数换算。", stepper(1.0, 0.6, 2, 0.05, " em", 2)),
    srow("对齐方式", "两端对齐让中文右缘整齐；左对齐保留自然参差。", seg_labels(["左对齐", "两端对齐"], 0)),
]) + group("代码与表格", [
    srow("代码字号", "代码块比正文略小更耐读；只影响代码块，不动正文。", stepper(12.5, 10.5, 15.5, 0.5, " px", 1)),
    srow("表格密度", "表格单元格的松紧三档。", seg_labels(["紧凑", "标准", "宽松"], 1)),
])

# 把 MoPage「排版」卡里的「正文字体」整行就地换成「字体族」行（Folio 只有 serif/sans，没有字体名，避免与字体族重复）。
FONTZU_ROW = srow("字体族", "正文用衬线还是无衬线；两族各自记住字号，切换不丢设置。", seg_labels(["衬线", "无衬线"], 0))
KEY_FZ = '<div class="srow"><div class="info"><div class="t">正文字体</div>'
assert mo_content.count(KEY_FZ) == 1, "正文字体行锚点非唯一"
_st = mo_content.index(KEY_FZ); _en = div_end(mo_content, _st)
mo_content = mo_content[:_st] + FONTZU_ROW + mo_content[_en:]
# 插到「排版」组之后、「编辑区」组之前：排版/字体/段落这类正文设置相邻，编辑区开关殿后，读起来不跳。
ANCHOR = '<div class="sgroup"><div class="gt">编辑区</div>'
assert mo_content.count(ANCHOR) == 1, "编辑区组锚点非唯一"
mo_content = mo_content.replace(ANCHOR, FOLIO_GROUPS + ANCHOR, 1)

# ── 让左导航与右侧「设置分组」严格一一对应：导航由右侧实际存在的 .sgroup 反推生成 ──
# 数据源=内容本身，二者永不脱节；右侧没有对应内容的 MoPage 空标签（编辑器/快捷键/扩展/同步/语言/高级）
# 据此不再出现在导航里（内容一行没删，只是不给它挂一个点不到的导航）。
gids = []
def _sgid(_m):
    gid = 'sg%d' % len(gids); gids.append(gid); return '<div class="sgroup" id="%s"' % gid
mo_content = re.sub(r'<div class="sgroup(?: id="folio-real")?', _sgid, mo_content)          # 每个顶层组编号 +id
gt_labels = re.findall(r'<div class="gt">([^<]*)</div>', mo_content)                          # 按文档序取组标题
assert len(gt_labels) == len(gids), ("分组数与导航数不符", len(gids), len(gt_labels))
def icon_for(label):
    for kw, ic in [("主题", "i-contrast"), ("排版", "i-type"), ("段落", "i-list"),
                   ("代码", "i-code"), ("编辑区", "i-file-text")]:
        if kw in label:
            return ic
    return "i-sliders"
newtabs = ''
for idx, (gid, label) in enumerate(zip(gids, gt_labels)):
    on = ' on' if idx == 0 else ''
    newtabs += ('<div class="stab%s" data-target="%s"><svg class="ico ico-14" aria-hidden="true">'
                '<use href="#%s"/></svg>%s</div>' % (on, gid, icon_for(label), label))
# 保留原 .stabs-hd 品牌抬头，其余标签整体换成上面生成的这组
st_start = mo_content.index('<div class="stabs">')
hd_start = mo_content.index('<div class="stabs-hd">', st_start)
hd_end = mo_content.index('</div>', hd_start) + len('</div>')
hd = mo_content[hd_start:hd_end]
main_pos = mo_content.index('<div class="st-main">')
mo_content = (mo_content[:st_start] + '<div class="stabs">' + hd + newtabs + '</div>' + mo_content[main_pos:])
# 去掉 base.css 顶部 @import Google Fonts（离线应回退系统字体，且避免 headless 截图卡网络）。
# URL 里含 ';'（wght@400;500…），必须按 url(...) 括号闭合来切，不能拿 [^;]*; 截——
# 那样只删到第一个内部分号，残余的 …swap'); 会把紧跟的 :root 几何令牌块（--r-1/-2/-3/-win）一起吞成非法 CSS，
# 于是所有 var(--r-*) 塌成直角（实测 .scard/.btn/.radio 全 0）。
base = re.sub(r"@import\s+url\([^)]*\)\s*;", "", base)
# base.css 顶部设计系统注释里的品牌字也中性化（源码不留「墨页 / MoPage」）
base = base.replace('墨页 MoPage · Markdown 编辑查看工具 — 原型设计系统', 'Folio · 设计系统（同源令牌沿用）')

# 配色预览「纹路」按截图重画：每卡 = 侧栏 + 强调/灰/灰/强调，首尾两条用「该主题自己的强调色」
# （原稿第 4 条是青绿，与主题无关；截图里深色=蓝、浅色=蓝、米色=棕，且灰条更宽）。改的是 mo_content，
# 使重新生成 settings-page.html 仍是这套；prototype.html 里的同款字符串也已同步（两边保持一致）。
THCPATTERN = [
 ('<span class="l" style="background:#7FB2FF;width:60%"></span><span class="l" style="background:#2A3B58;width:82%"></span><span class="l" style="background:#2A3B58;width:70%"></span><span class="l" style="background:#2DD4BF;width:46%"></span>',
  '<span class="l" style="background:var(--accent);width:62%"></span><span class="l" style="background:#2A3B58;width:90%"></span><span class="l" style="background:#2A3B58;width:82%"></span><span class="l" style="background:var(--accent);width:55%"></span>'),
 ('<span class="l" style="background:#2563EB;width:60%"></span><span class="l" style="background:#DBE0E9;width:82%"></span><span class="l" style="background:#DBE0E9;width:70%"></span><span class="l" style="background:#0D9488;width:46%"></span>',
  '<span class="l" style="background:var(--accent);width:62%"></span><span class="l" style="background:#DBE0E9;width:90%"></span><span class="l" style="background:#DBE0E9;width:82%"></span><span class="l" style="background:var(--accent);width:55%"></span>'),
 ('<span class="l" style="background:#8A4A24;width:60%"></span><span class="l" style="background:#DED2B9;width:82%"></span><span class="l" style="background:#DED2B9;width:70%"></span><span class="l" style="background:#A0562A;width:46%"></span>',
  '<span class="l" style="background:var(--accent);width:62%"></span><span class="l" style="background:#DED2B9;width:90%"></span><span class="l" style="background:#DED2B9;width:82%"></span><span class="l" style="background:var(--accent);width:55%"></span>'),
]
for _o, _n in THCPATTERN:
    assert mo_content.count(_o) == 1, ("配色预览锚点缺失", _o[:36])
    mo_content = mo_content.replace(_o, _n)

# 强调色色板补一枚「赭石」棕（截图色 #A0562A，即护眼米色的主色）——追加到玫红之后、文字标签之前
_ACC_OLD = '<i style="background:#FB7185"></i><span class="sv3">青绿</span>'
_ACC_NEW = '<i style="background:#FB7185"></i><i style="background:#A0562A"></i><span class="sv3">青绿</span>'
assert mo_content.count(_ACC_OLD) == 1, "强调色色板锚点非唯一"
mo_content = mo_content.replace(_ACC_OLD, _ACC_NEW, 1)

# 设置窗口顶部：导入/导出=图标按钮靠左，撤销更改与「保存并关闭」（主按钮）并排且保存在最右
_HEAD_OLD = ('<span class="sp"></span><div class="btn sm"><svg class="ico ico-14" aria-hidden="true">'
             '<use href="#i-history"/></svg>撤销更改</div><div class="btn sm"><svg class="ico ico-14" '
             'aria-hidden="true"><use href="#i-download"/></svg>导出配置</div>')
_HEAD_NEW = ('<span class="sp"></span>'
             '<span class="iconbtn cfg-ib" id="cfg-import" title="导入配置（正式版读取 settings.json）">'
             '<svg class="ico ico-14" aria-hidden="true"><use href="#i-upload"/></svg></span>'
             '<span class="iconbtn cfg-ib" id="cfg-export" title="导出配置（正式版写出 settings.json）">'
             '<svg class="ico ico-14" aria-hidden="true"><use href="#i-download"/></svg></span>'
             '<div class="btn sm" id="cfg-undo"><svg class="ico ico-14" '
             'aria-hidden="true"><use href="#i-history"/></svg>撤销更改</div>'
             '<div class="btn sm primary" id="cfg-save"><svg class="ico ico-14" aria-hidden="true">'
             '<use href="#i-check"/></svg>保存并关闭</div>')
assert mo_content.count(_HEAD_OLD) == 1, "设置窗口头部锚点非唯一"
mo_content = mo_content.replace(_HEAD_OLD, _HEAD_NEW, 1)

# 编辑区「行号与缩略图」：删除装饰性下拉（连同 ˅ 箭头），只留开关——真实 Folio 无此设置，
# 下拉不托管易被当成真控件（箭头被问「为什么有个向下的箭头」即此）
_SEL_OLD = ('<div class="sw on"></div><div class="select">行号 + 缩略图'
            '<svg class="ico ico-14" aria-hidden="true"><use href="#i-chev-d"/></svg></div>')
_SEL_NEW = '<div class="sw on"></div>'
assert mo_content.count(_SEL_OLD) == 1, "行号缩略图下拉锚点非唯一"
mo_content = mo_content.replace(_SEL_OLD, _SEL_NEW, 1)

# 外壳（Folio 文案，MoPage 结构/类名）
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
   '</div>' + mo_content + '</div>'
 '</div>'
 '<footer class="status"><span class="si"><svg class="ico ico-14"><use href="#i-sliders"/></svg>设置 · 外观与主题</span><span class="sp"></span>'
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
  on(win,'.stab','click',function(t){excl(qsa('.stab'),t,'on');var h=document.querySelector('.st-head .t');if(h)h.textContent=(t.textContent||'').replace(/\\d+$/,'').trim();var g=t.getAttribute&&t.getAttribute('data-target');if(g){var el=document.getElementById(g);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});}});
  var TB={'深色':'dark','浅色':'light','护眼米色':'sepia'};
  on(win,'.thc','click',function(c){excl(qsa('.thc'),c,'on');var n=((c.querySelector('.meta')||{}).textContent||'').trim();if(TB[n])app.setAttribute('data-theme',TB[n]);});
  on(win,'.swatches i','click',function(x){excl(qsa('.swatches i',x.parentNode),x,'on');app.style.setProperty('--accent',getComputedStyle(x).backgroundColor);});
  on(win,'.radio','click',function(r){excl(qsa('.radio',r.parentNode),r,'on');});
  on(win,'.sw','click',function(s){s.classList.toggle('on');});
  // Folio 补充项的步进：±按 data-step 走，夹在 data-lo/hi，按步长小数位显示（与 clampNum 同口径）
  on(win,'.stp','click',function(b){
    var box=b.closest('.stepper'),lo=+box.dataset.lo,hi=+box.dataset.hi,st=+box.dataset.step,v=+box.dataset.v,d=+b.dataset.d;
    v=Math.min(hi,Math.max(lo,+(v+d*st).toFixed(6)));box.dataset.v=v;
    var dig=(''+st).split('.')[1];dig=dig?dig.length:0;
    box.querySelector('.stv').textContent=v.toFixed(dig)+box.dataset.unit;
  });
});
window.openPage=function(){document.querySelector('.settings').style.display='';document.querySelector('.reader').style.display='none';document.getElementById('openBtn2').classList.add('on');};
window.closePage=function(){document.querySelector('.settings').style.display='none';document.querySelector('.reader').style.display='';toast('已返回阅读（外壳不变）');};
window.toggleTheme=function(){var o=['dark','light','sepia'],c=document.body.getAttribute('data-theme')||'dark';document.body.setAttribute('data-theme',o[(o.indexOf(c)+1)%3]);};
var tt;function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(tt);tt=setTimeout(function(){t.classList.remove('show');},1400);}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closePage();});
</script>
"""

# 追加：① 保留 MoPage 原版外框（.stage 四周内边距 + .win 圆角阴影卡片），② toast，③ .settings 撑满 center
extra = """
<style>
.center > .settings{flex:1;min-width:0}
.st-toast{position:fixed;bottom:44px;left:50%;transform:translateX(-50%);background:var(--bg-raise);border:1px solid var(--line-hi);border-radius:15px;padding:7px 16px;font-size:12px;color:var(--text-2);box-shadow:var(--shadow-pop);opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.st-toast.show{opacity:1}
/* 图标/徽标一律用强调色纯色，不用渐变：覆盖 base.css 里 .mark / .avatar 的 linear-gradient 与高光 inset 阴影 */
.mark{background:var(--accent);box-shadow:none}
.avatar{background:var(--accent)}
/* Folio 补充项用的步进控件：− 值 +，观感对齐 MoPage .btn.sm / .sv3 */
.stepper{display:flex;align-items:center;gap:6px}
.stp{width:26px;height:26px;border-radius:var(--r-2);border:1px solid var(--line);background:var(--bg-edit);color:var(--text-2);cursor:pointer;font-size:15px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.stp:hover{border-color:var(--line-hi);background:var(--bg-hover);color:var(--text)}
.stv{font-size:12.5px;color:var(--text);min-width:64px;text-align:center;font-variant-numeric:tabular-nums}
/* 主题预览小线条 .l 是空 span，base.css 没给 display → 内联时空宽高失效、纹路根本不显示；补块级才画得出来 */
.thc .prev .l{display:block}
/* 设置窗口头部：保存并关闭=主按钮（.btn.sm 与 .btn.primary 同权重时靠顺序取胜，这里显式覆盖）；导入/导出图标钮收进 26px 方块 */
.st-head .btn.sm.primary{background:var(--accent);border-color:transparent;color:var(--accent-ink)}
.st-head .btn.sm.primary:hover{background:var(--accent-dim)}
.st-head .cfg-ib{width:26px;height:26px;border-radius:6px;color:var(--text-2);flex:none}
.st-head .cfg-ib:hover{background:var(--bg-hover);color:var(--text)}
</style>
"""

doc = ('<!doctype html>\n<html lang="zh">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=1496">\n<title>Folio · 设置中心</title>\n'
       '<style>' + base + '</style>' + extra + '\n</head>\n'
       '<body class="app" data-theme="dark">\n<svg width=0 height=0 style="position:absolute" aria-hidden="true">' + sprite + '</svg>\n'
       '<div class="stage"><div class="win">\n' + chrome + '\n</div></div>\n' + js + '\n</body>\n</html>\n')

io.open("settings-page.html", "w", encoding="utf-8").write(doc)
print("wrote", len(doc), "bytes; 全量 base.css 内联；content len", len(mo_content))
