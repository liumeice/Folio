/* 弹层/搜索命中等瞬时 UI 态（不进 store——它们不是产品状态，是视图状态）。
 * 命中高亮与浮动条逻辑集中在这里：Reader 注册正文元素，palette 调用。 */
import { createSignal } from "solid-js";
import { escapeHtml } from "./md";
import type { DocMeta } from "./types";

export const [menuOpen, setMenuOpen] = createSignal<string | null>(null);
// 设置中心（右侧面板）：取代原 FontPopover 小浮层与挤在一起的 TypeDrawer
export const [settingsOpen, setSettingsOpen] = createSignal(false);
export const [searchOpen, setSearchOpen] = createSignal(false);
// 默认范围与原型一致：当前文档（「全部已登记」= 库成员 + 仅在最近打开里的文件，右侧芯片显式切换）
export const [searchScope, setSearchScope] = createSignal<"current" | "library">("current");
export const [keysOpen, setKeysOpen] = createSignal(false);
export const [aboutOpen, setAboutOpen] = createSignal(false);
export const [propsOpen, setPropsOpen] = createSignal(false);
export const [imgSrc, setImgSrc] = createSignal<string | null>(null);

/* 复制成功浮层（§8.3 v1.1 追加）：窗口中央小卡，2 秒自动消失；不再贴状态栏下沿弹 toast */
export const [copyPop, setCopyPop] = createSignal<{ msg: string; link?: string } | null>(null);
let copyPopTimer: ReturnType<typeof setTimeout> | undefined;
export function showCopied(msg: string, link?: string) {
  setCopyPop({ msg, link });
  clearTimeout(copyPopTimer);
  copyPopTimer = setTimeout(() => setCopyPop(null), 2000);
}

/* ── 应用内询问框（Promise 桥=视图态）。选择对话框桥（pick/runSaveAs/finishPick）自
 * 2026-11-17 起休眠：打开文件/打开文件夹/另存为已恢复 Windows 原生系统对话框
 * （actions.pickPaths → api.pickFiles/pickFolder、store.save → api.pickSaveDoc）。
 * 桥与 pickReq 暂留（anyOverlayOpen/closeTopOverlay 仍引用），PickDialog.tsx 未挂载。 */
export type PickMode = "files" | "dir" | "save";
export type PickVal = string[] | { path: string; name: string } | null;
export interface AskSpec {
  title: string;
  sub?: string;
  icon?: string;
  rows?: [string, string][];
  note: string;
  /** 两钮形态的主按钮文案（默认「确定」）；给 buttons 时忽略 */
  ok?: string;
  /** 多钮形态（退出保存选择，需求方 2026-11-18）：「取消」恒在左，本组依序排右；resolve = 按钮 value */
  buttons?: readonly { label: string; value: string; primary?: boolean }[];
  /** note 走 plain 样式：无圆角边框盒、字号加大 2 号（11.5→13.5）——退出警告专用 */
  notePlain?: boolean;
}
export const [pickReq, setPickReq] = createSignal<{ mode: PickMode; name?: string; dir?: string | null } | null>(null);
export const [askReq, setAskReq] = createSignal<AskSpec | null>(null);
/** 查看→主题 子菜单展开态（菜单关闭时由 App 的 effect 复位） */
export const [themeSubOpen, setThemeSubOpen] = createSignal(false);
let pickResolve: ((v: PickVal) => void) | null = null;
let askResolve: ((v: boolean | string) => void) | null = null;
export function pick(mode: PickMode): Promise<string[] | null> {
  if (pickResolve) finishPick(null);   // 同 ask：覆盖前先把前一个按「取消」结算（UI-03）
  return new Promise((res) => { pickResolve = res as (v: PickVal) => void; setPickReq({ mode }); });
}
/** 新建文档首次保存：对话框确认文件名+目录；resolve {path,name}，取消=null */
export function runSaveAs(name: string, dir: string | null): Promise<{ path: string; name: string } | null> {
  if (pickResolve) finishPick(null);
  return new Promise((res) => { pickResolve = res as (v: PickVal) => void; setPickReq({ mode: "save", name, dir }); });
}
export function finishPick(vals: PickVal) {
  const r = pickResolve; pickResolve = null; setPickReq(null); r?.(vals);
}
/* 新建草稿路径登记（store.save 据此拦截首次保存走保存对话框；不落库、不进树直到保存确认） */
const draftPaths = new Set<string>();
export function markDraftPath(p: string) { draftPaths.add(p); }
export function isDraftPath(p: string) { return draftPaths.has(p); }
export function clearDraftPath(p: string) { draftPaths.delete(p); }
export function ask(spec: AskSpec): Promise<boolean | string> {
  // UI-03：同一时刻只允许一个询问框。后来者覆盖前必须先把前一个按「取消」结算，
  // 否则前一个 Promise 永远悬挂，等待它的流程（关页签/退出）会卡死。
  if (askResolve) finishAsk(false);
  return new Promise((res) => { askResolve = res; setAskReq(spec); });
}
/** resolve 值：boolean=两钮形态（true 主操作/false 取消），string=多钮形态的按钮 value */
export function finishAsk(v: boolean | string) {
  const r = askResolve; askResolve = null; setAskReq(null); r?.(v);
}
export const [hitCount, setHitCount] = createSignal(0);
export const [hitIdx, setHitIdx] = createSignal(0);
export const [hitNavVisible, setHitNavVisible] = createSignal(false);
export const [readPct, setReadPct] = createSignal(0);

