/* API 层：Tauri 存在时全部 invoke；纯浏览器打开（vite dev / file://）自动回退到
 * localStorage + 内置示例，保证 UI 可在无 Rust 工具链的环境开发验证。
 * 回退层不是产品特性 —— 正式版一切以 Rust 为准。 */
import type {
  DirListing, DocFull, DocMeta, FormatOptions, FormatResult, OpenRequest, Position, RecentDoc,
  RecentReport, ScanReport, SearchHit, SearchQuery, Settings,
} from "./types";
import type { ApiError, Locale } from "./i18n/types.ts";
import { t, locale } from "./i18n/index.ts";
import { DEFAULT_SETTINGS } from "./defaults";
import { RANGE, clampNum } from "./typography";
import { flipTaskInSrc, headingsOfSrc } from "./md";
import { countWords } from "./wordcount";

/** 「此电脑」虚拟节点的路径哨兵（与 folio-fs::MY_PC 一致） */
export const MY_PC = "::my-pc";

/** 目录列举：应用内选择对话框的数据源（§8.6）。浏览器回退层没有磁盘树——
 * 该环境的选择走遗留的原生 input（浏览器自身行为，不是产品形态），这里只兜空。 */
async function apiListDir(path: string): Promise<DirListing> {
  if (isTauri) return invoke<DirListing>("list_dir", { path });
  return { parent: null, dirs: [], files: [] };
}
/** 确认框「里面有 M 篇」的递归计数（只统计，不登记） */
async function apiMdCount(path: string): Promise<number> {
  return isTauri ? invoke<number>("md_count", { path }) : 0;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWin = Record<string, any>;
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as AnyWin);

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function apiListDocs(): Promise<DocMeta[]> {
  return isTauri ? invoke("list_docs") : mock.listDocs();
}
async function apiOpenDoc(path: string): Promise<DocFull> {
  return isTauri ? invoke("open_doc", { path }) : mock.openPath(path);
}
async function apiOpenBySlug(slug: string): Promise<DocFull> {
  return isTauri ? invoke("open_by_slug", { slug }) : mock.openSlug(slug);
}
async function apiSaveDoc(path: string, content: string, force = false, encoding?: string): Promise<DocFull> {
  return isTauri ? invoke("save_doc", { path, content, force, encoding }) : mock.save(path, content);
}
/** 目录树「重命名」（rename_doc 命令）：磁盘改名 + 登记行 path/slug 更新，doc_id 不动。
 *  浏览器回退层只在 mock 清单里改 path/fileName（无磁盘概念），行为口径以 Rust 为准。 */
async function apiRenameDoc(path: string, newName: string): Promise<DocMeta> {
  return isTauri ? invoke("rename_doc", { path, newName }) : mock.renameDoc(path, newName);
}
/** 文件夹「重命名」（rename_dir 命令，增强 2026-11-20）：磁盘改名 + 子树文档路径/库根登记换前缀。
 *  返回新目录路径。mock 层同样按前缀搬运 docs + roots。 */
async function apiRenameDir(path: string, newName: string): Promise<string> {
  return isTauri ? invoke("rename_dir", { path, newName }) : mock.renameDir(path, newName);
}
/** 源码自动格式化（权威实现 crates/folio-core/src/format.rs）。
 *  浏览器回退层刻意不维护第二套规则：原样返回 + 警告，只保证 UI 流程可走。 */
async function apiFormatMarkdown(src: string, options: FormatOptions): Promise<FormatResult> {
  if (isTauri) return invoke<FormatResult>("format_markdown", { src, options });
  const st = statsOf(src);
  return {
    text: src,
    changed: false,
    changedLines: 0,
    outline: headingsOf(src),
    secCount: st.secCount,
    wordCount: st.wordCount,
    headCount: st.headCount,
    title: null,
    // P4b：warnings 统一携带稳定 warning code（unclosed_fence/unclosed_math/demo_noop），
    // 展示文案由 actions.ts 按 format.warn.<code> 查目录（对照表 Rust #14/#15 同口径）
    warnings: ["demo_noop"],
  };
}
async function apiSetPinned(id: number, on: boolean): Promise<void> {
  if (isTauri) await invoke("set_pinned", { id, on });
  else mock.setPinned(id, on);
}
/** schema v3：库成员开关（右键「从库移除」）。登记保留，出库时取消置顶；不动磁盘文件。 */
async function apiSetInLibrary(id: number, on: boolean): Promise<void> {
  if (isTauri) await invoke("set_in_library", { id, on });
  else mock.setInLibrary(id, on);
}
/** schema v3：打开历史（时间倒序，不限量）。与库成员互不隶属。 */
async function apiListRecents(): Promise<RecentDoc[]> {
  return isTauri ? invoke("list_recents") : mock.listRecents();
}
/** 从历史移除一条；返回 true = 该文档既不在库也非内置，登记行已连带回收 */
async function apiRemoveRecent(id: number): Promise<boolean> {
  return isTauri ? invoke("remove_recent", { id }) : mock.removeRecent(id);
}
/** 清空打开历史：只删历史 + 失去归属的登记；库成员/内置文档的进度不受影响 */
async function apiClearRecents(): Promise<RecentReport> {
  return isTauri ? invoke("clear_recents") : mock.clearRecents();
}
async function apiListRoots(): Promise<string[]> {
  return isTauri ? invoke("list_roots") : mock.listRoots();
}
/** 移除库根；只被该根覆盖的库成员一并出库，返回出库条数 */
async function apiRemoveRoot(path: string): Promise<number> {
  return isTauri ? invoke("remove_root", { path }) : mock.removeRoot(path);
}
/** 另存为并写出（导出 HTML，FR-13.1）。返回目标路径或 "downloaded"（浏览器）或 null（取消） */
async function apiResolveImage(docPath: string, url: string): Promise<string | null> {
  if (!isTauri) return null;
  return invoke("resolve_image", { docPath, url });
}
/** asset URL 备忘录（性能 P2-7）：路径 → URL 是纯字符串变换，同一文件进程内只算一次 */
const assetUrlCache = new Map<string, string>();
async function getConvert(): Promise<(p: string) => string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return (p: string) => {
    let u = assetUrlCache.get(p);
    if (!u) { u = convertFileSrc(p); assetUrlCache.set(p, u); }
    return u;
  };
}
/** 磁盘路径 → asset: 协议 URL（浏览器环境原样返回） */
async function toAssetSrc(localPath: string): Promise<string> {
  if (!isTauri) return localPath;
  return (await getConvert())(localPath);
}
/** 批量解析本地图片 URL（性能 P1-7 + P2-3）：单 IPC 返回 (绝对路径,宽,高)｜null，宽 0 = 尺寸未知 */
async function apiResolveImages(
  docPath: string, urls: string[],
): Promise<(readonly [string, number, number] | null)[]> {
  if (!isTauri || !urls.length) return urls.map(() => null);
  return invoke<(readonly [string, number, number] | null)[]>("resolve_images", { docPath, urls });
}
/** 批量磁盘路径 → asset URL：convertFileSrc 为本地纯计算（带缓存），不产生 IPC */
async function toAssetSrcs(localPaths: (string | null)[]): Promise<(string | null)[]> {
  if (!isTauri) return localPaths;
  const convert = await getConvert();
  return localPaths.map((p) => (p ? convert(p) : null));
}

