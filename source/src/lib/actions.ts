/* 跨组件共享的动作（标题栏菜单、快捷键、按钮都调这里） */
import { api } from "./api";
import type { ImageRef } from "./api";
import type { Store } from "./store";
import * as ui from "./ui";
import { pdfExportName } from "./pdfname";

/** 选择统一入口：2026-11-17 起恢复 Windows 原生系统对话框（tauri-plugin-dialog），
 *  替代 2026-11-16 的应用内 PickDialog；文件模式多选，目录模式单选目录。
 *  浏览器回退层仍走遗留 input（浏览器自身行为，mock 也没有磁盘树）。 */
export async function pickPaths(mode: "files" | "dir"): Promise<string[] | null> {
  if (mode === "files") {
    if (api.isTauriRuntime()) { const ps = await api.pickFiles(); return ps.length ? ps : null; }
    const p = await api.pickFile(); return p ? [p] : null;
  }
  const d = await api.pickFolder(); return d ? [d] : null;
}

/** 文件→新建文档：创建内存草稿（应用数据目录 drafts/，不进库不进树），打开并直接进编辑。
 *  首次保存（store.save 的草稿拦截）才弹「保存」对话框确认文件名与目录；取消=不保存继续编辑。 */
export async function newDoc(s: Store) {
  try {
    const p = await api.newDocDraft();
    ui.markDraftPath(p);
    await s.openPath(p);
    s.setSide("outline");
    if (s.mode() !== "edit") s.toggleEdit();
    s.toast("已新建未命名文档，进入编辑 · 首次保存时确认文件名与位置");
  } catch (e) {
    s.toast("新建失败：" + String(e));
  }
}

export async function pickAndOpen(s: Store) {
  const ps = await pickPaths("files");
  if (!ps || !ps.length) return;
  let list = ps;
  let clipped = false;
  if (ps.length > 100) { list = ps.slice(0, 100); clipped = true; }   // FR-1.2 批量上限
  // 反序逐个走「打开」漏斗：其余登记 + 进历史，最后打开的第一个即当前展示
  for (const p of [...list].reverse()) {
    try { await s.openPath(p); } catch (e) { s.toast("打开失败：" + String(e)); }
  }
  s.setSide("outline");   // 2026-11-16：打开文件后自动切到大纲面板（与打开文件夹→文档库对称）
  if (clipped) s.toast("文件较多，本次仅打开前 100 个");
  if (list.length > 1) s.toast(`已打开 ${list.length} 篇文档`);
}

const leaf = (p: string) => p.split(/[\\/]/).pop() ?? p;
const sameDir = (a: string, b: string) =>
  a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** 「打开文件夹…」= 切换文档库（v4 单库策略：同时只允许一个库根）。
 *  顺序是"先选后确认"：选完目录才弹应用内询问框（新旧两路径同屏才有比较价值），
 *  取消/✕/点遮罩/Esc 都零副作用（旧库继续开着）。文案白话口径见 UI 规范 v1.1 §8.6。 */
export async function pickFolderAndScan(s: Store) {
  const ps = await pickPaths("dir");
  if (!ps || !ps.length) return;
  let dir = ps[0].replace(/[\\/]+$/, "") || ps[0];
  if (/^[A-Za-z]:$/.test(dir)) dir += "\\";   // 裸盘符必须带分隔符："D:" 是驱动器相对路径的毒源（v5 迁移的教训）
  const cur = s.roots()[0] ?? null;
  let n = 0;
  try { n = await api.mdCount(dir); } catch { /* 计数失败不拦确认 */ }
  if (cur && !sameDir(cur, dir)) {
    const cn = s.docs().filter((d) => d.inLibrary && !d.builtin).length;
    const ok = await ui.ask({
      icon: "i-folder-open", title: "切换文件夹", sub: "同一时间只打开一个文件夹",
      rows: [["现在的文件夹", `${cur}（${cn} 篇）`], ["要切换到的文件夹", `${dir}（里面有 ${n} 篇）`]],
      note: "切换后列表只显示新文件夹里的文档。原文件夹的文件不会被删除，进度也都保留，以后在「最近打开」里仍能找到；"
        + "重新选回原文件夹即可恢复。点「取消」什么都不会变。",
      ok: "切换文件夹",
    });
    if (!ok) return;
  }
  try {
    const r = await api.scanFolder(dir);
    s.saveSettings({ libraryRoot: dir });
    await s.refreshDocs();
    s.setSide("library");   // 2026-11-16：打开/切换文件夹后自动切到文档库面板，让结果立刻可见
    // PERF-01：截断口径真实化——truncated>0 时明说"还有多少没登记"，不再让 UI 宣称假数字
    const truncNote = r.truncated
      ? `：已登记前 ${r.total - r.truncated} 篇，还有 ${r.truncated} 篇未索引（可在设置调高扫描上限）`
      : "";
    if (r.prevRoot) {
      s.toast(`已切换到文件夹「${leaf(r.root)}」（${r.total} 篇${truncNote ? "，部分未索引" : ""}）；「${leaf(r.prevRoot)}」的 `
        + `${r.prevDemoted} 篇没有删除，可在「最近打开」里继续读`);
    } else if (cur && sameDir(cur, dir)) {
      s.toast(`重新扫描「${leaf(dir)}」：新增 ${r.inserted} · 更新 ${r.updated} · 未变 ${r.unchanged}`
        + ` · 移除 ${r.removed}` + (r.skipped ? ` · 读取失败跳过 ${r.skipped}` : "") + truncNote);
    } else {
      s.toast(`已打开文件夹「${leaf(dir)}」：共 ${r.total} 篇文档${truncNote}`);
    }
  } catch (e) {
    s.toast("扫描失败：" + ui.fmtErr(e));
  }
}

