/* 跨组件共享的动作（标题栏菜单、快捷键、按钮都调这里） */
import { api } from "./api";
import type { Store } from "./store";
import * as ui from "./ui";

/** 选择统一入口（§8.6）：Tauri = 应用内选择对话框（仿真原生通用对话框版式，真实盘，可多选）；
 *  浏览器回退层保留遗留 input（那是浏览器自身行为，不是 Windows 原生窗；mock 也没有磁盘树）。 */
export async function pickPaths(mode: "files" | "dir"): Promise<string[] | null> {
  if (!api.isTauriRuntime()) {
    if (mode === "files") { const p = await api.pickFile(); return p ? [p] : null; }
    const d = await api.pickFolder(); return d ? [d] : null;
  }
  return ui.pick(mode);
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
th{background:#F2F4F8;font-weight:600}img{max-width:100%;height:auto;border-radius:8px;border:1px solid #CFD7E3}
ul li::marker{color:#EA580C}hr{border:none;height:1px;background:#CFD7E3;margin:28px 0}
.sub{display:none}`;

export async function exportHtml(s: Store) {
  const cur = s.current();
  if (!cur) { s.toast("未打开文档，无可导出内容"); return; }
  ui.clearHits();
  const body = ui.getArticleHtml();
  if (!body) { s.toast("导出失败：正文尚未渲染"); return; }
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>` +
    cur.meta.title.replace(/</g, "&lt;") + ` · Folio 导出</title><style>${EXPORT_CSS}</style></head>` +
    `<body><article>${body}</article></body></html>`;
  const name = cur.meta.fileName.replace(/\.(md|markdown|txt)$/i, ".html");
  try {
    const r = await api.saveFileAs(name, html);
    if (!r) return;                                   // 用户取消
    s.toast(r === "downloaded" ? "已导出 HTML（浏览器下载）" : "已导出 HTML：" + r);
  } catch (e) {
    s.toast("导出失败：" + String(e));
  }
}