async function saveFileAs(defaultName: string, content: string): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!path) return null;
    await invoke("write_file", { path, content });
    return path;
  }
  const url = URL.createObjectURL(new Blob([content], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url; a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return "downloaded";
}
/* 导出 PDF（FR-13.2）。保存路径用系统 save 对话框——与设置导出/HTML 导出同口径
 * （去原生化轮明确保留的「系统集成例外」场景）；浏览器回退层没有磁盘路径概念，给假路径。 */
async function apiPickSavePath(defaultName: string, kind: "pdf" | "html" = "pdf"): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: defaultName,
      filters: kind === "pdf" ? [{ name: "PDF", extensions: ["pdf"] }] : [{ name: "HTML", extensions: ["html"] }],
    });
    return typeof path === "string" ? path : null;
  }
  return "browser://" + defaultName;
}

/* FR-13.1 图片随行：导出 HTML 时把正文引用的一切图片实体化到 <HTML 同级>/images/。
 * file=本地磁盘绝对路径（hydrate 留痕 data-folio-local），url=http(s) 直连下载（绕开
 * webview CSP——connect-src 只放行 IPC，前端 fetch 远程图必被拦；下载在 Rust reqwest 侧）。
 * name=null 表示该图落盘失败（前端保留原始 src 兜底展示）。浏览器回退层无磁盘目录概念，返回空表。 */
export interface ImageRef { source: string; kind: "file" | "url" }
async function apiExportImages(htmlPath: string, items: ImageRef[]):
  Promise<Record<string, string | null>> {
  if (!isTauri || !items.length) return {};
  const rows = await invoke<{ source: string; name: string | null }[]>("export_images", { htmlPath, items });
  return Object.fromEntries(rows.map((r) => [r.source, r.name]));
}
/** 当前阅读视图 → PDF（含书签）。正式行为在 Rust：WebView2 进程内 CDP `Page.printToPDF`
 *  （generateDocumentOutline）；`bgColor`=#RRGGBB=阅读窗底色——导出期间临时成为 WebView2 页面
 *  衬底（页边距环带只认衬底，CSS 管不到，2026-11-17 二分实测）。浏览器回退层用 window.print() 近似。 */
async function apiExportPdf(path: string, bgColor: string): Promise<void> {
  if (isTauri) { await invoke("export_pdf", { path, bgColor }); return; }
  window.print();
}

async function apiToggleTask(path: string, nth: number): Promise<DocFull> {
  /* 已退役自 UI 调用（2026-11-18 手动保存定夺）：Reader 打勾改为 flipTaskInSrc 内存翻转 + 显式「保存」落盘。
   * Rust 命令 toggle_task 与 folio-core 权威实现、api 层与 mock 均保留——flipTaskInSrc 的镜像测试以此函数为参照。 */
  return isTauri ? invoke("toggle_task", { path, nth }) : mock.toggleTask(path, nth);
}
async function apiScanFolder(root: string): Promise<ScanReport> {
  return isTauri ? invoke("scan_folder", { root }) : mock.scan(root);
}
async function apiSearch(query: SearchQuery): Promise<SearchHit[]> {
  return isTauri ? invoke("search", { query }) : mock.search(query);
}
async function apiSavePosition(docId: number, position: Position): Promise<void> {
  if (isTauri) await invoke("save_position", { docId, position });
  else mock.savePosition(docId, position);
}
async function apiGetPositions(): Promise<[number, Position][]> {
  return isTauri ? invoke("get_positions") : mock.positions();
}
async function apiGetSettings(): Promise<Settings> {
  return isTauri ? invoke("get_settings") : mock.settings();
}
async function apiSetSettings(settings: Settings): Promise<void> {
  if (isTauri) await invoke("set_settings", { settings });
  else mock.setSettings(settings);
}
/* 内置文档（welcome/guide）语言同步（i18n P5，设计 §4.10）：前端在设置加载解析出 UI locale 后
 * 与语言切换时调用。会话级 lastSent 防多入口重复 IPC；Rust 侧本身幂等（未修改才替换）。
 * 浏览器回退层为空操作——docs() 已按 locale 对调演示副本，不承诺落盘。 */