export async function quitApp(s: Store) {
  // UI-02 全链路：先同步等待阅读位置落盘（此前只在 beforeunload 里 void 异步刷，关窗时未必写完），
  // 再做脏检查。标题栏 ✕ / 菜单退出 / Alt+F4（经 Rust CloseRequested 广播）现在共用这一条路径。
  try { await s.flushPosition(); } catch { /* 位置写盘失败不拦退出 */ }
  if (s.dirty()) {
    // 应用内询问框（不再弹系统窗）；「取消」= 什么都不发生
    const ok = await confirmBox("有未保存的修改，确定退出吗？未保存内容将丢失。", "退出 Folio");
    if (!ok) return;
  }
  if (s.isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // destroy 而非 close：close 会再触发 CloseRequested → Rust 拦截 → 又广播事件 → 死循环；
    // destroy 不再走 CloseRequested，直接关窗（需要 capability core:window:allow-destroy）
    await getCurrentWindow().destroy();
  } else {
    s.toast("退出由 Tauri 接管（浏览器演示环境无法退出）");
  }
}

// toggleTheme（深/浅二态互斥钮）退役（2026-11-16）：主题三选走「查看→主题▸」子菜单与设置配色卡，
// 直接 s.saveSettings({ theme:"dark"|"light"|"sepia" })，两入口天然同步（App 的 theme effect）。

/** 「帮助 → Folio 使用指南」：打开内置 guide.md（Rust setup 解到应用数据目录并登记为 builtin）。
 *  先查登记表（builtin 优先，防同名用户文档抢占）；查不到走 slug 兜底（未命中由 openSlug 自带提示）。
 *  浏览器回退层的 demo/guide.md 同路径口径，一并命中。 */
export async function openGuide(s: Store) {
  const isGuide = (p: string) => /(^|[\\/])guide\.md$/i.test(p);
  const g = s.docs().find((d) => d.builtin && isGuide(d.path)) ?? s.docs().find((d) => isGuide(d.path));
  if (g) { await s.openPath(g.path); return; }
  await s.openSlug("guide");
}

export function copyDeepLink(s: Store) {
  const cur = s.current();
  if (!cur) { s.toast("未打开文档"); return; }
  // 显示与复制都用可读原文（§10.9 v1.1）：中文 slug/标题不 percent 编码——
  // 消费端 parse_folio 本就 percent-decode（不编码时解码是恒等），粘贴进浏览器由浏览器自动编码。
  const link = "folio://open?doc=" + cur.meta.slug;
  const sec = s.activeSec();
  const full = sec != null && cur.outline[sec - 1]
    ? link + "&sec=" + cur.outline[sec - 1].text
    : link;
  navigator.clipboard?.writeText(full)
    .then(() => ui.showCopied("已复制深度链接", full))   // 中央浮层 2s 自隐（不再贴状态栏弹 toast）
    .catch(() => s.toast("剪贴板不可用：" + full));
}

export function openSearchFromAnywhere() {
  ui.setSearchOpen(true);
}

/** 系统原生确认框退役（2026-11-16）：一律走应用内询问框（§8.6）。
 *  多行 msg 原文进说明盒（CSS 保留换行）。取消=false，零副作用。 */
