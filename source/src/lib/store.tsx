/* 全局状态：Solid signals + 导航历史 + 位置存储 + toast 队列。
 * 内置评审教训：
 *  - N1 toast 队列化，关键通知不被后续 toast 吞掉；
 *  - N4 位置防抖只是省写入，任何导航/关闭前必须 flush；
 *  - 编辑/阅读共享同一份草稿（draftSrc），复选框与编辑器不竞写。 */
import {
  createContext, useContext, createSignal, createEffect, onMount, type JSX, type ParentProps,
} from "solid-js";
import { api } from "./api";
import { swapPathPrefix } from "./filename";
import { DEFAULT_SETTINGS } from "./defaults";
import type { DocFull, DocMeta, FormatResult, HistEntry, Position, RecentDoc, Settings } from "./types";

import { isTypesetSettled, lineForSec, navForHistEntrySameDoc, navForRestorePos, type NavRequest } from "./nav";
import { ancestorChain, buildOutlineTree } from "./oltree";
import { headingsOfSrc } from "./md";

/** 行锚主链所需：文档行数（\r\n 归一后按 \n 计，与 md.ts / folio-core 同口径） */
function srcLines(src: string): number {
  return src.replace(/\r\n/g, "\n").split("\n").length;
}

/** 大纲签名：切换文档 / 保存 / 格式化后判断是否需要清空折叠状态。
 *  outline 没变（例如阅读态勾选任务）就不打扰用户已展开的树。 */
function outlineSig(outline: readonly { sec: number; line: number; text: string }[]): string {
  return outline.map((o) => `${o.sec}:${o.line}:${o.text}`).join("\u0001");
}
import { quitApp } from "./actions";
import * as ui from "./ui";
import { dismissSplash, bootNavType, shouldRestoreOnBoot } from "./boot";

/* ── 草稿持久化（FR-7.7，异常退出找回）：按文档路径存 localStorage ── */
const DRAFT_PREFIX = "folio:draft:";
function persistDraft(path: string, text: string) {
  try { localStorage.setItem(DRAFT_PREFIX + path, JSON.stringify({ text, at: Date.now() })); } catch { /* 配额 */ }
}
function clearDraft(path: string) { try { localStorage.removeItem(DRAFT_PREFIX + path); } catch { /* ignore */ } }
function getDraft(path: string): { text: string; at: number } | null {
  try { const r = localStorage.getItem(DRAFT_PREFIX + path); return r ? JSON.parse(r) : null; } catch { return null; }
}

/** 侧边面板三态：大纲 / 文档库（目录树）/ 最近打开（历史）。库与历史是两套独立清单。 */
export type SideView = "outline" | "library" | "recents" | null;
export type ToastItem = { id: number; text: string };
export type { NavRequest };

export interface Store {
  // data
  docs: () => DocMeta[];
  /** 打开历史（时间倒序，不限量）——与 docs（全部已登记）口径不同 */
  recents: () => RecentDoc[];
  /** 已登记的库根目录（文档库树的树根） */
  roots: () => string[];
  current: () => DocFull | null;
  /** 阅读窗/大纲/状态栏的显示文档（《撤销/重做方案》v1.1：预览态优先取 previewDoc，否则 current） */
  displayDoc: () => DocFull | null;
  /** 编辑器会话是否存活（进编辑 → 保存/放弃/切页签/切文档 期间为真；预览态仍为真） */
  editorSessionAlive: () => boolean;
  settings: () => Settings;
  positionsMap: () => Record<number, Position>;
  // ui
  mode: () => "read" | "edit";
  dirty: () => boolean;
  side: () => SideView;
  focusMode: () => boolean;
  activeSec: () => number | null;
  toasts: () => ToastItem[];
  navRequest: () => NavRequest;
  histIdx: () => number;
  histLen: () => number;
  draftSrc: () => string;
  tabs: () => Tab[];
  activeTabId: () => number | null;
  // actions
  refreshDocs(): Promise<void>;
  /** 目录树「重命名」成功回调（IPC 完成后调）：登记清单 / 页签 / 最近打开 / 当前文档的
   *  路径类元数据统一换新，异常找回草稿随路径搬家。doc_id 不变 ⇒ 进度、脏标记、编辑器缓冲不动。 */
  applyRenamed(oldPath: string, next: DocMeta): void;
  /** 文件夹「重命名」成功回调（增强 2026-11-20）：子树内所有文档的 path/dir/fileName、页签、
   *  历史行、当前文档与异常找回草稿按前缀整体搬家；roots 清单与 libraryRoot 偏好交给随后的
   *  refreshDocs / saveSettings 对齐。库成员判定（Rust path_under）已随 rename_dir 换前缀。 */
  applyRenamedFolder(oldDir: string, newDir: string): void;
  /** 返回是否打开成功（失败=文件丢失时条目自动移出最近打开，2026-11-17 定夺） */
  openMeta(meta: DocMeta): Promise<boolean>;
  openPath(path: string, secText?: string | null): Promise<boolean>;
  openSlug(slug: string, secText?: string | null): Promise<void>;
  requestAnchor(sec: number, record: boolean): void;
  /** 主动跳转的硬展开：目标章节祖先链写进大纲 overrides（压过用户此前的收起） */
  revealOutline(sec: number | null | undefined): void;
  enterEdit(): void;
  toggleEdit(): void;
  /** 仅退回阅读态（不保存 / 不丢弃 / 不动脏标记）：编辑器未能挂载时的退路 */
  cancelEdit(): void;
  pushHist(e: HistEntry): void;
  setDraft(v: string): void;
  /** 编辑按键轻量通道（P1-3）：只挂脏 + 合并一次防抖快照，不在每次 docChanged 里复制全文 */
  markDraftChanged(): void;
  /** 保存。返回 false = 未保存成功（取消对话框/写盘失败），调用方（如 closeTab）必须据此中止后续动作 */
  save(customMsg?: string, force?: boolean): Promise<boolean>;
  /** Ctrl+S/菜单「保存」入口：模式自适应（§6.4），干净时如实提示 */
  saveSmart(): Promise<boolean>;
  /** 另存为…（Ctrl+Shift+S）：写副本并把当前页签原位切到新文件，原文件不动 */
  saveAs(): Promise<boolean>;
  discard(): void;
  applySaved(next: DocFull): void;
  /** 源码格式化后的内存更新（不写盘）：正文、大纲、统计与脏标记一次对齐。
   *  与 applySaved 的区别：大纲/统计按格式化后文本重算，且不触发阅读位置导航。 */
  applyFormatted(r: FormatResult): void;
  saveSettings(patch: Partial<Settings>): void;
  /** 立即把待写设置落库（滑杆松手 / 设置面板关闭 / 退出前）；返回写入完成 Promise */
  flushSettings(): Promise<void>;
  setSide(v: SideView): void;
  toggleFocus(): void;
  /** 顶部瞬时通知；ms=停留时长（默认 2600；短确认类可给 1000） */
  toast(text: string, ms?: number): void;
  setActiveSec(n: number | null): void;
  schedulePosition(): void;
  flushPosition(): Promise<void>;
  providePositionSource(fn: () => Position | null): void;
  back(): Promise<void>;
  forward(): Promise<void>;
  clearNav(): void;
  closeTab(docId: number): Promise<void>;
  isTauri: boolean;
}