let lastBuiltinSync: Locale | null = null;
async function apiSyncBuiltinDocs(loc: Locale, force = false): Promise<number> {
  if (!force && lastBuiltinSync === loc) return 0;
  lastBuiltinSync = loc;
  if (!isTauri) { mock.docs(); return 0; }   // 浏览器回退：docs() 已按 locale 对调演示副本，无登记表可刷
  try { return await invoke<number>("sync_builtin_docs", { locale: loc }); }
  catch (e) { lastBuiltinSync = null; throw e; }   // 失败复位，允许语言切换或下次启动重试
}
/* 导入/导出配置：把整份 Settings 序列化为 settings.json 落盘 / 从盘读回。
 * 导出用 save 对话框定路径 + write_file；导入用 open 对话框定路径 + read_file。
 * 浏览器回退层用 blob 下载 / <input type=file>，与 Tauri 同语义（不是产品特性，仅便于无 Rust 环境验证 UI）。 */
async function apiExportSettings(settings: Settings): Promise<string | null> {
  const content = JSON.stringify({ _folioSettingsExport: 1, ...settings }, null, 2);
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: "folio-settings.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return null;
    await invoke("write_file", { path, content });
    return path;
  }
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = "folio-settings.json";
  a.click();
  URL.revokeObjectURL(url);
  return "folio-settings.json";
}
/* 导入配置三态化（UI-12）：取消 / 无效文件 / 成功 不再共用一个提示。 */
export type ImportResult =
  | { kind: "ok"; settings: Settings }
  | { kind: "cancel" }
  | { kind: "invalid"; why: string };

/* CON-06：导入的 JSON 是外部输入，必须过校验才能进 Settings——
 * 枚举白名单、数值按 RANGE 夹紧、布尔强类型、未知字段忽略、scanLimit 限定整数区间。
 * 此前 `{...DEFAULT_SETTINGS, ...obj}` 直接展开：theme 乱值会让令牌全缺、
 * accent 可注入任意 CSS 片段、align:"center" 破坏排版、scanLimit:0 把整库扫成 0 篇。 */
function sanitizeSettings(raw: unknown): Settings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const D = DEFAULT_SETTINGS;
  const num = (v: unknown, key: keyof typeof RANGE, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? clampNum(key, v) : fallback;
  const en = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  const posInt = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(Math.floor(v), 1_000_000)) : null;
  return {
    theme: en(o.theme, ["dark", "light", "sepia"] as const, D.theme),
    accent: typeof o.accent === "string" && (o.accent === "" || /^#[0-9a-fA-F]{6}$/.test(o.accent)) ? o.accent : D.accent,
    serif: typeof o.serif === "boolean" ? o.serif : D.serif,
    fsSerif: num(o.fsSerif, "fsSerif", D.fsSerif),
    fsSans: num(o.fsSans, "fsSans", D.fsSans),
    width: num(o.width, "width", D.width),
    lh: num(o.lh, "lh", D.lh),
    libraryRoot: typeof o.libraryRoot === "string" ? o.libraryRoot : null,
    scanLimit: posInt(o.scanLimit),
    sideWidth: typeof o.sideWidth === "number" && Number.isFinite(o.sideWidth)
      ? Math.round(clampNum("sideWidth", o.sideWidth)) : null,
    letterSpacing: num(o.letterSpacing, "letterSpacing", D.letterSpacing),
    paraSpacing: num(o.paraSpacing, "paraSpacing", D.paraSpacing),
    align: en(o.align, ["left", "justify"] as const, D.align),
    codeFs: num(o.codeFs, "codeFs", D.codeFs),
    tableDensity: en(o.tableDensity, ["compact", "standard", "loose"] as const, D.tableDensity),
    restoreOnLaunch: typeof o.restoreOnLaunch === "boolean" ? o.restoreOnLaunch : D.restoreOnLaunch,
    softBreakBr: typeof o.softBreakBr === "boolean" ? o.softBreakBr : D.softBreakBr,
    language: en(o.language, ["auto", "zh-CN", "en-US"] as const, D.language),
  };
}

async function apiImportSettings(): Promise<ImportResult> {
  let text: string | null = null;
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return { kind: "cancel" };
    try { text = await invoke<string>("read_file", { path }); }
    catch (e) { return { kind: "invalid", why: t("api.readFailed") + String(e) }; }
  } else {
    text = await new Promise<string | null>((res) => {
      const el = document.createElement("input");
      el.type = "file"; el.accept = ".json,application/json";
      el.onchange = () => { const f = el.files?.[0]; if (!f) return res(null); f.text().then((t) => res(t), () => res(null)); };
      el.oncancel = () => res(null);
      el.click();
    });
    if (text == null) return { kind: "cancel" };
  }
  try {
    const settings = sanitizeSettings(JSON.parse(text));
    if (!settings) return { kind: "invalid", why: t("api.importNotObject") };
    return { kind: "ok", settings };
  } catch {
    return { kind: "invalid", why: t("api.importBadFile") };
  }
}
async function apiDrainPending(): Promise<string[]> {
  return isTauri ? invoke("drain_pending") : [];
}
function onOpenRequest(cb: (req: OpenRequest) => void): () => void {
  if (!isTauri) return () => undefined;
  let disposed = false;
  import("@tauri-apps/api/event").then(({ listen }) => {
    if (disposed) return;
    listen<OpenRequest>("folio-open", (e) => cb(e.payload)).then((un) => {
      if (disposed) un();
    });
  });
  return () => {
    disposed = true;
  };
}
async function apiPickFile(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    return typeof r === "string" ? r : null;
  }
  return new Promise((res) => {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = ".md,.markdown,.txt";
    el.onchange = () => {
      const f = el.files?.[0];
      if (!f) return res(null);
      const id = "browser://" + f.name;
      f.text().then((t) => mock.put(id, f.name, t));
      res(id);
    };
    el.click();
  });
}
/* 打开文件（原生多选窗）。2026-11-17 起恢复 Windows 原生系统对话框，替代应用内 PickDialog。 */
async function apiPickFiles(): Promise<string[]> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({
      multiple: true,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    return Array.isArray(r) ? r : typeof r === "string" ? [r] : [];
  }
  return new Promise((res) => {
    const el = document.createElement("input");
    el.type = "file";
    el.multiple = true;
    el.accept = ".md,.markdown,.txt";
    el.onchange = async () => {
      const fs = Array.from(el.files ?? []);
      if (!fs.length) return res([]);
      const ids: string[] = [];
      for (const f of fs) {
        const id = "browser://" + f.name;
        mock.put(id, f.name, await f.text());
        ids.push(id);
      }
      res(ids);
    };
    el.click();
  });
}