/* 文档库树的展开状态：Map<目录键, 真展开值>。
 * 没有记录的目录按默认规则（只展开库根）；"全部展开/全部收起"整批写记录。
 * 放 ui 层而不是组件里：切到大纲再切回来不该把用户展开的东西吐掉，但也不属于产品状态。 */
export const [libExpand, setLibExpand] = createSignal<Map<string, boolean>>(new Map());

/* 右键菜单目标（FR-10.2）：只有文档条目有菜单。from 决定可用动作——
 * library=可置顶、可从库移除；recents=可从历史移除。两者都不碰磁盘。
 * （曾经的 kind:"roots" 分支随 v4 单库策略删除：库根管理并入 chip 自身。） */
export type CtxTarget =
  | { kind: "doc"; from?: "library" | "recents"; x: number; y: number; meta: DocMeta }
  | null;
export const [ctxMenu, setCtxMenu] = createSignal<CtxTarget>(null);

/** 错误文案人性化（UI 规范 v1.2 §8.7 L2：失败=动词+原因，白话，不泄原始英文栈串）。
 * Rust 侧错误以 String 过 IPC（STD-02 现状），这里把已知的 CoreError 措辞映射成中文；
 * 未知错误截断兜底，绝不再把 "file not found: 全长路径" 原样甩给用户。 */
