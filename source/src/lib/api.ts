/* API 层：Tauri 存在时全部 invoke；纯浏览器打开（vite dev / file://）自动回退到
 * localStorage + 内置示例，保证 UI 可在无 Rust 工具链的环境开发验证。
 * 回退层不是产品特性 —— 正式版一切以 Rust 为准。 */
import type {
  DirListing, DocFull, DocMeta, OpenRequest, Position, RecentDoc, RecentReport, ScanReport, SearchHit,
  SearchQuery, Settings,
} from "./types";
import { DEFAULT_SETTINGS } from "./defaults";
import { RANGE, clampNum } from "./typography";
import { headingMatch, isFenceLine } from "./md";
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
async function apiSaveDoc(path: string, content: string, force = false): Promise<DocFull> {
  return isTauri ? invoke("save_doc", { path, content, force }) : mock.save(path, content);
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
  };
}

async function apiImportSettings(): Promise<ImportResult> {
  let text: string | null = null;
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return { kind: "cancel" };
    try { text = await invoke<string>("read_file", { path }); }
    catch (e) { return { kind: "invalid", why: "读取失败：" + String(e) }; }
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
    if (!settings) return { kind: "invalid", why: "文件内容不是有效的设置对象" };
    return { kind: "ok", settings };
  } catch {
    return { kind: "invalid", why: "JSON 解析失败（文件损坏或不是配置导出）" };
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
async function apiNewDocDraft(): Promise<string> {
  if (isTauri) return invoke<string>("new_doc_draft");
  let i = 0, name = "未命名文档.md";
  while (mock.docs().some((d) => d.fileName === name)) { i++; name = `未命名文档 ${i}.md`; }
  mock.put("browser://drafts/" + name, name, "# 未命名文档\n\n");
  return "browser://drafts/" + name;
}
/** 清理草稿临时文件（后端校验必须在 appdata/drafts 下；浏览器回退层顺手移出 mock） */
async function apiDeleteScratch(path: string): Promise<void> {
  if (isTauri) { await invoke("delete_scratch", { path }); return; }
  mock.persist(mock.docs().filter((d) => d.path !== path));
}
/** 通用写文本（保存对话框确认后落盘；FR-13.1 同款 write_file） */
async function apiWriteFile(path: string, content: string): Promise<void> {
  if (isTauri) { await invoke("write_file", { path, content }); return; }
  mock.put(path, path.split(/[\\/]/).pop() || path, content);
}

/* ── 浏览器 mock ── */
import guideMd from "../assets/guide.md?raw";
import rustMd from "../assets/rust-notes.md?raw";

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

/* CON-07：mock 与正式版共用同一判定函数（围栏/标题），杜绝「演示环境大纲与 Rust 不一致」。 */
function headingsOf(src: string) {
  const out: { sec: number; level: number; text: string; line: number }[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  lines.forEach((raw, line) => {
    if (isFenceLine(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const m = headingMatch(raw);
    if (!m) return;
    out.push({ sec: out.length + 1, level: m.level, text: m.text, line });
  });
  return out;
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
 * （demo/ 下的两份内置文档视作「一次目录扫描的产物」，否则浏览器模式的库面板永远空着） */
function mockMembership(d: MockDoc): boolean {
  if (d.inLibrary !== undefined) return d.inLibrary;
  try {
    const roots: string[] = JSON.parse(localStorage.getItem(LS_ROOTS) || "[]");
    if (roots.some((r) => underRoot(d.path, r))) return true;
  } catch { /* 无根 */ }
  return d.path.startsWith("demo/");
}

const mock = {
  docs(): MockDoc[] {
    let docs: MockDoc[];
    try {
      docs = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    } catch {
      docs = [];
    }
    if (!docs.some((d) => d.path.endsWith("guide.md"))) {
      docs.unshift({ id: 1, path: "demo/guide.md", fileName: "guide.md", src: guideMd, mtime: Date.now() / 1000 });
    }
    if (!docs.some((d) => d.path.endsWith("rust-notes.md"))) {
      docs.push({ id: 2, path: "demo/rust-notes.md", fileName: "Rust 学习笔记.md", src: rustMd, mtime: Date.now() / 1000 - 86400 });
    }
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
  async toggleTask(p: string, nth: number): Promise<DocFull> {
    const docs = this.docs();
    const d = docs.find((x) => x.path === p);
    if (!d) throw new Error("not found: " + p);
    let seen = 0;
    let inFence = false;
    const rows = d.src.split("\n");
    for (let i = 0; i < rows.length; i++) {
      if (isFenceLine(rows[i])) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = rows[i].match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/);
      if (!m) continue;
      if (seen === nth) {
        rows[i] = m[1] + "[" + (m[2].trim() === "" ? "x" : " ") + "]" + rows[i].slice(m[0].length);
        break;
      }
      seen++;
    }
    d.src = rows.join("\n");
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
  exportSettings: apiExportSettings,
  importSettings: apiImportSettings,
  drainPending: apiDrainPending,
  listDir: apiListDir,
  mdCount: apiMdCount,
  newDocDraft: apiNewDocDraft,
  deleteScratch: apiDeleteScratch,
  writeFile: apiWriteFile,
  onOpenRequest,
  pickFile: apiPickFile,
  pickFiles: apiPickFiles,
  pickSaveDoc: apiPickSaveDoc,
  pickFolder: apiPickFolder,
};