/** 新建文档首次保存的原生「另存为」窗；同名覆盖确认由系统对话框自身承担。 */
async function apiPickSaveDoc(defaultName: string, dir: string | null): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: (dir ? dir.replace(/[\\/]+$/, "") + "\\" : "") + defaultName,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    return typeof path === "string" ? path : null;
  }
  return "browser://" + defaultName;
}

async function apiPickFolder(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true });
    return typeof r === "string" ? r : null;
  }
  return "browser://library";
}

/** 新建文档草稿：写入应用数据目录 drafts/（不进库、不进树），返回可打开路径 */
export interface DbInfo {
  path: string;
  size: number;
  docs: number;
}

/** 本地数据库文件信息（设置页清空确认框，2026-11-25 需求）：完整路径 + 占用字节数 */
async function apiDbInfo(): Promise<DbInfo> {
  if (isTauri) return invoke<DbInfo>("db_info");
  let n = 0;
  let docs = 0;
  try {
    const keys = ["folio:localePref", "folio:localeResolved"];
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(LS_KEY) || keys.includes(k)) n += (localStorage.getItem(k)?.length ?? 0) * 2;
    }
    docs = (JSON.parse(localStorage.getItem(LS_KEY) || "[]") as unknown[]).length;
  } catch { /* 隐私模式：按 0 计 */ }
  return { path: "localStorage://folio-browser-mock", size: n, docs };
}

/** 清空本地数据库（设置页入口，设计无先例、需求 2026-11-24）：
 *  Tauri 侧删 SQLite 内的索引/历史/进度/库根/设置与 FTS，不动磁盘文件；浏览器 mock 清演示数据。 */
async function apiResetDatabase(): Promise<number> {
  if (isTauri) return invoke<number>("reset_database");
  let n = 0;
  try {
    const docs = JSON.parse(localStorage.getItem(LS_KEY) || "[]") as unknown[];
    n = docs.length;
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(LS_KEY) || k === "folio:localePref" || k === "folio:localeResolved") localStorage.removeItem(k);
    }
  } catch { /* 隐私模式：忽略 */ }
  return n;
}

async function apiNewDocDraft(): Promise<string> {
  // 默认名与正文标题按当前 UI 语言生成（设计 §4.6.7；写入后不回改）
  const base = t("file.untitled");
  if (isTauri) return invoke<string>("new_doc_draft", { base });
  let i = 0, name = `${base}.md`;
  while (mock.docs().some((d) => d.fileName === name)) { i++; name = `${base} ${i}.md`; }
  mock.put("browser://drafts/" + name, name, `# ${base}\n\n`);
  return "browser://drafts/" + name;
}
/** 清理草稿临时文件（后端校验必须在 appdata/drafts 下；浏览器回退层顺手移出 mock） */
async function apiDeleteScratch(path: string): Promise<void> {
  if (isTauri) { await invoke("delete_scratch", { path }); return; }
  mock.persist(mock.docs().filter((d) => d.path !== path));
}
/** 通用写文本（保存对话框确认后落盘；FR-13.1 同款 write_file）。
 *  encoding 缺省 utf-8；另存为 GBK 文档时必须回传来源编码，否则新文件被静默转码毁掉原码页。 */
async function apiWriteFile(path: string, content: string, encoding?: string): Promise<void> {
  if (isTauri) { await invoke("write_file", { path, content, encoding }); return; }
  mock.put(path, path.split(/[\\/]/).pop() || path, content);
}

/* ── 浏览器 mock ── */
/* i18n P5：内置演示文档中英双份（与 Rust 模板同源），mock 按当前 locale 选择。
 * rust-notes 是纯 mock 演示文档（正式版不内置），英文版只写在这里，不落 assets。 */
import welcomeZhMd from "../assets/welcome.zh-CN.md?raw";
import welcomeEnMd from "../assets/welcome.en-US.md?raw";
import guideZhMd from "../assets/guide.zh-CN.md?raw";
import guideEnMd from "../assets/guide.en-US.md?raw";
import rustMd from "../assets/rust-notes.md?raw";

/* mock 演示文件名（check-i18n 允许集：api mock 草稿名/正文）——只留这一处字面量，其余引用常量 */
const RUST_MOCK_NAME_ZH = "Rust 学习笔记.md";
const rustMockName = (en: boolean) => (en ? "Rust Notes.md" : RUST_MOCK_NAME_ZH);

const rustEnMd = `# Rust Notes

Staged notes on ownership and lifetimes.

## 1. Ownership

1. Every value in Rust has an owner
2. Only one owner at a time
3. When the owner goes out of scope, the value is dropped

\`\`\`rust
fn main() {
    let s = String::from("hello");
    takes_ownership(s);
}
\`\`\`

## 2. Borrowing and References

- \`&T\` immutable reference; many can coexist
- \`&mut T\` mutable reference; only one at a time

## 3. Next Steps

- [ ] Read chapter 4 of *The Rust Programming Language*
- [x] Wrap a connection pool around rusqlite
- [ ] Understand workspace feature unification
`;