const Ctx = createContext<Store>();
export function useStore(): Store {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStore 必须在 StoreProvider 内使用");
  return c;
}

/** 打开页签（v1.2：多文档并行；只存标识，切换时重取文档保证与磁盘一致） */
export interface Tab { docId: number; path: string; fileName: string }

let toastSeq = 0;
const HIST_MAX = 80;

export function StoreProvider(props: ParentProps): JSX.Element {
  const [docs, setDocs] = createSignal<DocMeta[]>([]);
  const [recents, setRecents] = createSignal<RecentDoc[]>([]);
  const [roots, setRoots] = createSignal<string[]>([]);
  const [current, setCurrent] = createSignal<DocFull | null>(null);
  const [settings, setSettings] = createSignal<Settings>(DEFAULT_SETTINGS);
  const [positionsMap, setPositionsMap] = createSignal<Record<number, Position>>({});
  const [mode, setMode] = createSignal<"read" | "edit">("read");
  const [dirty, setDirty] = createSignal(false);
  /* 预览阅读（《撤销/重做方案》v1.1，2026-11-23）：编辑返回阅读默认走「预览」——
   * 不写盘、editorSession 保留（编辑器隐藏不卸载，历史/选区/滚动保留），
   * 阅读窗显示 previewDoc（由草稿派生）而非磁盘旧文；仅「保存并返回阅读」才落盘并结束会话。 */
  const [editorSessionAlive, setEditorSessionAlive] = createSignal(false);
  const [previewDoc, setPreviewDoc] = createSignal<DocFull | null>(null);
  function displayDoc(): DocFull | null { return previewDoc() ?? current(); }
  /** 由草稿文本派生预览文档：重算 outline 与小节数，meta 其余字段沿用磁盘版本 */
  function buildPreviewDoc(base: DocFull, text: string): DocFull {
    const outline = headingsOfSrc(text);
    return { ...base, src: text, outline, meta: { ...base.meta, secCount: outline.length } };
  }
  // 撤销/重做的菜单可用性还要叠加「当前处于编辑态」（预览态历史保留但菜单置灰）
  createEffect(() => ui.setEditorHistoryEditable(mode() === "edit"));
  const [side, setSide] = createSignal<SideView>("outline");
  const [focusMode, setFocusMode] = createSignal(false);
  const [activeSec, setActiveSec] = createSignal<number | null>(null);
  const [toasts, setToasts] = createSignal<ToastItem[]>([]);
  const [navRequest, setNavRequest] = createSignal<NavRequest>(null);
  const [draftSrc, setDraftSrc] = createSignal("");
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [activeTabId, setActiveTabId] = createSignal<number | null>(null);
  const [histIdx, setHistIdx] = createSignal(-1);
  let history: HistEntry[] = [];

  /* ── 磁盘现状对照（2026-11-18 需求方定夺：写盘只发生在用户显式动作里）──
   * dirty = 内存态（编辑缓冲或阅读 src）≠ 最近一次落盘内容。
   * diskMap 仅在「读盘打开/写盘成功」两类链路刷新（switchTo / 启动恢复 / save / saveAs 覆盖分支）；
   * 打勾等内存改写走 applySaved，不动 diskMap ⇒ 脏标记立住，由「保存」统一落盘。 */
  const [diskMap, setDiskMap] = createSignal<Record<number, string>>({});
  function setDisk(id: number, src: string) { setDiskMap((m) => ({ ...m, [id]: src })); }
  function recomputeDirty() {
    const c = current();
    if (!c) { setDirty(false); return; }
    const disk = diskMap()[c.meta.id];
    if (disk === undefined) { setDirty(false); return; } // 未经读盘链路的文档（如空草稿）按干净处理
    // v1.1：预览态按「预览文本」与磁盘比较，保证页签脏点不丢；否则按编辑缓冲/阅读正文
    const working = previewDoc()?.src ?? (mode() === "edit" ? draftSrc() : c.src);
    setDirty(working !== disk);
  }

  /* ── toast 队列（N1）：同屏最多 2 条，其余排队；默认停留 2600ms，可按条指定
   *（扫描完成统计通知 1000ms——需求方 2026-11-18：结果一句话扫完即走，别挡视线）── */
  const queue: { text: string; ms: number }[] = [];
  function pump() {
    if (queue.length === 0 || toasts().length >= 2) return;
    const q = queue.shift()!;
    const item = { id: ++toastSeq, text: q.text };
    setToasts((t) => [...t, item]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== item.id));
      window.setTimeout(pump, 180);
    }, q.ms);
  }
  function toast(text: string, ms = 2600) {
    if (toasts().some((t) => t.text === text) || queue.some((q) => q.text === text)) return;
    queue.push({ text, ms });
    pump();
  }

  /* ── 位置（N4） ── */
  let posTimer: number | undefined;
  let posSource: (() => Position | null) | null = null;
  function providePositionSource(fn: () => Position | null) {
    posSource = fn;
  }
  function schedulePosition() {
    if (!posSource || mode() === "edit") return;
    window.clearTimeout(posTimer);
    posTimer = window.setTimeout(() => {
      posTimer = undefined;
      void flushPosition();
    }, 400);
  }
  async function flushPosition() {
    if (posTimer !== undefined) {
      window.clearTimeout(posTimer);
      posTimer = undefined;
    }
    if (!posSource || mode() === "edit") return;
    const cur = current();
    let p = posSource();
    if (!cur || !p) return;
    // ratio 是布局依赖量：排版未落定时 scrollHeight 是塌陷值，落盘即污染（R6/二轮评审 2.4）。
    // 未落定期沿用旧 ratio；secLineOff/srcLine 布局无关照常写（方案 §4.3）
    if (!isTypesetSettled(cur.meta.id)) {
      const old = positionsMap()[cur.meta.id];
      if (old && old.updatedAt <= p.updatedAt) p = { ...p, ratio: old.ratio };
    }
    setPositionsMap((m) => ({ ...m, [cur.meta.id]: p }));
    const h = history[histIdx()];
    if (h && h.docId === cur.meta.id) {
      h.ratio = p.ratio;
      h.sec = p.sec;
      h.secText = p.secText;
      h.lineFloat = p.srcLine ?? null;   // 同文档历史绝对位置主坐标（布局无关）
    }
    try {
      await api.savePosition(cur.meta.id, p);
    } catch (e) {
      console.warn("[folio] save position failed", e);
    }
  }

  /* ── 历史 ── */
  function pushHist(e: HistEntry) {
    const top = history[histIdx()];
    if (top && top.docId === e.docId && top.sec === e.sec) return;
    history = history.slice(0, histIdx() + 1);
    history.push(e);
    if (history.length > HIST_MAX) history = history.slice(history.length - HIST_MAX);
    setHistIdx(history.length - 1);
  }

  function setDoc(doc: DocFull) {
    cancelDraftTimers();   // 切文档：上一文档的防抖快照不得落到新文档状态上
    const prev = current();
    // 大纲折叠状态（2026-11-18）：只在大纲真的变化时清空。sec 按顺序编号，
    // 增删标题后旧键会错位；勾选任务等「正文变、大纲不变」的更新保留用户的树。
    if (
      !prev || prev.meta.id !== doc.meta.id
      || (prev.outline !== doc.outline && outlineSig(prev.outline) !== outlineSig(doc.outline))
    ) {
      ui.resetOutlineFold();
    }
    setCurrent(doc);
    setDraftSrc(doc.src);
    setActiveSec(null);
    setDocs((ds) => [doc.meta, ...ds.filter((d) => d.id !== doc.meta.id)]);
    // 页签 upsert：已存在保持位次，否则追加；激活态跟随
    setTabs((ts) => {
      const hit = ts.find((t) => t.docId === doc.meta.id);
      const tab: Tab = { docId: doc.meta.id, path: doc.meta.path, fileName: doc.meta.fileName };
      return hit ? ts.map((t) => (t.docId === doc.meta.id ? tab : t)) : [...ts, tab];
    });
    setActiveTabId(doc.meta.id);
  }

  /** 关闭页签（v1.2）：仅结束浏览占位，不删库记录；活动页有未保存修改先确认 */
  async function closeTab(docId: number) {
    const cur = current();
    if (cur && cur.meta.id === docId) {
      if (dirty()) {
        // 三钮形态（与「退出 Folio」同构，需求方 2026-11-18）：「取消」关框回页签；
        // 「放弃保存」不写盘直接关；「保存并关闭」（主按钮）先落盘再关。Esc/✕/遮罩=取消。
        // 脏检查与模式无关（阅读态打勾也拦得住）。
        const r = await ui.ask({
          icon: "i-info", title: "关闭页签",
          note: "有未保存的修改，确定关闭页签吗？未保存内容将丢失。",
          notePlain: true,
          buttons: [
            { label: "放弃保存", value: "discard" },
            { label: "保存并关闭", value: "save", primary: true },
          ],
        });
        if (r === "save") {
          // UI-06：保存失败/在"另存为"里点取消 ⇒ 不关页签。此前 save 无返回，取消也照关，编辑内容丢失。
          if (!(await save())) return;
        } else if (r !== "discard") return;
        else {
          // 放弃保存：把内存态退回磁盘现状——否则脏一直挂着，稍后 switchTo 的
          // "切换文档自动保存"会把这些改动又悄悄写回磁盘，违背"放弃"承诺。
          const d = diskMap()[cur.meta.id];
          if (d !== undefined && cur.src !== d) setDoc({ ...cur, src: d });
          recomputeDirty();
        }
      }
      if (mode() === "edit" || editorSessionAlive()) endEdit();
      const all = tabs();
      const idx = all.findIndex((t) => t.docId === docId);
      const list = all.filter((t) => t.docId !== docId);
      setTabs(list);
      setActiveTabId(null);
      if (list.length === 0) {
        setCurrent(null); setDraftSrc(""); setActiveSec(null); setNavRequest(null);
        return;   // 空态：历史栈保留，后退自然重新开签
      }
      const neighbor = list[Math.max(0, Math.min(idx - 1, list.length - 1))] ?? list[0];
      await switchTo(await api.openDoc(neighbor.path), { record: true });
    } else {
      setTabs(tabs().filter((t) => t.docId !== docId));
    }
  }

  function positionOf(doc: DocFull): Position | null {
    const p = positionsMap()[doc.meta.id];
    if (!p) return null;
    // 有行锚即认（塌陷期污染的 ratio 不再拦掉恢复，二轮评审 2.3 补指的老库行则走旧门）
    const hasLine = (p.secLineOff ?? -1) >= 0 || (p.srcLine != null && p.srcLine > 0);
    return hasLine || (p.ratio > 0.02 && p.ratio < 0.98) ? p : null;
  }

  /** 打开后的「最近打开」内存增量更新（P1-5）：不再为每次打开重拉 docs/recents/roots 三张全量表。
   *  Rust 侧 open_doc 已落历史行；这里把同 id/同规范化路径的旧条目去掉并按当前时刻置顶，
   *  面板看到的顺序与下次冷启动一致。草稿路径不写历史（与 Rust record=false 同口径）。 */
  function touchRecent(meta: DocMeta) {
    if (ui.isDraftPath(meta.path)) return;
    const at = Math.floor(Date.now() / 1000);
    const norm = (p: string) => p.toLowerCase().replace(/\\/g, "/");
    setRecents((rs) => [
      { meta, openedAt: at },
      ...rs.filter((r) => r.meta.id !== meta.id && norm(r.meta.path) !== norm(meta.path)),
    ]);
  }

  async function switchTo(doc: DocFull, opts?: { secText?: string | null; record?: boolean }) {
    // 落盘「离开处」的位置（N4）。审查 v3.0 P0-3：不 await——flushPosition 的同步前缀
    // （读 current()/posSource、更新 positionsMap/history）在 await 之前就已完成，后面只剩
    // 一次 savePosition IPC；写锁忙时（扫描/optimize/VACUUM）它会把切页签整个卡住。
    // 退出链仍强制 await（quitApp/beforeunload/closeTab），最坏情况硬杀丢一次防抖窗口内的位置。
    void flushPosition();
    // v1.1：切文档必然结束编辑会话（预览文档/会话信号清空）——脏则按既有策略自动保存
    if (dirty()) await save(`切换文档：已自动保存「${current()?.meta.fileName ?? ""}」的修改`);
    else if (mode() === "edit") endEdit();
    // 双保险：即使上面走了 applySaved/无脏分支，会话与预览也不得跨文档残留
    setPreviewDoc(null);
    setEditorSessionAlive(false);
    const first = !current();
    setDisk(doc.meta.id, doc.src); // switchTo 收到的 doc 一律来自读盘（或刚落盘）链路
    setDoc(doc);
    const secText = opts?.secText ?? null;
    if (secText) {
      setNavRequest({ kind: "restore", sec: null, secText, ratio: 0 });
      // 深链 / 跨文档历史：按标题文本找到目标 sec，硬展开大纲祖先链
      revealOutline(doc.outline.find((o) => o.text === secText)?.sec);
    } else {
      const pos = positionOf(doc);
      if (pos) {
        // v1.2 主链：章节行偏移（抗标题上方增删）；无锚旧行退回 secOff/ratio 老链（方案 §4.3）
        setNavRequest(navForRestorePos(pos, doc.outline, srcLines(doc.src))
          ?? { kind: "restore", sec: pos.sec, secText: pos.secText, ratio: pos.ratio, secOff: pos.secOff });
        // 位置恢复同属「主动跳转」：旧库可能只有 secText，按文本兜一层
        revealOutline(pos.sec ?? doc.outline.find((o) => o.text === pos.secText)?.sec);
        toast(`已恢复「${doc.meta.fileName}」上次阅读位置 · ${Math.round(pos.ratio * 100)}%`);
      } else if (!first) {
        setNavRequest({ kind: "top" });
      }
    }
    // 历史导航（back/forward）不追加新条目
    if (opts?.record !== false) {
      pushHist({ docId: doc.meta.id, path: doc.meta.path, sec: null, secText, top: null, ratio: null });
    }
    // P1-5：docs 由 setDoc 增量 upsert，roots 不变，历史由 touchRecent 增量置顶——
    // 打开/切页签不再触发 list_docs + list_recents + list_roots 三次全量查询。
    // 历史导航（record:false）在 Rust 侧同样会刷新 opened_at，这里一并跟随。
    touchRecent(doc.meta);
    // 草稿找回（FR-7.7）：存在"晚于文件 mtime"的未保存草稿 → 询问恢复
    const dr = getDraft(doc.meta.path);
    if (dr && dr.at > doc.meta.mtime * 1000 + 1500 && dr.text !== doc.src) {
      const yes = (await ui.ask({
        icon: "i-info", title: "发现未保存的修改",
        sub: `「${doc.meta.fileName}」上次退出前的修改还没保存到文件`,
        note: "点「恢复修改」，内容会回到上次编辑的样子，确认后按 Ctrl+S 保存到文件；点「取消」，这些修改就丢掉了，文件保持原来的内容。",
        ok: "恢复修改",
      })) === true;
      if (yes) { setDraftSrc(dr.text); setDirty(true); toast("已找回上次未保存的修改 · 按 Ctrl+S 保存到文件"); }
      else clearDraft(doc.meta.path);
    }
  }

  /** 打开失败=文件丢失 → 该条目从「最近打开」清除（需求方 2026-11-17 定夺）；
   *  孤儿登记行（不在库非内置）随 remove_recent 一并回收。返回是否真正打开成功。 */
  async function dropMissingFromRecents(docId: number | undefined): Promise<void> {
    if (docId == null) return;
    try {
      await api.removeRecent(docId);
      void refreshDocs();
    } catch { /* 清除失败不再叠加提示：上一次「打开失败」toast 已说明问题 */ }
  }
  async function openMeta(meta: DocMeta): Promise<boolean> {
    if (current()?.meta.id === meta.id) return true;
    try {
      await switchTo(await api.openDoc(meta.path));
      return true;
    } catch (e) {
      const msg = ui.fmtErr(e);
      if (msg.includes("文件不存在")) {
        await dropMissingFromRecents(meta.id);
        toast("文件不存在或已被移动，已从最近打开清除");
      } else {
        toast("打开失败：" + msg);
      }
      return false;
    }
  }
  async function openPath(path: string, secText: string | null = null): Promise<boolean> {
    try {
      await switchTo(await api.openDoc(path), { secText });
      return true;
    } catch (e) {
      const msg = ui.fmtErr(e);
      if (msg.includes("文件不存在")) {
        const key = path.toLowerCase();
        await dropMissingFromRecents(docs().find((d) => d.path.toLowerCase() === key)?.id);
        toast("文件不存在或已被移动，已从最近打开清除");
      } else {
        toast("打开失败：" + msg);
      }
      return false;
    }
  }
  async function openSlug(slug: string, secText: string | null = null) {
    try {
      await switchTo(await api.openBySlug(slug), { secText });
    } catch {
      toast("没有找到这个文档链接对应的文件：" + slug);
    }
  }

  /** 主动跳转的硬展开：把目标祖先链写进大纲 overrides（方案 §3）。
   *  与滚动跟随的软展开分开：这里允许压过用户此前的收起，保证目标行可见、高亮不隐身。 */
  function revealOutline(sec: number | null | undefined) {
    if (sec == null) return;
    const cur = current();
    if (!cur?.outline.length) return;
    const chain = ancestorChain(buildOutlineTree(cur.outline), sec);
    if (chain?.length) ui.hardOpenOutline(chain);
    // 一次性把目标行滚入大纲视口（被动阅读滚动不再跟随/展开）
    ui.requestOutlineScroll(sec);
  }

  function requestAnchor(sec: number, record: boolean) {
    const cur = current();
    if (!cur) return;
    revealOutline(sec);
    if (record) {
      const item = cur.outline.find((o) => o.sec === sec);
      pushHist({ docId: cur.meta.id, path: cur.meta.path, sec, secText: item?.text ?? null, top: null, ratio: null });
    }
    // 编辑态：大纲点击作用于编辑器（跳源码行），并让 activeSec 立即跟随
    if (mode() === "edit" && ui.getEditorBridge()) {
      ui.getEditorBridge()!.jumpToLine(lineForSec(cur.outline, sec) ?? 0);
      setActiveSec(sec);
      return;
    }
    setNavRequest({ kind: "anchor", sec });
  }

  async function goHist(entry: HistEntry) {
    const cur = current();
    if (cur && cur.meta.id === entry.docId) {
      // 同文档：绝对位置优先 → 锚点 → 顶部（FR-5.2，判定逻辑在 nav.ts 并有单测）
      revealOutline(entry.sec);
      setNavRequest(navForHistEntrySameDoc(entry));
      return;
    }
    // 跨文档：secText 锚点优先；无锚点时 switchTo 走 positions 恢复（锚点优先、ratio 兜底）
    try {
      await switchTo(await api.openDoc(entry.path), { secText: entry.secText ?? null, record: false });
    } catch {
      toast("历史文档已不可读：" + entry.path);
    }
  }

  async function back() {
    if (histIdx() <= 0) return;
    await flushPosition();
    setHistIdx(histIdx() - 1);
    await goHist(history[histIdx()]);
  }
  async function forward() {
    if (histIdx() >= history.length - 1) return;
    await flushPosition();
    setHistIdx(histIdx() + 1);
    await goHist(history[histIdx()]);
  }

  /* ── 编辑 ── */
  function endEdit() {
    // 退出编辑：把编辑器当前小数行号交接给阅读视图（v1.2 一把尺；无标题文档同样可交接——R4 闭环）
    const l = ui.getEditorBridge()?.topLine() ?? null;
    cancelDraftTimers();
    // 结束编辑会话（v1.1）：编辑器卸载，历史随之清空；预览文档一并作废
    setPreviewDoc(null);
    setEditorSessionAlive(false);
    setMode("read");
    setDirty(false);
    if (l != null) setNavRequest({ kind: "line", line: l });
  }
  function enterEdit() {
    if (!current()) return;
    // 进入编辑：阅读视口的顶行号暂存（EditorPane 挂载消费）
    ui.setPendingEditorJump(ui.getViewBridge()?.topLine() ?? null);
    setDraftSrc(displayDoc()?.src ?? current()!.src);   // 预览态进编辑：以草稿为准
    setPreviewDoc(null);                                // 编辑器成为唯一事实来源
    setEditorSessionAlive(true);
    setMode("edit");
    // 不能清脏：进编辑前可能已有打勾待存（缓冲此刻即 cur.src，recompute 结果不变）
    recomputeDirty();
  }
  /** 预览阅读（v1.1）：不写盘、不结束会话；编辑器和历史隐藏保留，阅读窗展示草稿渲染 */
  function previewEdit() {
    const b = ui.getEditorBridge();
    const cur = current();
    if (!b || !cur) { endEdit(); return; }   // 兜底：无桥按原链路退出
    const text = b.docText();
    const line = b.topLine();
    cancelDraftTimers();
    setDraftSrc(text);                        // 防抖快照以最新编辑器文本为准
    setPreviewDoc(buildPreviewDoc(cur, text));
    setMode("read");
    if (line != null) setNavRequest({ kind: "line", line });
    recomputeDirty();                         // 脏标记 = 预览文本 vs 磁盘
  }
  /** 从预览返回编辑：恢复同一编辑器（历史/选区/滚动由 CodeMirror 保留），清掉预览文档 */
  function resumeEdit() {
    if (!editorSessionAlive()) { enterEdit(); return; }
    setPreviewDoc(null);
    setMode("edit");
    recomputeDirty();
    ui.getEditorBridge()?.focusEditor();
  }
  /** 仅退回阅读态：不保存、不丢弃、不动脏标记。
   *  与 endEdit 的区别是后者会清 dirty（那是保存/放弃链路的语义），
   *  这里用于「编辑器没挂载成功」的退路——阅读态待存的打勾不能被顺手抹掉。 */
  function cancelEdit() {
    // 编辑器没挂载成功的退路：会话与预览一并作废（否则预览文档会挂在没有编辑器的状态）
    setPreviewDoc(null);
    setEditorSessionAlive(false);
    setMode("read");
    recomputeDirty();
  }
  function toggleEdit() {
    // v1.1：编辑 → 阅读 = 预览（不写盘、保留历史）；阅读 → 编辑 = 恢复同一会话（无会话才新建）
    if (mode() === "edit") previewEdit();
    else resumeEdit();
  }
  let draftTimer: number | undefined;
  let draftSyncTimer: number | undefined;
  function cancelDraftTimers() {
    if (draftTimer !== undefined) { window.clearTimeout(draftTimer); draftTimer = undefined; }
    if (draftSyncTimer !== undefined) { window.clearTimeout(draftSyncTimer); draftSyncTimer = undefined; }
  }
  /** 当前编辑正文：保存/另存为必须取编辑器实时文本，不能等防抖快照（否则 Ctrl+S 会写旧文） */
  function editText(): string {
    // v1.1：会话期内（编辑或预览）一律取编辑器实时文本，保存/另存为/格式化不读旧文
    if (mode() === "edit" || editorSessionAlive()) {
      const t = ui.getEditorBridge()?.docText();
      if (t != null) return t;
    }
    return draftSrc();
  }
  function setDraft(v: string) {
    setDraftSrc(v);
    const cur = current();
    const changed = v !== (cur?.src ?? "");
    recomputeDirty();   // 脏=缓冲 vs 落盘现状（打勾挂脏时打字再回删，脏仍真，§6.4）
    if (cur && changed) {
      window.clearTimeout(draftTimer);
      draftTimer = window.setTimeout(() => persistDraft(cur.meta.path, v), 400);
    }
  }
  /** P1-3：按键热路径只做两件事——脏标记立即亮、全文快照合并到 250ms 后取一次。
   *  此前每个 docChanged 都 toString() + 全文比较 + 400ms 后整篇写 localStorage，
   *  600KB 文档连续输入时每键都在复制/比较整篇。 */
  function markDraftChanged() {
    if (!dirty()) setDirty(true);
    window.clearTimeout(draftSyncTimer);
    draftSyncTimer = window.setTimeout(() => {
      draftSyncTimer = undefined;
      const t = ui.getEditorBridge()?.docText();
      if (t != null) setDraft(t);
    }, 250);
  }
  async function save(customMsg?: string, force = false): Promise<boolean> {
    const cur = current();
    if (!cur) return false;
    /* 新建文档草稿的首次保存：2026-11-17 起改弹 Windows 原生「另存为」系统对话框（同名覆盖由系统确认）→
     * 写入目标路径 → 切换登记 → 关闭草稿页签并清理 drafts/ 临时文件。取消=不保存，留在编辑中。 */
    if (ui.isDraftPath(cur.meta.path)) {
      const path = await api.pickSaveDoc(cur.meta.fileName, roots()[0] ?? null);
      if (!path) return false;
      const res = { path, name: path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path };
      const draftId = cur.meta.id, draftPath = cur.meta.path;
      try {
        await api.writeFile(res.path, editText());
        const next = await api.openDoc(res.path);
        cancelDraftTimers();
        clearDraft(draftPath); ui.clearDraftPath(draftPath);
        // CON-04：草稿已写入目标 ⇒ 先清脏标记再切换。此前 dirty 仍为 true，
        // switchTo 的"切前自动保存"会对草稿路径二次写盘 + 重登 documents 行，
        // 于是留下指向已删临时文件的死历史条目。
        setDirty(false);
        await switchTo(next);
        endEdit();
        if (tabs().some((t) => t.docId === draftId)) void closeTab(draftId);
        // Rust 侧 delete_scratch 现在连登记行（历史/进度/FTS）一并回收
        void api.deleteScratch(draftPath).catch(() => undefined);
        toast(`已保存为 ${res.name}`);
        return true;
      } catch (e) {
        toast("保存失败：" + ui.fmtErr(e));
        return false;
      }
    }
    try {
      const next = await api.saveDoc(cur.meta.path, editText(), force, cur.encoding);
      cancelDraftTimers();               // 防抖快照/草稿写入不得在保存后再把旧文本写回 localStorage
      setDisk(next.meta.id, next.src);   // 写盘成功 ⇒ 磁盘现状前移，脏自然归零
      if (mode() === "edit" || editorSessionAlive()) {
        // 编辑态或预览态（v1.1）：显式保存 = 提交并结束编辑会话（endEdit 同时清预览文档）
        setDoc(next);
        endEdit();
      } else {
        applySaved(next);                // 阅读态（打勾待存被「保存」）：原位重渲染不跳顶
      }
      clearDraft(cur.meta.path);
      toast(customMsg ?? "已保存到文件");
      return true;
    } catch (e) {
      const msg = String(e);
      if (msg.includes("CONFLICT") && !force) {
        // FR-7.5：外部并发编辑 → 重新加载 / 覆盖 二选一；取消/Esc/✕/遮罩 = 零副作用（§8.6）
        const pick = await ui.ask({
          icon: "i-info", title: "文件已被其他程序改动",
          note: "这份文件在 Folio 之外被改过了。你想保留哪一个版本？",
          buttons: [
            { label: "重新加载", value: "reload", primary: true },
            { label: "用我的内容覆盖", value: "overwrite" },
          ],
        });
        if (pick === "reload") { setDraftSrc(cur.src); setDirty(false); await openPath(cur.meta.path); return true; }
        if (pick === "overwrite") return await save(customMsg, true);
        return false;
      }
      toast("保存失败：" + ui.fmtErr(msg));
      return false;
    }
  }
  function discard() {
    const cur = current();
    if (!cur) return;
    cancelDraftTimers();   // 丢弃后待触发的快照/草稿写入必须一起作废
    // v1.1：从磁盘基线恢复（预览期间 cur 仍是磁盘版本；diskMap 为权威兜底）
    setDraftSrc(diskMap()[cur.meta.id] ?? cur.src);
    endEdit();
    clearDraft(cur.meta.path);
    recomputeDirty();  // Esc 只弃编辑缓冲；阅读态挂账的打勾不属于"编辑修改"，保留待存
    toast(dirty() ? "已放弃编辑修改；刚勾选的改动还没保存" : "已放弃未保存修改，返回阅读模式");
  }
  /** Ctrl+S / 菜单「保存」统一入口（§6.4）：编辑态=保存并返回阅读；
   *  阅读态有待存改动（打勾）→ 写盘；干净 → 如实告知无事可存。 */
  async function saveSmart(): Promise<boolean> {
    if (!current()) return false;
    if (mode() === "edit" || dirty()) return await save();
    toast("当前没有待保存的修改");
    return false;
  }
  /** 页签原位替换：删旧文档页签，把新文件页签挪到旧位置（setDoc upsert 已将其追加在尾）。 */
  function retargetTab(oldId: number, newId: number) {
    setTabs((ts) => {
      if (oldId === newId) return ts;
      const oi = ts.findIndex((t) => t.docId === oldId);
      if (oi < 0) return ts;
      const without = ts.filter((t) => t.docId !== oldId);
      const ni = without.findIndex((t) => t.docId === newId);
      if (ni < 0) return without;
      const list = without.slice();
      const [tab] = list.splice(ni, 1);
      list.splice(Math.min(oi, list.length), 0, tab);
      return list;
    });
  }
  /** 另存为（需求方 2026-11-18 样例定夺「A 语义」）：当前内容（编辑态取缓冲）写到所选新路径，
   *  当前页签原位切到新文件；原文件磁盘内容不动。行位置按同文坐标平移保持。
   *  取消=零打扰；同名覆盖由系统对话框确认；失败「另存为失败：原因」。 */
  async function saveAs(): Promise<boolean> {
    const cur = current();
    if (!cur) return false;
    if (ui.isDraftPath(cur.meta.path)) return await save(); // 草稿的另存为=首次保存（既有链路）
    const content = (mode() === "edit" || editorSessionAlive()) ? editText() : cur.src;
    const dir = cur.meta.path.replace(/[\\/][^\\/]*$/, "");
    const path = await api.pickSaveDoc(cur.meta.fileName, dir || (roots()[0] ?? null));
    if (!path) return false;
    const line = mode() === "edit"
      ? (ui.getEditorBridge()?.topLine() ?? null)
      : (ui.getViewBridge()?.topLine() ?? null);
    try {
      const norm = (p: string) => p.replace(/[\\/]+/g, "/").toLowerCase();
      if (norm(path) === norm(cur.meta.path)) {
        // 选回原路径＝就地覆盖：写盘即磁盘现状前移，不切页签（编码随来源，GBK 文档不被转码）
        await api.writeFile(path, content, cur.encoding);
        setDisk(cur.meta.id, content);
        if (mode() === "edit") { setDraftSrc(content); endEdit(); } else recomputeDirty();
        toast(`已另存为 ${cur.meta.fileName}`);
        return true;
      }
      await api.writeFile(path, content, cur.encoding);
      const next = await api.openDoc(path);
      const oldId = cur.meta.id;
      if (mode() === "edit") endEdit();
      else setDirty(false);            // 必须先归零再 switchTo：防其脏自动保存把副本又写回原文件
      await switchTo(next);
      retargetTab(oldId, next.meta.id);
      if (line != null) setNavRequest({ kind: "line", line });
      toast(`已另存为 ${next.meta.fileName}`);
      return true;
    } catch (e) {
      toast("另存为失败：" + ui.fmtErr(e));
      recomputeDirty();                // 半途失败（如 openDoc 出错）：挂账的打勾/编辑仍须可见
      return false;
    }
  }
  /** 复选框写回等「非用户编辑」的内容变化：原位重渲染，不跳顶。
   *  v1.2：主坐标走行锚链（勾选只动一行内容不改行号，line 天然稳）；无锚才退 ratio 老链（二轮评审 2.3） */
  async function applySaved(next: DocFull) {
    const p = posSource ? posSource() : null;
    setDoc(next);
    recomputeDirty();  // 本函数语义=「内存已改、磁盘未动」：脏必须如实挂起（打勾手动保存链路）
    if (!p) return;
    // 本函数全部调用方都是「版式不变」的内存更新（勾选翻转）：用采集瞬间的原始 scrollTop 复位。
    // line↔px 换算互非逆（pxFromLine 以块自身 bottom 插值、lineFromAnchors 以 next.top 采样），
    // 走 line 链每击向块顶滑移 f×块间距并累积——真窗口取证 3~4px/击，即「连续勾选持续上滚」根因。
    if ((p.scrollY ?? -1) >= 0) setNavRequest({ kind: "pixel", y: p.scrollY! });
    else {
      const lineNav = navForRestorePos(p, next.outline, srcLines(next.src));
      if (lineNav) setNavRequest(lineNav);
      else if (p.ratio > 0.001) {
        setNavRequest({ kind: "restore", sec: p.sec, secText: p.secText, ratio: p.ratio, secOff: p.secOff });
      }
    }
  }

  /** 源码格式化后的内存更新（《Folio 源码自动格式化方案》§6）：
   *  格式化会增删空行，标题行号随之变化——大纲与统计必须按新文本一次换掉，
   *  否则阅读位置/深链仍落在旧行号上。只改内存，不写盘（手动保存纪律）。 */
  function applyFormatted(r: FormatResult) {
    const cur = current();
    if (!cur) return;
    cancelDraftTimers();   // 格式化前的防抖快照不得把旧文本写回草稿
    // 格式化可能增删空行 → sec/行号整体平移：大纲真变了才清空折叠状态
    if (outlineSig(cur.outline) !== outlineSig(r.outline)) ui.resetOutlineFold();
    const meta: DocMeta = {
      ...cur.meta,
      wordCount: r.wordCount,
      headCount: r.headCount,
      secCount: r.secCount,
      title: r.title ?? cur.meta.title,   // 首行由 "#标题" 变 "# 标题" 时标题即刻跟上
    };
    setCurrent({ ...cur, meta, src: r.text, outline: r.outline });
    setDocs((ds) => ds.map((d) => (d.id === meta.id ? meta : d)));
    setRecents((rs) => rs.map((ent) => (ent.meta.id === meta.id ? { ...ent, meta } : ent)));
    setDraftSrc(r.text);
    recomputeDirty();
    // 格式化结果同样纳入异常退出找回（与编辑输入同一条 400ms 防抖）
    draftTimer = window.setTimeout(() => persistDraft(meta.path, r.text), 400);
  }

  /* ── 目录树「重命名」成功后的内存同步（《Folio-目录树文件重命名方案》§4.3）──
   * IPC 已把磁盘与登记行改完（doc_id 不变）；这里只换各信号里的路径类元数据：
   * 清单/历史行/页签/当前文档。进度（positionsMap 按 id）、脏标记（diskMap 按 id）、
   * 编辑器缓冲全部不动。异常找回草稿按 path 存，必须跟文件搬家，否则重启后
   * 「检测到未保存修改」找不到新家。 */
  function applyRenamed(oldPath: string, next: DocMeta) {
    setDocs((ds) => ds.map((d) => (d.id === next.id ? next : d)));
    setRecents((rs) => rs.map((ent) => (ent.meta.id === next.id ? { ...ent, meta: next } : ent)));
    setTabs((ts) => ts.map((t) => (t.docId === next.id ? { ...t, path: next.path, fileName: next.fileName } : t)));
    const cur = current();
    if (cur && cur.meta.id === next.id) setCurrent({ ...cur, meta: { ...cur.meta, ...next } });
    try {
      const raw = localStorage.getItem(DRAFT_PREFIX + oldPath);
      if (raw) {
        localStorage.setItem(DRAFT_PREFIX + next.path, raw);
        localStorage.removeItem(DRAFT_PREFIX + oldPath);
      }
    } catch { /* 配额：草稿搬家失败不拦重命名本身 */ }
  }

  /* ── 文件夹「重命名」成功后的内存同步（增强 2026-11-20）──
   * Rust 已把磁盘与 documents/roots 的路径前缀换完（doc_id/slug 不动）；这里对同样几处信号
   * 做前缀搬运：清单、历史行、页签、当前文档、按路径存的异常找回草稿，外加 settings.libraryRoot。
   * 正文缓冲、脏标记、阅读进度、大纲折叠（按 sec）全部不受影响。 */
  function applyRenamedFolder(oldDir: string, newDir: string) {
    const remap = (d: DocMeta): DocMeta => {
      const path = swapPathPrefix(d.path, oldDir, newDir);
      if (!path) return d;
      const sep = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
      return { ...d, path, dir: sep > 0 ? path.slice(0, sep) : d.dir, fileName: sep >= 0 ? path.slice(sep + 1) : d.fileName };
    };
    setDocs((ds) => ds.map(remap));
    setRecents((rs) => rs.map((ent) => {
      const m = remap(ent.meta);
      return m === ent.meta ? ent : { ...ent, meta: m };
    }));
    setTabs((ts) => ts.map((t) => {
      const path = swapPathPrefix(t.path, oldDir, newDir);
      if (!path) return t;
      const sep = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
      return { ...t, path, fileName: sep >= 0 ? path.slice(sep + 1) : t.fileName };
    }));
    const cur = current();
    if (cur) {
      const meta = remap(cur.meta);
      if (meta !== cur.meta) setCurrent({ ...cur, meta });
    }
    const lr = settings().libraryRoot;
    if (lr) {
      const nl = swapPathPrefix(lr, oldDir, newDir);
      if (nl && nl !== lr) saveSettings({ libraryRoot: nl });
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(DRAFT_PREFIX)) continue;
        const np = swapPathPrefix(key.slice(DRAFT_PREFIX.length), oldDir, newDir);
        if (np && np !== key.slice(DRAFT_PREFIX.length)) {
          const raw = localStorage.getItem(key);
          if (raw != null) {
            localStorage.setItem(DRAFT_PREFIX + np, raw);
            localStorage.removeItem(key);
          }
        }
      }
    } catch { /* 配额：同 applyRenamed 口径 */ }
  }

  /* ── 设置写入（P1-6）：拖动滑杆时内存/CSS 立即变，SQLite 写入合并 250ms ──
   * 此前每个 input 事件都 invoke("set_settings") 一次：拖一次滑杆几十次 IPC+DB 写，
   * 与扫描/搜索争用写锁。现在只保留最后一次快照；松手/关面板/退出时 flush。
   * 写入串行化，保证后一次 flush 不会先于前一次落库（极端快速开关面板时顺序不反）。 */
  let settingsTimer: number | undefined;
  let pendingSettings: Settings | null = null;
  let settingsWrite: Promise<void> = Promise.resolve();
  function flushSettings(): Promise<void> {
    if (settingsTimer !== undefined) { window.clearTimeout(settingsTimer); settingsTimer = undefined; }
    const next = pendingSettings;
    pendingSettings = null;
    if (!next) return settingsWrite;
    settingsWrite = settingsWrite
      .then(() => api.setSettings(next))
      .catch(() => undefined);
    return settingsWrite;
  }
  function saveSettings(patch: Partial<Settings>) {
    const next = { ...settings(), ...patch };
    setSettings(next);
    pendingSettings = next;
    if (settingsTimer !== undefined) window.clearTimeout(settingsTimer);
    settingsTimer = window.setTimeout(() => {
      settingsTimer = undefined;
      flushSettings();
    }, 250);
  }

  /** 三份清单一起刷：库面板 / 最近打开 / 库根 chips 各自的数据源，一次往返成套（失败不打扰）。
   *  请求序号守卫（PERF-02 顺手项）：快速切文档时旧响应可能晚到覆盖新状态，只应用最后一次请求。 */
  let refreshSeq = 0;
  async function refreshDocs() {
    const seq = ++refreshSeq;
    const [list, rc, rs] = await Promise.all([
      api.listDocs().catch(() => null),
      api.listRecents().catch(() => null),
      api.listRoots().catch(() => null),
    ]);
    if (seq !== refreshSeq) return;
    if (list) setDocs(list);
    if (rc) setRecents(rc);
    if (rs) setRoots(rs);
  }

  function toggleFocus() {
    setFocusMode((f) => !f);
  }
  function clearNav() {
    setNavRequest(null);
  }

  /* ── 启动（性能 P0-4 + P2-5：四个独立读并行往返，list 就绪后才能 openDoc） ── */
  onMount(async () => {
    const [st, posList, list, rc, rs, pending] = await Promise.all([
      api.getSettings().catch(() => null),
      api.getPositions().catch(() => null),
      api.listDocs().catch(() => [] as DocMeta[]),
      api.listRecents().catch(() => [] as RecentDoc[]),
      api.listRoots().catch(() => [] as string[]),
      api.drainPending().catch(() => [] as string[]),
    ]);
    if (st) setSettings(st);
    if (posList) setPositionsMap(Object.fromEntries(posList));
    setDocs(list);
    setRecents(rc);
    setRoots(rs);
    // 启动恢复=上次「打开过」的那篇（历史序），不是磁盘上最新改动的那篇（mtime 序）。
    // 历史为空（首启/仅扫描未打开）才回落到登记表首条。
    const restore = rc[0]?.meta ?? list[0];
    // 「启动时恢复上次文档」开关（设置 §4.8，需求方 2026-11-18）：关→空态直进、加快冷启动；
    // 深链/拖放 pending 在下方照常处理，不受开关影响（那是用户动作，不是自动恢复）。
    // bug 2026-11-22：WebView 刷新（原生右键菜单/快捷键）会整页重载——那不是冷启动，
    // 开关=关时也不能把用户正读着的文档落回空态；判定口径见 boot.shouldRestoreOnBoot。
    if (restore && shouldRestoreOnBoot(settings().restoreOnLaunch, bootNavType())) {
      try {
        const doc = await api.openDoc(restore.path);
        setDisk(doc.meta.id, doc.src);
        setDoc(doc);
        const pos = positionOf(doc);
        if (pos) {
          // 启动恢复同属主动跳转：硬展开目标章节祖先链，高亮不在收起的树里隐身
          revealOutline(pos.sec ?? doc.outline.find((o) => o.text === pos.secText)?.sec);
          setNavRequest({ kind: "restore", sec: pos.sec, secText: pos.secText, ratio: pos.ratio, secOff: pos.secOff });
        }
        pushHist({ docId: doc.meta.id, path: doc.meta.path, sec: null, secText: null, top: null, ratio: null });
      } catch {
        /* 启动恢复目标已丢失：同规则清出历史（不声张，空态自洽），下次恢复看下一条 */
        await dropMissingFromRecents(restore.id);
      }
    }
    // 审查 v3.0 P2-2：骨架揭幕推迟到「首帧绘制之后」。setDoc 只更新信号，Reader 的
    // mdToHtml/innerHTML/布局/绘制还在后面的 effect + 双 rAF 里；立即揭幕会先露约 0.5 s 空阅读区。
    // 双 rAF 等一次真实绘制完成（与 Reader 计时口径一致），main.tsx 另有 5 s 兜底不受影响。
    requestAnimationFrame(() => requestAnimationFrame(dismissSplash));
    try {
      for (const raw of pending) {
        if (raw.startsWith("folio://")) {
          const q = new URLSearchParams(raw.split("?")[1] ?? "");
          const sec = q.get("sec");
          const path = q.get("doc");
          if (path && (path.includes("\\") || path.includes("/") || path.endsWith(".md"))) await openPath(path, sec);
          else if (path) await openSlug(path, sec);
        } else {
          await openPath(raw);
        }
      }
    } catch {
      /* ignore */
    }
    void listenTauriOpen();
    window.addEventListener("beforeunload", () => { void flushPosition(); flushSettings(); });
    // 调试通道（FR-8.3 对应物）：#doc=<slug>[&sec=<标题>] 实时定位（正式版生产用 folio://）
    window.addEventListener("hashchange", () => {
      const raw = location.hash.replace(/^#/, "");
      if (!raw) return;
      const q = new URLSearchParams(raw);
      const slug = q.get("doc");
      if (!slug) return;
      void openSlug(slug, q.get("sec")); // 未命中由 openSlug 自带提示；调试语义不劫持常规导航
    });
  });

  function listenTauriOpen() {
    if (!api.isTauriRuntime()) return;
    void import("./api").then(({ listenOpenEvent, onCloseRequest }) => {
      listenOpenEvent(async (req) => {
        if (req.path) await openPath(req.path, req.sec);
        else if (req.slug) await openSlug(req.slug, req.sec);
      });
      // UI-02：Alt+F4/任务栏关闭被 Rust 拦成事件打回前端——走与标题栏 ✕ 完全相同的
      // 「落盘位置 → 脏检查 → 确认 → destroy」流程；用户在确认框点取消则窗口保持打开。
      onCloseRequest(() => { void quitApp(store); });
    });
  }

  const store: Store = {
    docs, recents, roots, current, displayDoc, editorSessionAlive, settings, positionsMap,
    mode, dirty, side, focusMode, activeSec, toasts, navRequest, histIdx, histLen: () => history.length, draftSrc,
    tabs, activeTabId, closeTab,
    refreshDocs, openMeta, openPath, openSlug, requestAnchor, revealOutline,
    enterEdit, toggleEdit, cancelEdit, pushHist, setDraft, markDraftChanged, save, saveSmart, saveAs, discard, applySaved, applyFormatted, applyRenamed, applyRenamedFolder,
    saveSettings, flushSettings, setSide, toggleFocus, toast, setActiveSec,
    schedulePosition, flushPosition, providePositionSource,
    back, forward, clearNav,
    isTauri: api.isTauriRuntime(),
  };

  return <Ctx.Provider value={store}>{props.children}</Ctx.Provider>;
}