export async function confirmBox(msg: string, title = "Folio"): Promise<boolean> {
  return ui.ask({ icon: "i-info", title, note: msg, ok: "确定" });
}

/** 在系统文件管理器中打开所在目录（FR-10.2） */
export async function revealInFolder(path: string, s: Store) {
  if (!api.isTauriRuntime()) { s.toast("浏览器演示环境无法调用资源管理器"); return; }
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch {
    s.toast("打开所在目录失败");
  }
}

/* 导出 PDF（FR-13.2）：把当前阅读视图按屏幕样式打成 PDF（A4，大纲 h1–h6 → PDF 书签，
 * 整页底色=阅读窗底色——页边距环带由 Rust 临时改 WebView2 衬底实现「边框随主题」）。
 * 守卫顺序即契约：无文档/在途提前退；编辑态先切回阅读；渲染稳定等待后再复检图表；
 * 正文=屏幕所见（含未保存草稿）；取消保存对话框=零副作用。版式在 app.css `@media print`。 */
export async function exportPdf(s: Store) {
  const cur = s.current();
  if (!cur) { s.toast("未打开文档，无可导出内容"); return; }
  if (ui.exportBusy()) { s.toast("上一次导出尚未完成"); return; }
  if (s.mode() === "edit") {
    s.toggleEdit();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  }
  if (!ui.getArticleHtml()) { s.toast("导出失败：正文尚未渲染"); return; }
  if (ui.articlePendingFigures()) { s.toast("图表仍在渲染，请稍候再试"); return; }
  ui.clearHits();
  let target: string | null = null;
  try { target = await api.pickSavePath(pdfExportName(cur.meta.fileName)); }
  catch (e) { s.toast("导出失败：" + ui.fmtErr(e)); return; }
  if (!target) return;                                        // 用户取消
  if (!/\.pdf$/i.test(target)) target += ".pdf";              // 对话框里删了后缀也兜住
  ui.setExportBusy(true);
  const prevTitle = document.title;
  try {
    await ui.waitArticleStable();                             // 长文档初排渐进：截在半途会缺后半正文
    if (ui.articlePendingFigures()) { s.toast("图表仍在渲染，请稍候再试"); return; }
    await ui.primeArticleImages();
    document.title = cur.meta.title;                          // PDF 书签根节点取 <title>——洗净文件名尾巴
    await api.exportPdf(target, ui.viewBgHex());              // 页边距衬底 = 阅读窗底色（边框随主题）
    ui.showCopied("已导出 PDF", target);                       // 中央浮层（铁律：不贴窗口底沿）
  } catch (e) {
    s.toast("导出失败：" + ui.fmtErr(e));
  } finally {
    document.title = prevTitle;
    ui.setExportBusy(false);
  }
}

/* 导出单文档为自包含 HTML（FR-13.1）。样式为独立精简集，与阅读视图观感一致但不含主题变量。 */
const EXPORT_CSS = `
body{margin:0;background:#FCFCFD;color:#18212F;font-family:Georgia,'Noto Serif SC','Segoe UI','Microsoft YaHei UI',serif}
article{max-width:820px;margin:0 auto;padding:40px 24px 80px;line-height:1.85;font-size:16px}
h1{font-size:30px;line-height:1.3;margin:6px 0}h2{font-size:22px;border-bottom:1px solid #C2CBDA;padding-bottom:8px;margin:34px 0 12px}
h3{font-size:17.5px;margin:26px 0 8px}h4,h5,h6{font-size:13px;margin:16px 0 6px;color:#46536A}
p{margin:0 0 15px}a{color:#0D9488}code{font-family:Consolas,monospace;font-size:.85em;background:#EDF3F2;color:#0B6156;border:1px solid #CFD7E3;border-radius:5px;padding:2px 6px}
pre{background:#0F1626;color:#E7EEF9;padding:14px 16px;border-radius:10px;overflow:auto;border:1px solid #CFD7E3}
pre code{background:none;border:none;color:inherit;padding:0}
blockquote{border-left:3px solid #0D9488;color:#46536A;margin:0 0 16px;padding:2px 0 2px 18px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #CFD7E3;padding:8px 12px;text-align:left}
th{background:#F2F4F8;font-weight:600}img{max-width:100%;height:auto;border-radius:8px;border:1px solid #CFD7E3;display:block;margin:8px auto}
p.imgrow{text-align:center}p.imgrow img{display:inline-block;margin:1px 2px;vertical-align:middle}p.imgrow>a{display:inline-block;vertical-align:middle}p.imgrow>a img{margin:0}
.f-block{text-align:center;margin:14px 0}.f-block svg{max-width:100%;height:auto}.f-block[data-mermaid]>svg,.f-block[data-math="block"] svg{display:block;margin:0 auto}.fb-box,.f-error{text-align:left}
ul li::marker{color:#EA580C}hr{border:none;height:1px;background:#CFD7E3;margin:28px 0}
.sub{display:none}`;