interface MockDoc {
  id: number;
  path: string;
  fileName: string;
  src: string;
  mtime: number;
  pinned?: boolean;
  /** 显式归属（右键改过才写）；未定义时按库根推导，见 mockMembership */
  inLibrary?: boolean;
}
const LS_KEY = "folio-browser-mock";

/* CON-07：mock 与正式版共用同一判定函数（第二档起 = md.ts 的 nextKind 状态机 + Setext，
 * headingsOfSrc 是 Rust headings() 的整体镜像），杜绝「演示环境大纲与 Rust 不一致」。 */
function headingsOf(src: string) {
  return headingsOfSrc(src);
}

function statsOf(src: string) {
  const hs = headingsOf(src);
  return {
    wordCount: countWords(src), // 正文口径：公式/图表块不计（2026-11-17 需求定夺，Rust stats 同规则）
    headCount: hs.length,
    secCount: hs.filter((h) => h.level >= 2).length,
  };
}

function toFull(d: MockDoc): DocFull {
  return {
    meta: {
      id: d.id,
      path: d.path,
      slug: d.fileName.replace(/\.(md|markdown|txt)$/i, ""),
      title: (d.src.match(/^#\s+(.+)$/m)?.[1] ?? d.fileName).trim(),
      dir: d.path.includes("/") ? d.path.slice(0, d.path.lastIndexOf("/")) : "",
      fileName: d.fileName,
      size: d.src.length,
      mtime: d.mtime,
      inLibrary: mockMembership(d),
      pinned: d.pinned === true,
      builtin: false,
      ...statsOf(d.src),
    },
    src: d.src,
    outline: headingsOf(d.src),
    encoding: "utf-8",   // 浏览器回退层无编码检测：一律 utf-8
  };
}

/* ── 浏览器回退层的「库成员 / 打开历史」推导：对齐 folio-db v3 语义，不是产品实现 ── */
const LS_RECENTS = LS_KEY + ":recents";
const LS_ROOTS = LS_KEY + ":roots";
const nowSecs = () => Math.floor(Date.now() / 1000);

function recentsMap(): Record<number, number> {
  try { return JSON.parse(localStorage.getItem(LS_RECENTS) || "{}"); } catch { return {}; }
}
function persistRecents(m: Record<number, number>) {
  try { localStorage.setItem(LS_RECENTS, JSON.stringify(m)); } catch { /* 配额满：历史不落盘 */ }
}

/** 目录归属判定：与 folio-db::schema::path_under 同口径（小写 + 统一分隔符 + 分隔符边界） */
function underRoot(file: string, dir: string): boolean {
  const f = file.toLowerCase().replace(/\\/g, "/");
  const d = dir.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  return d !== "" && f.startsWith(d) && f.charAt(d.length) === "/";
}

/** 库成员推导优先级：用户显式改过 > 位于任一已登记库根下 > 演示条目
 * （demo/ 下的内置演示文档视作「一次目录扫描的产物」，否则浏览器模式的库面板永远空着） */
function mockMembership(d: MockDoc): boolean {
  if (d.inLibrary !== undefined) return d.inLibrary;
  try {
    const roots: string[] = JSON.parse(localStorage.getItem(LS_ROOTS) || "[]");
    if (roots.some((r) => underRoot(d.path, r))) return true;
  } catch { /* 无根 */ }
  return d.path.startsWith("demo/");
}

/* 浏览器演示副本随 UI 语言切换：与 Rust sync_builtin_docs 同口径——存的 src 逐字等于
 * 任一模板（用户没改过）才对调，改过的不覆盖。返回是否有变更（调用方决定回写 localStorage）。 */
function swapBuiltinMockDocs(docs: MockDoc[]): boolean {
  const en = locale() === "en-US";
  let changed = false;
  for (const d of docs) {
    const pair =
      d.path.endsWith("welcome.md") ? [welcomeZhMd, welcomeEnMd] as const :
      d.path.endsWith("guide.md") ? [guideZhMd, guideEnMd] as const :
      d.path.endsWith("rust-notes.md") ? [rustMd, rustEnMd] as const : null;
    if (!pair) continue;
    const target = en ? pair[1] : pair[0];
    if (d.src !== target && (d.src === pair[0] || d.src === pair[1])) {
      d.src = target;
      if (d.path.endsWith("rust-notes.md")) d.fileName = rustMockName(en);
      changed = true;
    }
  }
  return changed;
}

const mock = {
  docs(): MockDoc[] {
    let docs: MockDoc[];
    try {
      docs = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    } catch {
      docs = [];
    }
    const en = locale() === "en-US";
    if (!docs.some((d) => d.path.endsWith("welcome.md"))) {
      docs.unshift({ id: 3, path: "demo/welcome.md", fileName: "welcome.md", src: en ? welcomeEnMd : welcomeZhMd, mtime: Date.now() / 1000 - 60 });
    }
    if (!docs.some((d) => d.path.endsWith("guide.md"))) {
      docs.unshift({ id: 1, path: "demo/guide.md", fileName: "guide.md", src: en ? guideEnMd : guideZhMd, mtime: Date.now() / 1000 });
    }
    if (!docs.some((d) => d.path.endsWith("rust-notes.md"))) {
      docs.push({ id: 2, path: "demo/rust-notes.md", fileName: rustMockName(en), src: en ? rustEnMd : rustMd, mtime: Date.now() / 1000 - 86400 });
    }
    if (swapBuiltinMockDocs(docs)) this.persist(docs);   // 语言切换后的未修改副本对调（仅演示层）
    return docs;
  },
  persist(docs: MockDoc[]) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(docs));
    } catch {
      /* 配额满：浏览器回退层不承诺持久化 */
    }
  },
  async listDocs(): Promise<DocMeta[]> {
    return this.docs().map(toFull).map((f) => f.meta).sort((a, b) => b.mtime - a.mtime);
  },
  async openPath(p: string): Promise<DocFull> {
    const d = this.docs().find((x) => x.path === p);
    if (!d) throw new Error("not found: " + p);
    this.recordRecent(d.id); // 打开=记历史（Rust 侧在 doc_full 这个唯一漏斗里做同样的事）
    return toFull(d);
  },
  async openSlug(s: string): Promise<DocFull> {
    const d = this.docs().find((x) => x.fileName.replace(/\.(md|markdown|txt)$/i, "") === s);
    if (!d) throw new Error("not found: " + s);
    this.recordRecent(d.id);
    return toFull(d);
  },
  async save(p: string, content: string): Promise<DocFull> {
    const docs = this.docs();
    const d = docs.find((x) => x.path === p);
    if (!d) throw new Error("not found: " + p);
    d.src = content;
    d.mtime = Date.now() / 1000;
    this.persist(docs);
    return toFull(d);
  },
  /** 重命名的浏览器回退层：同目录查重 + 改 path/fileName（无磁盘、无 slug 表，toFull 现算）。 */
  async renameDoc(p: string, newName: string): Promise<DocMeta> {
    const { validateFileName } = await import("./filename");
    const bad = validateFileName(newName);
    // P4a：mock 与 Rust 同构——拒绝时抛 {code, reason}，由 fmtErr/目录呈现（reason 见 filename.ts FileReason）
    if (bad) throw { code: "invalid", reason: bad, detail: "mock validate rejected" } satisfies ApiError;
    const docs = this.docs();
    const d = docs.find((x) => x.path.toLowerCase() === p.toLowerCase());
    if (!d) throw new Error("file not found: " + p);
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    const nextPath = (dir ? dir + "/" : "") + newName.trim();
    if (nextPath.toLowerCase() === d.path.toLowerCase() && nextPath === d.path) return toFull(d).meta;
    if (docs.some((x) => x.path.toLowerCase() === nextPath.toLowerCase())) {
      throw { code: "invalid", reason: "EXISTS", detail: "mock: duplicate path" } satisfies ApiError;
    }
    d.path = nextPath;
    d.fileName = newName.trim();
    this.persist(docs);
    return toFull(d).meta;
  },
  /** 文件夹重命名的浏览器回退层：docs/roots 按前缀搬运（大小写不敏感），行为口径以 Rust rename_dir 为准。 */
  async renameDir(p: string, newName: string): Promise<string> {
    const { validateDirName } = await import("./filename");
    const bad = validateDirName(newName);
    // P4a：mock 与 Rust 同构——拒绝时抛 {code, reason}，由 fmtErr/目录呈现（reason 见 filename.ts FileReason）
    if (bad) throw { code: "invalid", reason: bad, detail: "mock validate rejected" } satisfies ApiError;
    const oldDir = p.replace(/[\\/]+$/, "");
    const cut = Math.max(oldDir.lastIndexOf("\\"), oldDir.lastIndexOf("/"));
    if (cut <= 0) throw { code: "invalid", reason: "NO_DIR", detail: "mock: no parent dir" } satisfies ApiError;
    const newDir = oldDir.slice(0, cut + 1) + newName.trim();
    const swap = (s: string): string | null => {
      const sl = s.toLowerCase(), od = oldDir.toLowerCase();
      if (sl === od) return newDir + s.slice(od.length);
      if (sl.startsWith(od) && (s[od.length] === "/" || s[od.length] === "\\")) return newDir + s.slice(od.length);
      return null;
    };
    const docs = this.docs();
    for (const d of docs) {
      const np = swap(d.path);
      if (np) {
        d.path = np;
        d.fileName = np.slice(Math.max(np.lastIndexOf("/"), np.lastIndexOf("\\")) + 1);
      }
    }
    this.persist(docs);
    try {
      const rs = this.listRoots().map((r) => swap(r) ?? r);
      localStorage.setItem(LS_ROOTS, JSON.stringify(rs));
    } catch { /* 配额 */ }
    return newDir;
  },
  async toggleTask(p: string, nth: number): Promise<DocFull> {
    const docs = this.docs();
    const d = docs.find((x) => x.path === p);
    if (!d) throw new Error("not found: " + p);
    // 第二档：mock 直接走 flipTaskInSrc（Rust toggle_task 的 TS 权威镜像）——
    // 配对围栏 / 缩进代码 / 懒延续里的假任务与正式版同一套出局规则。
    const flipped = flipTaskInSrc(d.src, nth);
    if (flipped !== null) d.src = flipped;
    this.persist(docs);
    return toFull(d);
  },
  /** 单库策略（对齐 db.replace_root）：登记新目录就把其它库根一并关掉 */
  async scan(root: string): Promise<ScanReport> {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const prev = this.listRoots().find((r) => norm(r) !== norm(root)) ?? null;
    try { localStorage.setItem(LS_ROOTS, JSON.stringify([root])); } catch { /* ignore */ }
    const docs = this.docs();
    let prevDemoted = 0;
    for (const d of docs) {
      // 只回收"用户显式改过入库、又不在新根之下"的条目；演示条目按推导继续留在库里
      if (d.inLibrary === true && !underRoot(d.path, root)) { d.inLibrary = false; prevDemoted++; }
    }
    this.persist(docs);
    const all = this.docs();
    return {
      root, total: all.length, inserted: 0, updated: all.length, removed: 0, skipped: 0,
      unchanged: 0, prevRoot: prev, prevDemoted, truncated: 0,
    };
  },
  setPinned(id: number, on: boolean) {
    const docs = this.docs();
    const d = docs.find((x) => x.id === id);
    if (d) { d.pinned = on; this.persist(docs); }
  },
  /** 记一次打开：只刷新时间，不产生第二条历史（同 Rust 规则） */
  recordRecent(id: number) {
    const m = recentsMap();
    m[id] = Math.max(m[id] ?? 0, nowSecs());
    persistRecents(m);
  },
  listRecents(): RecentDoc[] {
    const m = recentsMap();
    return this.docs()
      .filter((d) => m[d.id] !== undefined)
      .map((d) => ({ meta: toFull(d).meta, openedAt: m[d.id] }))
      .sort((a, b) => b.openedAt - a.openedAt || b.meta.id - a.meta.id);
  },
  setInLibrary(id: number, on: boolean) {
    const docs = this.docs();
    const d = docs.find((x) => x.id === id);
    if (!d) return;
    d.inLibrary = on;
    if (!on) d.pinned = false; // 出库=取消置顶（置顶是库内分组语义）
    this.persist(docs);
  },
  removeRecent(id: number): boolean {
    const m = recentsMap();
    delete m[id];
    persistRecents(m);
    const docs = this.docs();
    const d = docs.find((x) => x.id === id);
    if (d && !mockMembership(d)) {
      this.persist(docs.filter((x) => x.id !== id));
      return true; // 失去归属：登记连带回收（磁盘/演示数据本来就在内存里，无从删起）
    }
    return false;
  },
  clearRecents(): RecentReport {
    const cleared = Object.keys(recentsMap()).length;
    persistRecents({});
    const docs = this.docs();
    const keep = docs.filter((d) => mockMembership(d));
    const pruned = docs.length - keep.length;
    this.persist(keep);
    return { cleared, pruned };
  },
  listRoots(): string[] {
    try { return JSON.parse(localStorage.getItem(LS_ROOTS) || "[]"); } catch { return []; }
  },
  removeRoot(path: string): number {
    const rest = this.listRoots().filter((r) => r !== path);
    try { localStorage.setItem(LS_ROOTS, JSON.stringify(rest)); } catch { /* ignore */ }
    // 对齐 db.remove_root：只被这个根覆盖的条目出库（磁盘与进度本来就不归浏览器 mock 管）
    const docs = this.docs();
    let demoted = 0;
    for (const d of docs) {
      if (d.inLibrary === false) continue;
      if (underRoot(d.path, path) && !rest.some((r) => underRoot(d.path, r))) {
        d.inLibrary = false;
        demoted++;
      }
    }
    if (demoted) this.persist(docs);
    return demoted;
  },
  put(p: string, fileName: string, src: string) {
    const docs = this.docs();
    const existing = docs.find((d) => d.path === p);
    if (existing) {
      existing.src = src;
      existing.mtime = Date.now() / 1000;
    } else {
      docs.push({ id: docs.length + 100, path: p, fileName, src, mtime: Date.now() / 1000 });
    }
    this.persist(docs);
  },
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const ql = q.text.trim().toLowerCase();
    if (!ql) return [];
    const limit = q.limit ?? 200;
    const hits: SearchHit[] = [];
    const pool = this.docs().filter((d) => (q.docId ? d.id === q.docId : true));
    for (const d of pool) {
      const full = toFull(d);
      const secs = sectionize(full);
      for (const s of secs) {
        if (hits.length >= limit) break;
        if (!s.isStart) {
          const [snip, c] = snipOf(s.title, ql);
          if (c) {
            hits.push({ docId: d.id, docPath: d.path, docTitle: full.meta.title, sec: s.title, secAnchor: s.anchor, snippet: snip, count: c, isHeading: true });
          }
        }
        const [snip, c] = snipOf(s.body, ql);
        if (c) {
          hits.push({ docId: d.id, docPath: d.path, docTitle: full.meta.title, sec: s.isStart ? "" : s.title, secAnchor: s.anchor, snippet: snip, count: c, isHeading: false });
        }
      }
      if (hits.length >= limit) break;
    }
    return hits;
  },
  pos(): Record<string, Position> {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY + ":pos") || "{}");
    } catch {
      return {};
    }
  },
  savePosition(id: number, p: Position) {
    const m = this.pos();
    m[id] = p;
    try {
      localStorage.setItem(LS_KEY + ":pos", JSON.stringify(m));
    } catch {
      /* ignore */
    }
  },
  async positions(): Promise<[number, Position][]> {
    // 旧 localStorage 行没有 secLineOff 字段：补 -1（无值）走恢复旧链（与 Rust schema v6 默认同语义）
    return Object.entries(this.pos()).map(([k, v]) => [Number(k), { ...v, secLineOff: v.secLineOff ?? -1 }]);
  },
  async settings(): Promise<Settings> {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(LS_KEY + ":settings") || "{}") };
    } catch {
      return DEFAULT_SETTINGS;
    }
  },
  async setSettings(s: Settings) {
    try {
      localStorage.setItem(LS_KEY + ":settings", JSON.stringify(s));
    } catch {
      /* ignore */
    }
  },
};

