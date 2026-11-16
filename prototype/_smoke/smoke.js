"use strict";
// Smoke test: run Folio prototype in jsdom with stubbed layout, exercise the
// interactions changed per the codex review. Usage: node smoke.js <html path>
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const htmlPath = path.resolve(process.argv[2] || "prototype.html");
const html = fs.readFileSync(htmlPath, "utf-8");
const errors = [];

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "http://localhost/folio/",
  pretendToBeVisual: true,
  virtualConsole: (() => {
    const { VirtualConsole } = require("jsdom");
    const vc = new VirtualConsole();
    vc.on("jsdomError", e => errors.push("jsdomError: " + e.message));
    return vc;
  })(),
  beforeParse(window){
    // layout stubs BEFORE page scripts run (boot renderDoc uses them)
    const { document } = window;
    const EL = window.Element.prototype;
    EL.scrollIntoView = function(){};
    Object.defineProperty(EL, "offsetTop", { get(){ let n = this, y = 0;
      while(n && n.id !== "scroll-area"){ y += 10; n = n.parentElement; } return y; }, configurable: true });
    EL.getBoundingClientRect = () => ({ top:0, bottom:0, left:0, right:0, width:100, height:100 });
    Object.defineProperty(EL, "offsetWidth", { get(){ return 100; }, configurable: true });
    window.addEventListener("error", e => errors.push("window.onerror: " + e.message));
    window.addEventListener("load", () => {
      const view = document.getElementById("scroll-area");
      let _st = 0;
      Object.defineProperty(view, "scrollTop", {
        get(){ return _st; }, set(v){ _st = Math.round(v); }, configurable: true });
      Object.defineProperty(view, "scrollHeight", { get(){ return 5000; }, configurable: true });
      Object.defineProperty(view, "clientHeight", { get(){ return 800; }, configurable: true });
      view.scrollTo = function(o){ if(o && o.top != null) this.scrollTop = o.top; };
      const edScroll = document.getElementById("ed-scroll");
      let _est = 0;
      Object.defineProperty(edScroll, "scrollTop", {
        get(){ return _est; }, set(v){ _est = Math.max(0, Math.round(v)); }, configurable: true });
      Object.defineProperty(edScroll, "clientHeight", { get(){ return 600; }, configurable: true });
      Object.defineProperty(edScroll, "clientWidth", { get(){ return 800; }, configurable: true });
    });
  },
});
const { window } = dom;
const { document } = window;