/* 导出单文档为 HTML（FR-13.1）。样式为独立精简集，与阅读视图观感一致但不含主题变量。
 * 图片随行（需求方 2026-11-17）：正文引用的全部图片实体化到 <HTML 同级>/images/——本地图按
 * 水合留痕（data-folio-local）从磁盘复制、远程图由 Rust 侧下载（webview CSP 拦前端 fetch），
 * src 重写为相对路径；Mermaid/MathJax 是内联 svg，本随正文导出。落盘失败的图保留原始 src
 * （远程=留链接，联网可看）。取消保存对话框=零副作用；守卫与 PDF 导出同口径。
 * 浏览器回退层没有磁盘目录概念：维持 blob 下载、图片留原链（mock 非产品行为）。 */
export async function exportHtml(s: Store) {
  const cur = s.current();
  if (!cur) { s.toast("未打开文档，无可导出内容"); return; }
  ui.clearHits();
  const body0 = ui.getArticleHtml();
  if (!body0) { s.toast("导出失败：正文尚未渲染"); return; }
  const wrap = (inner: string) =>
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>` +
    cur.meta.title.replace(/</g, "&lt;") + ` · Folio 导出</title><style>${EXPORT_CSS}</style></head>` +
    `<body><article>${inner}</article></body></html>`;
  const name = cur.meta.fileName.replace(/\.(md|markdown|txt)$/i, ".html");

  if (!api.isTauriRuntime()) {
    try {
      const r = await api.saveFileAs(name, wrap(ui.cleanExportHtml(body0)));
      if (!r) return;
      s.toast(r === "downloaded" ? "已导出 HTML（浏览器下载）" : "已导出 HTML：" + r);
    } catch (e) {
      s.toast("导出失败：" + String(e));
    }
    return;
  }

  if (ui.exportBusy()) { s.toast("上一次导出尚未完成"); return; }
  let target: string | null = null;
  try { target = await api.pickSavePath(name, "html"); }
  catch (e) { s.toast("导出失败：" + ui.fmtErr(e)); return; }
  if (!target) return;                                        // 用户取消
  if (!/\.html?$/i.test(target)) target += ".html";           // 对话框里删了后缀也兜住
  ui.setExportBusy(true);
  try {
    await ui.waitArticleStable();                             // 长文初排渐进：截在半途会缺后半正文/图表（与 PDF 同判据）
    const holder = document.createElement("div");
    holder.innerHTML = ui.getArticleHtml() || body0;
    const imgs = [...holder.querySelectorAll<HTMLImageElement>("img")];
    const refs: ImageRef[] = [];
    for (const img of imgs) {
      if (img.classList.contains("img-missing")) continue;    // 屏幕已裂的图不复制死文件
      if (img.dataset.folioLocal) refs.push({ source: img.dataset.folioLocal, kind: "file" });
      else if (/^https?:/i.test(img.getAttribute("src") || "")) refs.push({ source: img.getAttribute("src")!, kind: "url" });
    }
    const map = await api.exportImages(target, refs);
    let ok = 0, kept = 0;
    for (const img of imgs) {
      const src = img.getAttribute("src") || "";
      const local = img.dataset.folioLocal || "";
      delete img.dataset.folioLocal;                          // 导出文件里不留内部痕迹
      if (img.classList.contains("img-missing")) continue;
      const key = local || (/^https?:/i.test(src) ? src : "");
      if (!key) continue;                                     // data:/blob: 内联图原样随文
      const nm = map[key];
      if (nm) { img.setAttribute("src", "images/" + nm); ok++; }
      else kept++;                                            // 落盘失败→保留原始 src 兜底
    }
    await api.writeFile(target, wrap(ui.cleanExportHtml(holder.innerHTML)));
    const tail = refs.length ? `（图 ${ok} 张随行${kept ? `，${kept} 张保留原链` : ""}）` : "";
    ui.showCopied("已导出 HTML" + tail, target);               // 中央浮层（铁律：不贴窗口底沿）
  } catch (e) {
    s.toast("导出失败：" + ui.fmtErr(e));
  } finally {
    ui.setExportBusy(false);
  }
}