function sectionize(full: DocFull): { title: string; body: string; anchor: number | null; isStart: boolean }[] {
  const lines = full.src.split("\n");
  const out: { title: string; body: string; anchor: number | null; isStart: boolean }[] = [];
  const hs = full.outline;
  if (!hs.length) {
    out.push({ title: "", body: full.src, anchor: null, isStart: true });
    return out;
  }
  if (hs[0].line > 0) {
    out.push({ title: "", body: lines.slice(0, hs[0].line).join("\n"), anchor: null, isStart: true });
  }
  hs.forEach((h, idx) => {
    const start = h.line + 1;
    const end = idx + 1 < hs.length ? hs[idx + 1].line : lines.length;
    out.push({ title: h.text, body: lines.slice(start, end).join("\n"), anchor: h.sec, isStart: false });
  });
  return out;
}

function snipOf(text: string, ql: string): [string, number] {
  const tl = text.toLowerCase();
  let count = 0;
  for (let i = tl.indexOf(ql); i >= 0; i = tl.indexOf(ql, i + ql.length)) count++;
  if (!count) return ["", 0];
  const chars = [...text];
  const lchars = [...tl];
  const pat = [...ql];
  const h = lchars
    .slice(0, lchars.length - pat.length + 1)
    .findIndex((_, i) => lchars.slice(i, i + pat.length).join("") === ql);
  if (h < 0) return ["", 0];
  const start = Math.max(0, h - 24);
  const end = Math.min(chars.length, h + pat.length + 48);
  let s = start > 0 ? "…" : "";
  // SEC-01：mock 与 Rust 同契约——片段是**原始文本** + « » 标记，转义统一由 md.ts::renderSnippet 负责。
  // （此前 mock 在这里先 escText 一次，正式版 Rust 不转义，前端直接 innerHTML——浏览器里"看着安全"
  //  恰好掩盖了 Rust 路径的注入面，这是本报告 SEC-01 能存在的根因之一。）
  s += chars.slice(start, end).join("").replace(new RegExp(escapeReJs(ql), "gi"), (m) => `«${m}»`);
  s += end < chars.length ? "…" : "";
  return [s, count];
}