export function fmtErr(e: unknown): string {
  const s = String(e).replace(/^Error:\s*/i, "");
  const nf = s.match(/^file not found:\s*(.*)$/i);
  if (nf) {
    let name = (nf[1] || "").split(/[\\/]/).pop() || "";
    if (name.length > 36) name = "…" + name.slice(-35);   // 兜底：路径异常时也绝不甩长串
    return name ? `文件不存在或已被移动（${name}）` : "文件不存在或已被移动";
  }
  if (/unsupported/i.test(s)) return "不支持的文件类型（仅 .md / .markdown / .txt）";
  if (/db mutex|database|sqlite/i.test(s)) return "本地数据库访问失败，请重试";
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

export function getArticleHtml(): string { return articleEl ? articleEl.innerHTML : ""; }

let articleEl: HTMLElement | null = null;
let marks: HTMLElement[] = [];
let pendingQuery = "";

export function registerArticle(el: HTMLElement | null) {
  articleEl = el;
}

/* ── 导出 PDF（FR-13.2）：在途互斥标记（同时驱动中央浮层）与打印前的正文就绪检查 ── */
export const [exportBusy, setExportBusy] = createSignal(false);

/* ── 打开文件夹扫描进行中浮层（需求方 2026-11-18 样例定稿「仅顶部小卡」）──
 * 值为正在扫描的目录路径；null=不在扫描。扫描走 Rust 后台线程，期间仅顶部小卡反馈，侧栏不动。 */
export const [scanBusy, setScanBusy] = createSignal<string | null>(null);

/** 阅读正文是否还有未达终态的图占位（mermaid/zenuml 渲染在途）→ 导出要拒绝，否则会拍到占位框 */
export function articlePendingFigures(): boolean {
  return !!articleEl?.querySelector("[data-mermaid]:not(.f-ready):not(.f-error)");
}

/** 懒加载图催熟（FR-13.2）：md.ts 产出的 loading=lazy 图在打印时可能尚未解码；
 *  全部转 eager 并等 decode()，总超时后不再等（缺图按现状打，导出不许挂死在这）。 */
export function primeArticleImages(timeoutMs = 3000): Promise<void> {
  if (!articleEl) return Promise.resolve();
  const imgs = [...articleEl.querySelectorAll<HTMLImageElement>("img")];
  imgs.forEach((i) => { if (i.loading === "lazy") i.loading = "eager"; });
  const waits = imgs.map((i) => (i.decode ? i.decode().catch(() => undefined) : Promise.resolve()));
  return Promise.race([
    Promise.all(waits).then(() => undefined),
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** 阅读窗底色 → `#RRGGBB`（导出 PDF 传给 Rust 当页边距衬底色；取不到按白纸）。 */
export function viewBgHex(): string {
  const v = articleEl?.closest?.(".view") ?? document.querySelector(".view");
  const bg = v ? getComputedStyle(v).backgroundColor : "";
  const m = bg.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return "#FFFFFF";
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return "#" + hex(m[1]) + hex(m[2]) + hex(m[3]);
}

/** 等正文渲染稳定（2026-11-17 实测教训：长文档初排是渐进的——47k 字文档开文 2.5s 时
 *  只渲染了 15%，此刻导出 PDF 会缺后半正文。连续 N 次采样高度一致才算稳，超时兜底放行
 *  ——打印交给用户重试永远不如自己等一拍）。 */
export function waitArticleStable(sampleMs = 350, need = 3, maxMs = 15000): Promise<void> {
  if (!articleEl) return Promise.resolve();
  return new Promise((resolve) => {
    let same = 0;
    let last = -1;
    const t0 = Date.now();
    const tick = () => {
      const cur = articleEl ? articleEl.scrollHeight : 0;
      same = cur === last ? same + 1 : 0;
      last = cur;
      if (same >= need - 1 || Date.now() - t0 > maxMs) return resolve();
      setTimeout(tick, sampleMs);
    };
    tick();
  });
}

/* UI-01：设置窗/菜单/右键菜单也是「上层」——编辑态按 Esc 时只要有任何弹层压在上面，
 * 就绝不能走丢弃未保存内容的路径（此前漏了 settingsOpen 导致「按 Esc 想关设置，内容没了」） */
export function anyOverlayOpen() {
  return searchOpen() || keysOpen() || aboutOpen() || propsOpen() || imgSrc() != null
    || pickReq() != null || askReq() != null || settingsOpen() || menuOpen() != null || ctxMenu() != null;
}

export function closeTopOverlay(): boolean {
  if (menuOpen()) { setMenuOpen(null); return true; }
  if (ctxMenu()) { setCtxMenu(null); return true; }   // UI-07：Esc 收起右键菜单
  if (settingsOpen()) { setSettingsOpen(false); return true; }
  // 询问框（Esc=取消，零副作用）→ 选择对话框（§11 裁决链 v1.1）
  if (askReq()) { finishAsk(false); return true; }
  if (pickReq()) { finishPick(null); return true; }
  if (searchOpen()) { setSearchOpen(false); clearHits(); return true; }
  if (propsOpen()) { setPropsOpen(false); return true; }
  if (keysOpen()) { setKeysOpen(false); return true; }
  if (aboutOpen()) { setAboutOpen(false); return true; }
  if (imgSrc()) { setImgSrc(null); return true; }
  if (hitNavVisible()) { clearHits(); return true; }
  return false;
}

/** 整篇高亮查询词（TreeWalker；与原型同实现） */
export function highlightAll(q: string) {
  if (!articleEl) return;
  const query = q.toLowerCase();
  const walker = document.createTreeWalker(articleEl, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const t = n as Text;
      if (!t.parentElement || t.parentElement.tagName === "MARK") return NodeFilter.FILTER_REJECT;
      // MathJax/Mermaid 排版产物（svg/mjx-container）内部不许塞 <mark>——SVG 命名空间下会拆坏图形
      if (t.parentElement.closest("svg, mjx-container")) return NodeFilter.FILTER_REJECT;
      return t.data.toLowerCase().includes(query) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const n of nodes) {
    const data = n.data, dl = data.toLowerCase();
    let idx = dl.indexOf(query), pos = 0;
    const frag = document.createDocumentFragment();
    while (idx >= 0) {
      if (idx > pos) frag.appendChild(document.createTextNode(data.slice(pos, idx)));
      const m = document.createElement("mark");
      m.className = "hit";
      m.textContent = data.slice(idx, idx + q.length);
      frag.appendChild(m);
      pos = idx + q.length;
      idx = dl.indexOf(query, pos);
    }
    if (!frag.childNodes.length) continue;
    frag.appendChild(document.createTextNode(data.slice(pos)));
    n.replaceWith(frag);
  }
  marks = articleEl ? [...articleEl.querySelectorAll<HTMLElement>("mark.hit")] : [];
  setHitCount(marks.length);
  pendingQuery = q;
}

/** 跨文档跳转：先声明待高亮查询与目标节，Reader 渲染完成后 take 并应用 */
let pendingHighlightValue = "";
let pendingHit: { sec: number | null; text: string | null } | null = null;
export function setPendingHighlight(q: string, hit?: { sec: number | null; text: string | null }) {
  pendingHighlightValue = q;
  pendingHit = hit ?? null;
}
export function takePendingHighlight(): [string, { sec: number | null; text: string | null } | null] {
  const v: [string, typeof pendingHit] = [pendingHighlightValue, pendingHit];
  pendingHighlightValue = "";
  pendingHit = null;
  return v;
}

/* Reader 注册的章节导航（Alt+↑↓ / Home），避免 App 直接摸 DOM */
let sectionNav: { dir: (d: number) => void; toTop: () => void } | null = null;
export function registerSectionNav(h: { dir: (d: number) => void; toTop: () => void } | null) {
  sectionNav = h;
}
export function navSection(d: number) { sectionNav?.dir(d); }
export function navTop() { sectionNav?.toTop(); }

/* ── 阅读 ⇄ 编辑 滚动同步桥（v1.2：一把尺=小数源码行号 lineFloat；方案 §4.1(c)） ── */
export interface ViewBridge {
  /** 视口顶边（SYNC_TOP+epsilon）对应的小数源码行号；锚点表不可用时 null */
  topLine(): number | null;
}
export interface EditorBridge {
  /** 精确跳到小数行号：floor 行 scrollIntoView + 下一帧 coordsAtPos 贴顶校正 */
  jumpToLine(line: number): void;
  topLine(): number | null;
  /** 编辑器实时正文（P1-3）：保存/搜索按需取一次，不再每次按键复制整篇 */
  docText(): string;
}
let viewBridge: ViewBridge | null = null;
let editorBridge: EditorBridge | null = null;
export function registerViewBridge(b: ViewBridge | null) { viewBridge = b; }
export function getViewBridge() { return viewBridge; }
export function registerEditorBridge(b: EditorBridge | null) { editorBridge = b; }
export function getEditorBridge() { return editorBridge; }
/** 进入编辑时暂存的"从阅读侧带来的行号"，EditorPane 挂载后消费 */
let pendingEditorJump: number | null = null;
export function setPendingEditorJump(line: number | null) { pendingEditorJump = line; }
export function takePendingEditorJump(): number | null {
  const v = pendingEditorJump; pendingEditorJump = null; return v;
}

/* 逐块锚点补偿与排版落定标记在 lib/nav.ts（渲染模块只依赖 nav，不经 ui.tsx——ui 含 solid 信号，
 * node --experimental-strip-types 测试链不解析 .tsx）。 */

/** 导出清洗（方案 §4.5）：块锚/预估高度是阅读窗内部坐标，导出文件一律剥除。
 *  md.ts 产出的 min-height 恰为占位预估串，按同形状剥；data-sec/data-task 保留（PDF 书签/回写依赖）。 */
export function cleanExportHtml(html: string): string {
  return html
    .replace(/ data-line-start="-?\d+" data-line-end="-?\d+"/g, "")
    .replace(/ style="min-height:\d+px"/g, "");   // 仅 f-block 占位预估用此形状（md.ts 单点产出）
}
export function currentQuery() { return pendingQuery; }

export function showHitNav(startIdx: number) {
  setHitIdx(Math.max(0, Math.min(startIdx, Math.max(0, marks.length - 1))));
  setHitNavVisible(marks.length > 0);
  focusMark(hitIdx());
}

/** 某节范围内第一个命中 mark 的下标；找不到返回 0（浮动条起始位置） */
export function firstMarkOfSection(secAnchor: number | null, secText: string | null): number {
  if (!articleEl || !marks.length) return 0;
  let from: Element | null = null;
  if (secAnchor != null) from = articleEl.querySelector(`[data-sec="${secAnchor}"]`);
  if (!from && secText)
    from = [...articleEl.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((x) => x.textContent === secText) || null;
  if (!from) return 0;
  let to: Element | null = from.nextElementSibling;
  while (to && !/^H[1-6]$/.test(to.tagName)) to = to.nextElementSibling;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (!(from.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (to && !(to.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
    return i;
  }
  return 0;
}

function focusMark(i: number) {
  marks.forEach((m) => m.classList.remove("cur"));
  const m = marks[i];
  if (m) { m.classList.add("cur"); m.scrollIntoView({ behavior: "smooth", block: "center" }); }
}

export function stepHit(d: number) {
  if (!marks.length) return;
  const n = (hitIdx() + d + marks.length) % marks.length;
  setHitIdx(n);
  focusMark(n);
}

export function clearHits() {
  if (articleEl) {
    articleEl.querySelectorAll("mark.hit").forEach((m) => m.replaceWith(...m.childNodes));
    articleEl.normalize();
  }
  marks = [];
  pendingQuery = "";
  setHitCount(0);
  setHitIdx(0);
  setHitNavVisible(false);
}

export function escapeAttr(s: string) { return escapeHtml(s); }