let pass = 0, fail = 0;
function check(name, cond, extra){
  if(cond){ pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  [" + extra + "]" : "")); }
}
function key(target, k, mods){
  const ev = new window.KeyboardEvent("keydown", Object.assign(
    { key: k, bubbles: true, cancelable: true }, mods || {}));
  target.dispatchEvent(ev);
  return ev;
}
function click(el){ el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); }
function dbl(el){ el.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true })); }
const pkRow = key => [...document.querySelectorAll("#pk-list .tf[data-k]")].find(r => r.dataset.key === key);
function fire(el, type){ el.dispatchEvent(new window.Event(type, { bubbles: true })); }
const $ = id => document.getElementById(id);
// toast 现为队列制（N1）：断言前清场，动作后的提示必然落到可见槽
function resetToast(){ window.eval('toastQueue.length = 0; clearTimeout(toastTimer); toastEl.classList.remove("show");'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(){
await sleep(300);   // let load + stubs + boot finish
try{
  // 0) boot
  check("boot: no runtime errors", errors.length === 0, errors.join("; "));
  check("boot: article rendered", /Folio 使用指南/.test($("article").textContent));
  check("boot: outline items are focusable buttons",
    [...document.querySelectorAll("#out-body .ol")].every(e => e.tagName === "BUTTON" && e.tabIndex >= 0));
  check("boot: deep link unified", $("stat-link").textContent === "folio://open?doc=guide", $("stat-link").textContent);
  // stats must EXCLUDE the auto-generated ".sub" meta line
  const subLen = $("article").querySelector(".sub").textContent.replace(/\s+/g,"").length;
  const full = $("article").textContent.replace(/\s+/g,"").length;
  const shown = Number($("stat-words").textContent.replace(/,/g,""));
  check("boot: stats exclude meta line", shown === full - subLen,
    "full=" + full + " sub=" + subLen + " shown=" + shown);
  check("boot: hist has start entry", window.eval("hist.stack.length") === 1);

  // 1) keydown guard in editor
  click($("seg-edit"));
  check("edit: entered edit mode", !$("editor-wrap").hidden);
  const editor = $("editor"); editor.focus();
  view_set(900);
  key(editor, "Home");
  check("guard: Home in editor does not scroll view", view_get() === 900, "scrollTop=" + view_get());
  key(editor, "ArrowDown", { altKey: true });
  key(editor, "/");
  check("guard: Alt+Down / Ctrl+/ inert in editor",
    !$("keys-overlay").classList.contains("open") && !$("search-overlay").classList.contains("open"));

  // 2) dirty -> Esc discard (Ctrl+S/Ctrl+E/Esc allowed)
  editor.value = editor.value + "\n\n## 未保存的临时章节ZZZ";
  fire(editor, "input");
  check("dirty: tab dot + editor hint shown (no status-bar triple)",
    !$("tab-dirty").hidden && !$("dirty-hint").hidden && !$("stat-dirty"));
  resetToast();
  key(editor, "e", { ctrlKey: true });
  check("guard: Ctrl+E from editor exits edit (clean after save...)", $("editor-wrap").hidden);
  check("dirty after Ctrl+E save: cleared + toast", $("tab-dirty").hidden &&
    $("toast-msg").textContent.includes("已保存"));
  // Ctrl+E discarded dirty state: verify src changed after save
  check("edit: Ctrl+E actually saved", window.eval("DOCS.guide.src").includes("临时章节ZZZ"));
  // enter again, type, Esc => discard
  click($("seg-edit"));
  editor.value = editor.value + "\n\n### ESC丢弃测试";
  fire(editor, "input");
  check("dirty: set again", !$("tab-dirty").hidden);
  resetToast();
  key(editor, "Escape");
  check("esc: discard exits edit, content NOT saved",
    $("editor-wrap").hidden && !window.eval("DOCS.guide.src").includes("ESC丢弃测试") &&
    $("toast-msg").textContent.includes("放弃"));

  // 3) switch doc while dirty -> explicit auto-save notice
  click($("seg-edit"));
  editor.value = editor.value + "\n\n## 切换自动保存ZZ";
  fire(editor, "input");
  resetToast();
  click(document.querySelector('#lib-list .tf[data-doc="rust"]'));
  check("switch: dirty saved and notice toast",
    window.eval("DOCS.guide.src").includes("切换自动保存ZZ") &&
    $("toast-msg").textContent.includes("已自动保存"), $("toast-msg").textContent);
  check("switch: dirty cleared", $("tab-dirty").hidden && window.eval("state.dirty") === false);
  check("switch: rust rendered", /Rust 学习笔记/.test($("article").textContent));

  // 4) per-doc position map: scroll rust, wait debounce, switch away & back -> resume
  view_set(2400); fire($("scroll-area"), "scroll");
  await sleep(700);
  check("pos: per-doc map written for rust",
    !!window.eval("store.get('folio-pos-map', {})").rust,
    Object.keys(window.eval("store.get('folio-pos-map', {})")).join(","));
  click(document.querySelector('#lib-list .tf[data-doc="guide"]'));
  click(document.querySelector('#lib-list .tf[data-doc="rust"]'));
  check("pos: switching back resumes (not zero)", view_get() > 0, "scrollTop=" + view_get());
  check("pos: hist entry carries top", window.eval("hist.stack.some(h => h.top != null)"));

  // 5) demo entry: honest empty stats
  click(document.querySelector('#lib-list .tf[data-doc="arch"]'));
  check("demo: stats show — not placeholder counts",
    $("stat-words").textContent === "—" && $("stat-secs").textContent === "—");
  check("demo: outline says not loaded", $("out-body").textContent.includes("内容未加载"));
  check("demo: deep link shows —", $("stat-link").textContent === "—");

  // 6) search: jump keeps hit nav, F3 cycles, Esc clears (on guide, has multi-hit word)
  click(document.querySelector('#lib-list .tf[data-doc="guide"]'));
  key(document.body, "f", { ctrlKey: true });
  $("search-input").value = "大纲";
  fire($("search-input"), "input");
  check("search: results rendered", document.querySelectorAll("#search-results .hit").length > 0);
  $("search-input").dispatchEvent(new window.KeyboardEvent("keydown",
    { key: "Enter", bubbles: true, cancelable: true }));
  check("search: hit nav visible with N / M", !$("hitnav").hidden &&
    /^\d+ \/ \d+$/.test($("hn-count").textContent), $("hn-count").textContent);
  $("search-input").value = "大纲";
  fire($("search-input"), "input");
  $("search-input").dispatchEvent(new window.KeyboardEvent("keydown",
    { key: "Enter", bubbles: true, cancelable: true }));
  const marks = document.querySelectorAll("#article mark.hit").length;
  check("search: whole-doc highlight applied", marks > 3, "marks=" + marks);
  const c0 = $("hn-count").textContent;
  key(document.body, "F3");
  check("search: F3 cycles hit", $("hn-count").textContent !== c0, c0 + " -> " + $("hn-count").textContent);
  key(document.body, "Escape");
  check("esc: clears highlights and hit nav",
    document.querySelectorAll("#article mark.hit").length === 0 && $("hitnav").hidden);

  // 7) focus mode: Esc exits
  window.eval("toggleFocus()");
  check("focus: chrome hidden class on", document.querySelector(".win").classList.contains("focus"));
  key(document.body, "Escape");
  check("focus: Esc exits focus mode", !document.querySelector(".win").classList.contains("focus"));

  // 8) typography（走配置界面：按「行标题 + 选项文本」点击——markup 与 settings-page 一致，控件无 data 钩子）
  window.eval("openSettings()");
  const clickOpt = window.eval("(function(title,opt){for(const r of document.querySelectorAll('#settings-view .srow')){const t=r.querySelector('.info .t');if(t&&t.textContent.trim()===title){for(const x of r.querySelectorAll('.radio')){if(x.textContent.trim().indexOf(opt)===0){x.click();return true;}}}}return false;})");

  // 8a) 配置窗口头部：保存并关闭 与 撤销更改 并排；导入/导出各压缩为一枚图标按钮
  const undoBtn = document.querySelector("#settings-view #cfg-undo");
  const saveBtn = document.querySelector("#settings-view #cfg-save");
  check("cfg-head: 撤销更改/保存并关闭并排且为主按钮", !!undoBtn && !!saveBtn &&
    saveBtn.classList.contains("primary") && saveBtn.textContent.includes("保存并关闭") &&
    !!undoBtn.querySelector('use[href="#i-history"]') && !!saveBtn.querySelector('use[href="#i-check"]'));
  check("cfg-head: 导入/导出=无文字图标钮", ["#cfg-import", "#cfg-export"].every(id2 => {
    const b = document.querySelector("#settings-view " + id2);
    return !!b && b.classList.contains("iconbtn") && !b.textContent.trim() &&
      /导入配置|导出配置/.test(b.getAttribute("title"));
  }));
  const accBefore = window.eval("state.prefs.accent");
  window.eval("document.querySelector('#settings-view .swatches i:nth-child(2)').click()");
  check("cfg: 强调色改动即时生效", window.eval("state.prefs.accent") !== accBefore);
  click(undoBtn);
  check("cfg-undo: 回到打开设置时的基线", window.eval("state.prefs.accent") === accBefore);
  click(document.querySelector("#settings-view #cfg-import"));
  click(document.querySelector("#settings-view #cfg-export"));
  check("cfg-io: 导入/导出仅演示提示，不改 prefs",
    window.eval("state.prefs.accent") === accBefore && window.eval("state.prefs.width") === 900);

  const serifFs = window.eval("curFs()");
  check("界面: 字体族行存在可点的无衬线", clickOpt("字体族", "无衬线") === true);
  const sansFs = window.eval("curFs()");
  check("prefs: serif/sans have separate baselines", serifFs === 15.5 && sansFs === 14, serifFs + "/" + sansFs);
  clickOpt("正文最大宽度", "1280");
  check("prefs: width var applied", $("article").style.getPropertyValue("--prose-w") === "1280px");
  clickOpt("对齐方式", "两端对齐");
  check("prefs: align var applied", $("article").style.getPropertyValue("--prose-align") === "justify");
  clickOpt("表格密度", "宽松");
  check("prefs: table density class applied", document.querySelector("#article").classList.contains("density-loose"));
  click(document.querySelector("#settings-view #cfg-save"));   // 保存并关闭：持久化 + 收起，替代裸 closeSettings
  check("cfg-save: 保存并关闭收起配置界面", !document.body.classList.contains("settings-open"));
  const saved = JSON.parse(window.eval("localStorage.getItem('folio-prefs')"));
  check("prefs: persisted with new schema", typeof saved.fs === "object" && saved.width === 1280);
  check("prefs: default width widened to 900", window.eval("normalizePrefs(null).width") === 900);
  check("prefs: legacy 790 migrates to 900",
    window.eval("normalizePrefs({ theme:'dark', serif:true, fs:15.5, width:790, lh:1.85 }).width") === 900);

  // 9) Ctrl+O opens the in-spec picker dialog (Windows-like skin, no native window)
  const ev = key(document.body, "o", { ctrlKey: true });
  check("ctrl+O: bound & prevented", ev.defaultPrevented);
  check("ctrl+O: in-window picker opens; no native file input left in page",
    $("pick-overlay").classList.contains("open") && !document.querySelector('input[type="file"]'));
  check("pick: Windows-like chrome (quick-access tree + list + fname row)",
    $("pk-tree").textContent.includes("快速访问") && document.querySelectorAll("#pk-list .tf").length >= 2 &&
    !!$("pk-name") && !!$("pk-fmt") && $("pk-name").value === "");
  key(document.body, "Escape");
  check("pick: Esc closes picker", !$("pick-overlay").classList.contains("open"));

  // 10) props modal
  window.eval("openProps()");
  check("props: real modal with rows", $("info-overlay").classList.contains("open") &&
    $("info-body").querySelectorAll(".krow").length >= 8 &&
    $("info-body").textContent.includes("folio://open?doc="));
  key(document.body, "Escape");
  check("props: Esc closes", !$("info-overlay").classList.contains("open"));

  // 11) editor line-number gutter
  click($("seg-edit"));
  const lineCnt = window.eval("editor.value.split('\\n').length");
  check("lnum: one cell per logical line", $("lnum").children.length === lineCnt,
    $("lnum").children.length + " vs " + lineCnt);
  check("lnum: numbered from 1", $("lnum").children[0].textContent === "1" &&
    $("lnum").children[lineCnt - 1].textContent === String(lineCnt));
  check("lnum: current-line highlight present", !!$("lnum").querySelector("i.cur"));
  window.eval("editor.value += '\\nx\\ny'; editor.selectionStart = editor.value.length;");
  fire($("editor"), "input");
  await sleep(80);   // rAF rebuild
  check("lnum: updates after edit", $("lnum").children.length === lineCnt + 2,
    $("lnum").children.length + " vs " + (lineCnt + 2));
  check("lnum: cur follows caret to last line",
    $("lnum").querySelector("i.cur") === $("lnum").children[lineCnt + 1]);
  click($("editor-discard"));

  // 11a) regression guard: textarea must fill its wrapper (absolute inset:0),
  //      not fall back to default cols width inside a block-level wrapper
  check("layout: wrapper is the scroller, textarea auto-height absolute",
    /\.editor-hl-wrap\{[^}]*overflow-y:auto/.test(fs.readFileSync(htmlPath, "utf-8")));

  // 11b) markdown syntax coloring layer
  click($("seg-edit"));
  const hl0 = $("hl-pre").innerHTML;
  check("hl: guide painted with head/hash/fence spans",
    hl0.includes('class="hl-head"') && hl0.includes('class="hl-hash"') && hl0.includes('class="hl-fence"'));
  check("layout: textarea height auto-set (bottom gap via wrapper scroll)",
    parseFloat($("editor").style.height) > 100, $("editor").style.height);
  const ed1 = $("editor");
  ed1.selectionStart = ed1.value.length;
  ed1.dispatchEvent(new window.KeyboardEvent("keyup", { key: "End", bubbles: true }));
  check("caret: ensureCaretVisible scrolls wrapper at doc end",
    $("ed-scroll").scrollTop > 0, "scrollTop=" + $("ed-scroll").scrollTop);
  $("ed-scroll").scrollTop = 0;
  const ed2 = $("editor");
  ed2.value = "```js\nlet a = '**not highlighted**';\n```\n# 标题高亮\n- [ ] 任务项\n**粗** 和 `码`\n";
  fire(ed2, "input");
  await sleep(80);
  const hl2 = $("hl-pre").innerHTML;
  check("hl: heading + task + bold + inline code colored", hl2.includes("hl-head") &&
    hl2.includes("标题高亮") && hl2.includes("hl-task") && hl2.includes("hl-strong") && hl2.includes("hl-code"));
  check("hl: syntax inside fence stays literal", hl2.includes("= '**not highlighted**';"));
  click($("editor-discard"));
  check("hl: discard does not pollute source", !window.eval("DOCS.guide.src").includes("标题高亮"));

  // 12) read-mode Ctrl+S prevented (no browser save dialog)
  resetToast();
  const evS = key(document.body, "s", { ctrlKey: true });
  check("ctrl+S read: prevented + hint toast", evS.defaultPrevented &&
    $("toast-msg").textContent.includes("阅读模式"), $("toast-msg").textContent);

  // 13) search jump from EDIT mode returns to reading and highlights for real
  const srcLenBefore = window.eval("DOCS.guide.src.length");
  click($("seg-edit"));
  key($("editor"), "f", { ctrlKey: true });
  $("search-input").value = "大纲";
  fire($("search-input"), "input");
  $("search-input").dispatchEvent(new window.KeyboardEvent("keydown",
    { key: "Enter", bubbles: true, cancelable: true }));
  check("edit+search: jumps back to read mode", $("editor-wrap").hidden &&
    document.querySelectorAll("#article mark.hit").length > 0 && !$("hitnav").hidden);
  check("edit+search: untouched edit exits without saving (no toast churn)",
    window.eval("DOCS.guide.src.length") === srcLenBefore);
  key(document.body, "Escape");

  // 14) search result grouping (§-headers; heading-hits become the group header row)
  key(document.body, "f", { ctrlKey: true });
  $("search-input").value = "大纲";
  fire($("search-input"), "input");
  const grp = document.querySelectorAll("#search-results .hgrp").length;
  const grpHit = document.querySelectorAll("#search-results .hgrp.hit").length;
  check("search: section-group headers rendered", grp >= 3, "grps=" + grp);
  check("search: heading hit shown as clickable group row", grpHit >= 1, "hits=" + grpHit);
  check("search: no 'N 处' chip for single-hit blocks",
    ![...document.querySelectorAll("#search-results .hit .hcount")].some(e => e.textContent === "1 处"));
  key(document.body, "Escape");

  // 15) bottom-of-doc section activates (last short section no longer stuck)
  const lastH = [...document.querySelectorAll("#article h1,#article h2,#article h3,#article h4,#article h5,#article h6")].pop();
  window.eval("scrollArea.scrollTop = scrollArea.scrollHeight - scrollArea.clientHeight; updateActive();");
  check("active: last section highlights at bottom",
    $("stat-sec-t").textContent === "§ " + lastH.textContent, "want §" + lastH.textContent + ", got " + $("stat-sec-t").textContent);

  // 16) task checkbox writes back to source
  click(document.querySelector('#lib-list .tf[data-doc="rust"]'));
  const cb0 = document.querySelector("#article .cbx");
  resetToast();
  click(cb0);
  check("task: click writes [x] into source",
    /\[x\] 读完/.test(window.eval("DOCS.rust.src")) && $("toast-msg").textContent.includes("任务清单"));
  click(document.querySelector("#article .cbx"));   // toggle back
  check("task: second click restores [ ]", /\[ \] 读完/.test(window.eval("DOCS.rust.src")));

  // 17) guide demo image + click-to-zoom
  click(document.querySelector('#lib-list .tf[data-doc="guide"]'));
  const im = document.querySelector("#article img");
  check("img: guide has demo image", !!im && (im.getAttribute("src") || "").startsWith("data:image/svg+xml,"));
  click(im);
  check("img: click opens lightbox", $("imgbox").classList.contains("open") &&
    $("imgbox-img").getAttribute("src").startsWith("data:image/svg+xml,"));
  key(document.body, "Escape");
  check("img: Esc closes lightbox", !$("imgbox").classList.contains("open"));

  // 18) menu keyboard navigation
  window.eval("menuBs[1].click()");   // 查看
  key(document.body, "ArrowDown");
  check("menu: ArrowDown marks first item",
    document.querySelector("#menubar b.open .mi.kb") === document.querySelectorAll("#menubar b.open .mi")[0]);
  key(document.body, "Enter");        // -> 专注模式
  check("menu: Enter activates item (focus mode on)", document.querySelector(".win").classList.contains("focus"));
  key(document.body, "Escape");
  check("menu: Esc exits focus mode", !document.querySelector(".win").classList.contains("focus"));
  check("menu: roles set", document.getElementById("menubar").getAttribute("role") === "menubar");

  // 19) library filter: path match + orphan header + empty tip
  $("lib-search").value = "notes";
  fire($("lib-search"), "input");
  const rustTf = document.querySelector('#lib-list .tf[data-doc="rust"]');
  const guideTf = document.querySelector('#lib-list .tf[data-doc="guide"]');
  const pinHeader = document.querySelectorAll("#lib-list .sec-h")[0];
  check("filter: matches path segment (notes → rust)", rustTf.style.display === "" && guideTf.style.display === "none");
  check("filter: orphan 置顶 header hidden", pinHeader.style.display === "none");
  $("lib-search").value = "zzz不存在zzz";
  fire($("lib-search"), "input");
  check("filter: empty-state hint appears", !!document.getElementById("lib-empty"));
  $("lib-search").value = "";
  fire($("lib-search"), "input");
  // renderLib() 每次都整表重绘，旧引用会脱离文档 → 断言前重新查询
  const guideBack = document.querySelector('#lib-list .tf[data-doc="guide"]');
  const pinBack = document.querySelectorAll("#lib-list .sec-h")[0];
  check("filter: restores all + header back", guideBack.style.display === "" && pinBack.style.display === "" &&
    !document.getElementById("lib-empty"));

  // 19b) 目录树契约（对齐真实 libtree 语义）：默认展开=库根+当前文档祖先链；
  //      点目录行收起/展开；˅ 全部展开 / ˄ 全部收起 整批写显式覆盖。
  const dirOf = k => [...document.querySelectorAll("#lib-list .tf.dir")].find(r => r.dataset.key === k);
  const tfOf = d => document.querySelector('#lib-list .tf[data-doc="' + d + '"]');
  check("tree: collapsed notes hides rust; revealed markdown shows arch",
    dirOf("E:\\docs\\notes").dataset.open === "0" && tfOf("rust").style.display === "none" &&
    dirOf("E:\\docs\\markdown").dataset.open === "1" && tfOf("arch").style.display === "");
  click(dirOf("E:\\docs\\notes"));
  check("tree: click dir expands its files",
    dirOf("E:\\docs\\notes").dataset.open === "1" && tfOf("rust").style.display === "");
  click(document.getElementById("lib-collapse"));
  check("tree: 全部收起 keeps dir rows, hides files (pinned unaffected)",
    tfOf("arch").style.display === "none" && tfOf("rust").style.display === "none" &&
    !!dirOf("E:\\docs\\markdown") && tfOf("guide").style.display === "");
  click(document.getElementById("lib-expand"));
  check("tree: 全部展开 shows every file",
    tfOf("arch").style.display === "" && tfOf("rust").style.display === "" && tfOf("meet").style.display === "");

  // 20) hash deep link
  window.eval("applyHashLink"); // fn exists
  check("hash: applyHashLink parses & jumps (via direct call)",
    window.eval("(function(){ history.replaceState(null,'',\"#doc=rust&sec=2. 借用与引用\"); return applyHashLink(); })()") === true &&
    window.eval("state.doc") === "rust");
  window.eval("renderDoc('guide');");

  // 21) contrast tokens updated
  check("contrast: light text-3 darkened", s_includes("--text-3:#5B6881"));
  check("contrast: dark text-3 lightened", s_includes("--text-3:#7A8AA8"));
  function s_includes(sub){
    return fs.readFileSync(htmlPath, "utf-8").includes(sub);
  }

  // 22) v2 regression: N1/N4/N5/N6/N7/N9/N11/N12/N13/N18/N20
  // N1: queued toast — second message must not overwrite a showing one
  const msgBefore = $("toast-msg").textContent;
  window.eval("toastQueue.length = 0;");
  key(document.body, "e", { ctrlKey: true });           // enter edit
  const edv = $("editor");
  edv.value = edv.value + "\n## v2队列ZZ";
  fire(edv, "input");
  click(document.querySelector('#lib-list .tf[data-doc="rust"]'));  // switch dirty: save toast + resume toast
  check("N1: auto-save notice survives (queued, not swallowed)",
    $("toast-msg").textContent.includes("已自动保存") ||
    window.eval("toastQueue.some(m => m.includes('已自动保存'))"),
    "showing=" + $("toast-msg").textContent + " queue=" + window.eval("JSON.stringify(toastQueue)"));

  // N4: scroll then switch doc within the 400ms debounce window → position must be persisted
  view_set(2100); fire($("scroll-area"), "scroll");
  click(document.querySelector('#lib-list .tf[data-doc="guide"]'));
  check("N4: pending position flushed on switch (no coin flip)",
    window.eval("store.get('folio-pos-map',{}).rust && store.get('folio-pos-map',{}).rust.ratio > 0.3"),
    JSON.stringify(window.eval("store.get('folio-pos-map',{}).rust")));
  window.eval("flushPosSave()");

  // N5: keyboard cursor resets when menu closes
  window.eval("menuBs[1].click(); kbMi = 2;");
  window.eval("closeMenus()");
  check("N5: closeMenus resets kbMi", window.eval("kbMi") === -1);
  key(document.body, "Escape");

  // N12: with menu open, Alt+Down must NOT move the menu cursor (only global section nav runs)
  window.eval("menuBs[1].click();");
  key(document.body, "ArrowDown", { altKey: true });
  check("N12: Alt combo ignored by menu cursor handler",
    window.eval("kbMi") === -1 &&
    document.querySelectorAll("#menubar b.open .mi.kb").length === 0);
  key(document.body, "Escape");

  // N3: code-fence fake tasks excluded from the checkbox coordinate space
  window.eval('DOCS.fencetest = {title:"f", file:"f.md", dir:"d", slug:"f", ' +
    'src:"- [ ] real task one\\n\\n```text\\n- [ ] fake in code\\n```\\n\\n- [ ] real task two\\n"}; renderDoc("fencetest");');
  const cbs = document.querySelectorAll("#article .cbx");
  check("N3: only real tasks render checkboxes", cbs.length === 2, "cbx=" + cbs.length);
  resetToast();
  click(cbs[0]);
  check("N3: first click toggles real task, not the fenced fake",
    /\[x\] real task one/.test(window.eval("DOCS.fencetest.src")) &&
    !/\[x\] fake in code/.test(window.eval("DOCS.fencetest.src")));
  click(document.querySelector("#article .cbx"));   // toggle back
  window.eval('delete DOCS.fencetest; renderDoc("guide");');

  // N6: Ctrl+Q intercepted; N7: Ctrl+S intercepted while typing in filter box
  resetToast();
  const evQ = key(document.body, "q", { ctrlKey: true });
  check("N6: Ctrl+Q prevented + hint", evQ.defaultPrevented && $("toast-msg").textContent.includes("Tauri"));
  $("lib-search").focus();
  const evS2 = key($("lib-search"), "s", { ctrlKey: true });
  check("N7: Ctrl+S in filter box prevented (no browser save dialog)", evS2.defaultPrevented);
  document.body.focus();

  // N9: last-doc semantics
  window.eval("openDoc('rust');");
  check("N9: folio-last-doc tracks actual last opened",
    window.eval("store.get('folio-last-doc', null)") === "rust");

  // N20: placeholder doc yields no deep link copy
  click(document.querySelector('#lib-list .tf[data-doc="arch"]'));
  resetToast();
  window.eval("copyDeepLink()");
  check("N20: demo entry refuses deep-link copy", $("toast-msg").textContent.includes("演示占位"));

  // N11: import persists with stable id + dedupe
  const impId = await window.eval(
    "importFile(new File(['# 导入测试\\n\\n正文'], 'v2-import.md'), 'v2-import.md')");
  const impId2 = await window.eval(
    "importFile(new File(['# 导入测试2\\n\\n正文'], 'v2-import.md'), 'v2-import.md')");
  check("N11: re-import reuses id + persists; import writes disk only (no tree row yet)",
    impId === impId2 && !!window.eval("store.get('folio-imports', {})")[impId] &&
    document.querySelectorAll('#lib-list .tf[data-doc="' + impId + '"]').length === 0);
  // 2026-11-16：拖放=外部磁盘变化模拟，⟳ 重新扫描才入库；重导入去重仍单条
  window.eval(`$("lib-rescan").dispatchEvent(new MouseEvent("click", { bubbles: true }));`);
  check("rescan: imports disk entry into tree, deduped single row",
    document.querySelectorAll('#lib-list .tf[data-doc="' + impId + '"]').length === 1);

  // N18: hashchange handled at runtime (production: folio:// activation while running)
  resetToast();
  window.eval("history.replaceState(null,'','#doc=rust&sec=4. 下一步'); window.dispatchEvent(new Event('hashchange'));");
  check("N18: runtime hashchange opens doc + notices", window.eval("state.doc") === "rust" &&
    $("toast-msg").textContent.includes("深度链接"));
  window.eval("history.replaceState(null,'','');");

  // N13: overflow menu built; wctl never hidden by breakpoints (static guard)
  check("N13: #menu-ovf exists with cloned items",
    !!$("menu-ovf") && $("menu-ovf").querySelectorAll(".mi").length >= 12);
  check("N13: no breakpoint hides .wctl anymore",
    !/max-width:\s*\d+px\)\{[^}]*\.wctl\{display:none/.test(fs.readFileSync(htmlPath, "utf-8")));

  // 22) 打开对话框（仿真磁盘 · 仿 Windows 版式）：双击进目录 → 双击/打开按钮开文件
  window.eval('openPicker("files")');
  window.eval('pkGoto(vfsFind(picker.tree, "E:\\\\docs\\\\markdown"))');
  check("pick: navigate to markdown lists library files",
    !!pkRow("E:\\docs\\markdown\\Folio 使用指南.md") && !!pkRow("E:\\docs\\markdown\\架构设计 v3.md"));
  resetToast();
  dbl(pkRow("E:\\docs\\markdown\\架构设计 v3.md"));
  check("pick: dblclick demo file opens it (in-lib → no off-lib toast)",
    !$("pick-overlay").classList.contains("open") && $("stat-file").textContent === "架构设计 v3.md" &&
    !$("toast-msg").textContent.includes("已记到「最近打开」"));
  window.eval('openPicker("files"); pkGoto(vfsFind(picker.tree, "E:\\\\books"))');
  resetToast();
  dbl(pkRow("E:\\books\\DDIA 精读笔记.md"));
  check("pick: file outside current library → plain 「已记到最近打开」 toast",
    $("stat-file").textContent === "DDIA 精读笔记.md" && $("toast-msg").textContent.includes("已记到「最近打开」"));
  // 搜索框过滤当前文件夹
  window.eval('openPicker("files"); pkGoto(vfsFind(picker.tree, "E:\\\\docs\\\\markdown"))');
  $("pk-q").value = "Tauri"; fire($("pk-q"), "input");
  check("pick: search box filters current folder",
    document.querySelectorAll("#pk-list .tf[data-k='file']").length === 1);
  window.eval('closePicker()');
  // 类型下拉：选中后回写按钮文案
  window.eval('openPicker("files")');
  click($("pk-fmt"));
  const fmtMd = [...document.querySelectorAll("#pk-fmtmenu .mi")].find(m => m.textContent.includes("Markdown (*.md)"));
  click(fmtMd);
  check("pick: type combo applies and reflects on button",
    $("pk-fmt-t").textContent.includes("Markdown (*.md)") && !$("pk-fmtmenu").classList.contains("open"));
  window.eval('closePicker()');

  // 23) 切换文档库：确认框在选完目录后才弹 · 新旧两路径同屏 · 取消零副作用
  resetToast();
  window.eval('openPicker("dir"); pkGoto(vfsFind(picker.tree, "E:\\\\books"))');
  check("pick(dir): folder name pre-filled · type combo HIDDEN in folder mode",
    $("pk-name").value === "E:\\books" && $("pk-fmt").hidden === true);
  click($("pk-ok"));
  check("switch: confirm opens AFTER picking, shows BOTH roots, picker closed",
    $("rootq-overlay").classList.contains("open") && !$("pick-overlay").classList.contains("open") &&
    $("rootq-body").textContent.includes("E:\\docs") && $("rootq-body").textContent.includes("E:\\books") &&
    $("rootq-title").textContent === "切换文件夹");
  key(document.body, "Escape");
  check("switch: Esc = cancel, zero side effects (still old root)",
    !$("rootq-overlay").classList.contains("open") && window.eval("LIB_ROOT") === "E:\\docs" &&
    window.eval("libraryOpen") === true && $("lib-count").textContent.includes("7"));   // 6 seeded + N11 import
  resetToast();
  window.eval('openPicker("dir"); pkGoto(vfsFind(picker.tree, "E:\\\\books"))');
  click($("pk-ok")); click($("rootq-ok"));
  check("switch: applied — tree/chip/count/toast follow new root (replace_root)",
    window.eval("LIB_ROOT") === "E:\\books" && $("lib-count").textContent.includes("3") &&
    $("lib-root-chip").textContent.includes("E:\\books") && $("toast-msg").textContent.includes("已切换到文件夹"));
  check("switch: old-lib docs leave tree, history badge 库 cleared",
    !document.querySelector('#lib-list .tf[data-doc="guide"]') &&
    ![...document.querySelectorAll('#history-list .tf[data-doc="guide"] .badge')].some(b => b.textContent === "库"));

  // 24) 关闭文档库：先弹影响确认；关闭后 chip 虚线占位 + 空态
  click($("lib-close"));
  check("close: confirmation first, plain-language notice (文件不删除 / 最近打开)",
    $("rootq-overlay").classList.contains("open") && $("rootq-title").textContent === "关闭文件夹" &&
    $("rootq-sub").textContent.includes("不会删除") &&
    $("rootq-body").textContent.includes("一篇也不会少") && $("rootq-body").textContent.includes("最近打开"));
  key(document.body, "Escape");
  check("close: Esc cancels (library still open)", window.eval("libraryOpen") === true);
  click($("lib-close")); click($("rootq-ok"));
  check("close: chip placeholder + empty panel + count 0",
    $("lib-root-chip").classList.contains("empty") && $("lib-list").textContent.includes("尚未打开文件夹") &&
    $("lib-count").textContent.includes("0") && $("lib-close").hidden);

  // 25) 重开库：无旧库不弹切换框（两路径才有比较价值）；同根恢复成员
  window.eval('openPicker("dir"); pkGoto(vfsFind(picker.tree, "E:\\\\docs"))');
  click($("pk-ok"));
  check("reopen: applies without switch-confirm; members + badges restored",
    !$("rootq-overlay").classList.contains("open") && window.eval("libraryOpen") === true &&
    $("lib-count").textContent.includes("7") &&
    [...document.querySelectorAll('#history-list .tf[data-doc="guide"] .badge')].some(b => b.textContent === "库"));
  check("reopen: same-root pick → notice, not confirm", (() => {
    window.eval('openPicker("dir"); pkGoto(vfsFind(picker.tree, "E:\\\\docs"))');
    resetToast(); click($("pk-ok"));
    return !$("rootq-overlay").classList.contains("open") && $("toast-msg").textContent.includes("已经是当前");
  })());

  // 26) 真实文件仍走拖放（原生 <input type=file> 已全部移除）
  check("native pickers removed; drag-drop path kept",
    !document.querySelector('input[type="file"]') && typeof window.eval("handleFiles") === "function" &&
    !!$("dropveil"));

  // 27) 查看→主题 子菜单（深色/浅色/米色）· rail 搜索钮撤除
  check("rail: search button retired, three panel buttons left",
    !document.getElementById("rail-search") && !!$("rail-lib") && !!$("rail-history") && !!$("rail-outline"));
  window.eval(`menuBs[1].click(); document.getElementById("mi-theme").classList.add("subopen");`);
  check("theme submenu: 3 options, dot on current only",
    document.querySelectorAll("#thsub .mi").length === 3 &&
    document.querySelector('#thsub [data-theme="dark"] .ck').style.visibility === "" &&
    document.querySelector('#thsub [data-theme="sepia"] .ck').style.visibility === "hidden");
  window.eval(`document.querySelector('#thsub [data-theme="sepia"]').click();`);
  check("menu→米色: applies + persists + dot follows; toggleTheme retired",
    document.body.dataset.theme === "sepia" && window.eval("state.prefs.theme") === "sepia" &&
    window.eval("typeof toggleTheme") === "undefined" &&
    document.querySelector('#thsub [data-theme="sepia"] .ck').style.visibility === "");
  window.eval(`document.querySelector('#thsub [data-theme="dark"]').click();`);
  check("menu→深色 restores", document.body.dataset.theme === "dark");

  // 28) rail 打开文件快捷钮 + 复制成功浮层（2026-11-16 优化项）
  check("rail: open-file shortcut exists", !!$("rail-open"));
  window.eval(`$("rail-open").click()`);
  check("rail: opens picker", $("pick-overlay").classList.contains("open"));
  window.eval(`closePicker()`);
  resetToast();
  window.eval(`showCopyPop("已复制深度链接", "folio://open?doc=guide")`);
  check("copypop: center card shown, no toast used",
    $("copypop").classList.contains("on") && $("copypop-l").textContent.includes("folio://open?doc=guide") &&
    !$("toast").classList.contains("show"));
  window.eval(`clearTimeout(copyPopTimer); $("copypop").classList.remove("on");`);

  // 29) 打开文件夹→自动切文档库；打开文件→自动切大纲
  window.eval(`switchSide("outline"); openPicker("dir"); pkGoto(vfsFind(picker.tree, "E:\\\\books")); pkConfirm();
    if(document.getElementById("rootq-overlay").classList.contains("open")) document.getElementById("rootq-ok").click();`);
  check("open folder: auto-switches to library panel",
    document.getElementById("side-library").style.display !== "none" && window.eval("LIB_ROOT") === "E:\\books");
  window.eval(`openPicker("files"); pkGoto(vfsFind(picker.tree, "E:\\\\books")); document.querySelector('#pk-list .tf[data-k="file"]').dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));`);
  check("open file: auto-switches to outline panel",
    document.getElementById("side-outline").style.display !== "none");
  // 恢复默认库 E:\docs，不影响后续
  window.eval(`openPicker("dir"); pkGoto(vfsFind(picker.tree, "E:\\\\docs")); pkConfirm(); if(document.getElementById("rootq-overlay").classList.contains("open")) document.getElementById("rootq-ok").click();`);

  // 30b) 新建文档=草稿；首次保存弹「保存」对话框确认名字与位置（经典流程，2026-11-16）
  const nBefore = window.eval("Object.keys(DOCS).length");
  window.eval(`menuAction("new-doc")`);
  const draftId = window.eval("state.doc");
  check("new-doc: untitled draft, edit mode, NOT in tree, no deep link",
    window.eval("Object.keys(DOCS).length") === nBefore + 1 && window.eval("state.mode") === "edit" &&
    window.eval("DOCS[state.doc].draft === true") &&
    !document.querySelector('#lib-list .tf[data-doc="' + draftId + '"]') &&
    $("stat-link").textContent === "—");
  resetToast();
  window.eval(`saveEdit()`);
  check("draft save: opens 保存 dialog — 保存(S) label, name prefilled, type combo hidden",
    $("pick-overlay").classList.contains("open") && $("pick-title").textContent === "保存文档" &&
    $("pk-ok").textContent === "保存(S)" && $("pk-name").value.includes("未命名文档") &&
    $("pk-fmt").hidden === true && $("pk-ok").disabled === false);
  window.eval(`pkGoto(vfsFind(picker.tree, "E:\\\\docs\\\\markdown")); $("pk-name").value = "冒烟新文档.md"; pkRender(); $("pk-ok").click();`);
  check("saved-as: name applied, listed in tree, toast shows path",
    window.eval("DOCS['" + draftId + "'].draft") === false &&
    $("tab-doc-name").textContent === "冒烟新文档.md" &&
    !!document.querySelector('#lib-list .tf[data-doc="' + draftId + '"]') &&
    $("toast-msg").textContent.includes("已保存为「冒烟新文档.md」") &&
    $("stat-link").textContent !== "—");

  // 30c) Ctrl+N 快捷键
  const nDraft = window.eval("Object.keys(DOCS).length");
  key(document.body, "n", { ctrlKey: true });
  check("ctrl+N: new draft doc opens in edit mode",
    window.eval("Object.keys(DOCS).length") === nDraft + 1 && window.eval("state.mode") === "edit" &&
    window.eval("DOCS[state.doc].draft === true"));
  window.eval("discardEdit()");

  // 30d) KEYMAP 一览含 Ctrl+N 行
  window.eval("openKeys()");
  check("keys modal lists Ctrl N", [...document.querySelectorAll("#keys-body .krow")].some(r => r.textContent.includes("Ctrl N")));
  window.eval("document.getElementById('keys-overlay').classList.remove('open');");

  // 31) end state
  check("final: no runtime errors", errors.length === 0, errors.join("; "));

}catch(e){ fail++; console.log("FAIL  exception: " + e.stack.split("\n").slice(0,4).join(" | ")); }

function view_set(v){ const s = $("scroll-area"); s.scrollTop = v; }
function view_get(){ return $("scroll-area").scrollTop; }

console.log("\n== " + pass + " passed, " + fail + " failed ==");
process.exit(fail ? 1 : 0);
}
run();