function escapeReJs(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listenOpenEvent(cb: (req: OpenRequest) => void): Promise<void> {
  onOpenRequest(cb);
}

/* UI-02：系统关闭路径（Alt+F4 / 任务栏右键关闭 / 系统关机）由 Rust 侧 CloseRequested
 * 拦下并广播 "close-requested" 事件；前端在脏检查+确认完成后调 destroy 真正关窗。 */
export function onCloseRequest(cb: () => void): () => void {
  if (!isTauri) return () => undefined;
  let disposed = false;
  let un: (() => void) | null = null;
  import("@tauri-apps/api/event").then(({ listen }) => {
    if (disposed) return;
    void listen("close-requested", () => cb()).then((f) => {
      if (disposed) f();
      else un = f;
    });
  });
  return () => {
    disposed = true;
    un?.();
  };
}
export function isTauriRuntime(): boolean {
  return isTauri;
}

/* 外部修改监听（2026-11-27 方案）：Rust 侧 notify 盯当前活动文档，事件带磁盘 stamp。
 * 浏览器 mock 下没有磁盘概念，watch/监听都是 no-op。 */
export interface FileChangedEvent {
  path: string;
  exists: boolean;
  mtime: number;
  size: number;
}

export async function watchDocument(path: string | null): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke("watch_document", { path });
  } catch {
    /* 监听失败静默降级：手动「重新加载文档」仍可用 */
  }
}

export function onFileChanged(cb: (e: FileChangedEvent) => void): () => void {
  if (!isTauri) return () => undefined;
  let disposed = false;
  let un: (() => void) | null = null;
  import("@tauri-apps/api/event").then(({ listen }) => {
    if (disposed) return;
    void listen<FileChangedEvent>("folio-file-changed", (ev) => cb(ev.payload)).then((f) => {
      if (disposed) f();
      else un = f;
    });
  });
  return () => {
    disposed = true;
    un?.();
  };
}

/** Tauri 拖放给的是磁盘路径：判定类型决定走打开还是扫描（FR-1.2） */
export async function pathKind(path: string): Promise<"file" | "dir" | "missing"> {
  if (!isTauri) return "file";
  return invoke("path_kind", { path });
}

/** 浏览器回退：File → 文本入库，返回可打开路径 */
export async function importBrowserFile(file: File): Promise<string | null> {
  try {
    const text = await file.text();
    const path = "browser://" + file.name;
    mock.put(path, file.name, text);
    return path;
  } catch {
    return null;
  }
}

export const api = {
  isTauriRuntime,
  pathKind,
  importBrowserFile,
  resolveImage: apiResolveImage,
  resolveImages: apiResolveImages,
  toAssetSrc,
  toAssetSrcs,
  listDocs: apiListDocs,
  openDoc: apiOpenDoc,
  openBySlug: apiOpenBySlug,
  saveDoc: apiSaveDoc,
  watchDocument,
  onFileChanged,
  renameDoc: apiRenameDoc,
  renameDir: apiRenameDir,
  formatMarkdown: apiFormatMarkdown,
  setPinned: apiSetPinned,
  setInLibrary: apiSetInLibrary,
  listRecents: apiListRecents,
  removeRecent: apiRemoveRecent,
  clearRecents: apiClearRecents,
  listRoots: apiListRoots,
  removeRoot: apiRemoveRoot,
  saveFileAs,
  pickSavePath: apiPickSavePath,
  exportImages: apiExportImages,
  exportPdf: apiExportPdf,
  toggleTask: apiToggleTask,
  scanFolder: apiScanFolder,
  search: apiSearch,
  savePosition: apiSavePosition,
  getPositions: apiGetPositions,
  getSettings: apiGetSettings,
  setSettings: apiSetSettings,
  syncBuiltinDocs: apiSyncBuiltinDocs,
  exportSettings: apiExportSettings,
  importSettings: apiImportSettings,
  drainPending: apiDrainPending,
  listDir: apiListDir,
  mdCount: apiMdCount,
  newDocDraft: apiNewDocDraft,
  dbInfo: apiDbInfo,
  resetDatabase: apiResetDatabase,
  deleteScratch: apiDeleteScratch,
  writeFile: apiWriteFile,
  onOpenRequest,
  pickFile: apiPickFile,
  pickFiles: apiPickFiles,
  pickSaveDoc: apiPickSaveDoc,
  pickFolder: apiPickFolder,
};
