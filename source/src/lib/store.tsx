/* 全局状态：Solid signals + 导航历史 + 位置存储 + toast 队列。
 * 内置评审教训：
 *  - N1 toast 队列化，关键通知不被后续 toast 吞掉；
 *  - N4 位置防抖只是省写入，任何导航/关闭前必须 flush；
 *  - 编辑/阅读共享同一份草稿（draftSrc），复选框与编辑器不竞写。 */
import {
  createContext, useContext, createSignal, onMount, type JSX, type ParentProps,
} from "solid-js";
import { api } from "./api";
import { DEFAULT_SETTINGS } from "./defaults";
import type { DocFull, DocMeta, HistEntry, Position, RecentDoc, Settings } from "./types";

import { navForHistEntrySameDoc, type NavRequest } from "./nav";
import { confirmBox, quitApp } from "./actions";
import * as ui from "./ui";
import { dismissSplash } from "./boot";

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
  /** 返回是否打开成功（失败=文件丢失时条目自动移出最近打开，2026-11-17 定夺） */
  openMeta(meta: DocMeta): Promise<boolean>;
  openPath(path: string, secText?: string | null): Promise<boolean>;
  openSlug(slug: string, secText?: string | null): Promise<void>;
  requestAnchor(sec: number, record: boolean): void;
  enterEdit(): void;
  toggleEdit(): void;
  pushHist(e: HistEntry): void;
  setDraft(v: string): void;
  /** 保存。返回 false = 未保存成功（取消对话框/写盘失败），调用方（如 closeTab）必须据此中止后续动作 */
  save(customMsg?: string, force?: boolean): Promise<boolean>;
  discard(): void;
  applySaved(next: DocFull): void;
  saveSettings(patch: Partial<Settings>): void;
  setSide(v: SideView): void;
  toggleFocus(): void;
  toast(text: string): void;
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

  /* ── toast 队列（N1）：同屏最多 2 条，其余排队 ── */
  const queue: string[] = [];
  function pump() {
    if (queue.length === 0 || toasts().length >= 2) return;
    const text = queue.shift()!;
    const item = { id: ++toastSeq, text };
    setToasts((t) => [...t, item]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== item.id));
      window.setTimeout(pump, 180);
    }, 2600);
  }
  function toast(text: string) {
    if (toasts().some((t) => t.text === text) || queue.includes(text)) return;
    queue.push(text);
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
    const p = posSource();
    if (!cur || !p) return;
    setPositionsMap((m) => ({ ...m, [cur.meta.id]: p }));
    const h = history[histIdx()];
    if (h && h.docId === cur.meta.id) {
      h.ratio = p.ratio;
      h.sec = p.sec;
      h.secText = p.secText;
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
      if (mode() === "edit") {
        if (dirty()) {
          const ok = await confirmBox("此文档有未保存的修改。\n确定 = 保存并关闭页签；取消 = 留在编辑中继续。", "关闭页签");
          if (!ok) return;
          // UI-06：保存失败/在"另存为"里点取消 ⇒ 不关页签。此前 save 无返回，取消也照关，编辑内容丢失。
          if (!(await save())) return;
        } else {
          endEdit();
        }
      }
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
    return p && p.ratio > 0.02 && p.ratio < 0.98 ? p : null;
  }

  async function switchTo(doc: DocFull, opts?: { secText?: string | null; record?: boolean }) {
    await flushPosition(); // 落盘「离开处」的位置（N4）
    if (mode() === "edit") {
      if (dirty()) await save(`切换文档：已自动保存「${current()?.meta.fileName ?? ""}」的修改`);
      else endEdit();
    }
    const first = !current();
    setDoc(doc);
    const secText = opts?.secText ?? null;
    if (secText) {
      setNavRequest({ kind: "restore", sec: null, secText, ratio: 0 });
    } else {
      const pos = positionOf(doc);
      if (pos) {
        setNavRequest({ kind: "restore", sec: pos.sec, secText: pos.secText, ratio: pos.ratio, secOff: pos.secOff });
        toast(`已恢复「${doc.meta.fileName}」上次阅读位置 · ${Math.round(pos.ratio * 100)}%`);
      } else if (!first) {
        setNavRequest({ kind: "top" });
      }
    }
    // 历史导航（back/forward）不追加新条目
    if (opts?.record !== false) {
      pushHist({ docId: doc.meta.id, path: doc.meta.path, sec: null, secText, top: null, ratio: null });
    }
    void refreshDocs();
    // 草稿找回（FR-7.7）：存在"晚于文件 mtime"的未保存草稿 → 询问恢复
    const dr = getDraft(doc.meta.path);
    if (dr && dr.at > doc.meta.mtime * 1000 + 1500 && dr.text !== doc.src) {
      const yes = await confirmBox("检测到上次未保存的草稿（晚于磁盘文件）。\n确定 = 恢复草稿进入待保存状态；取消 = 丢弃草稿。", "未保存草稿");
      if (yes) { setDraftSrc(dr.text); setDirty(true); toast("已恢复草稿 · Ctrl+S 落盘 / Esc 放弃"); }
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
      toast("深度链接未命中：" + slug);
    }
  }

  function requestAnchor(sec: number, record: boolean) {
    const cur = current();
    if (!cur) return;
    if (record) {
      const item = cur.outline.find((o) => o.sec === sec);
      pushHist({ docId: cur.meta.id, path: cur.meta.path, sec, secText: item?.text ?? null, top: null, ratio: null });
    }
    // 编辑态：大纲点击作用于编辑器（跳源码行），并让 activeSec 立即跟随
    if (mode() === "edit" && ui.getEditorBridge()) {
      ui.getEditorBridge()!.jumpTo(sec, 0);
      setActiveSec(sec);
      return;
    }
    setNavRequest({ kind: "anchor", sec });
  }

  async function goHist(entry: HistEntry) {
    const cur = current();
    if (cur && cur.meta.id === entry.docId) {
      // 同文档：绝对位置优先 → 锚点 → 顶部（FR-5.2，判定逻辑在 nav.ts 并有单测）
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
    // 退出编辑：把编辑器当前"章节+行内比例"交接给阅读视图（滚动同步）
    const ef = ui.getEditorBridge()?.topFrac() ?? null;
    setMode("read");
    setDirty(false);
    if (ef && ef.sec != null) setNavRequest({ kind: "secFrac", sec: ef.sec, frac: ef.frac });
  }
  function enterEdit() {
    if (!current()) return;
    // 进入编辑：把阅读视图当前"章节+像素比例"换算成行比例暂存（EditorPane 挂载消费）
    const vf = ui.getViewBridge()?.secFrac() ?? null;
    ui.setPendingEditorJump(vf);
    setDraftSrc(current()!.src);
    setMode("edit");
    setDirty(false);
  }
  function toggleEdit() {
    if (mode() === "edit") {
      if (dirty()) void save();
      else endEdit();
    } else {
      enterEdit();
    }
  }
  let draftTimer: number | undefined;
  function setDraft(v: string) {
    setDraftSrc(v);
    const cur = current();
    const changed = v !== (cur?.src ?? "");
    setDirty(changed);
    if (cur && changed) {
      window.clearTimeout(draftTimer);
      draftTimer = window.setTimeout(() => persistDraft(cur.meta.path, v), 400);
    }
  }
  async function save(customMsg?: string, force = false): Promise<boolean> {
    const cur = current();
    if (!cur) return false;
    /* 新建文档草稿的首次保存（2026-11-16）：弹「保存」对话框（§8.6 同款 UI）确认文件名与目录 →
     * 写入目标路径 → 切换登记 → 关闭草稿页签并清理 drafts/ 临时文件。取消=不保存，留在编辑中。 */
    if (ui.isDraftPath(cur.meta.path)) {
      const res = await ui.runSaveAs(cur.meta.fileName, roots()[0] ?? null);
      if (!res) return false;
      const draftId = cur.meta.id, draftPath = cur.meta.path;
      try {
        await api.writeFile(res.path, draftSrc());
        const next = await api.openDoc(res.path);
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
      const next = await api.saveDoc(cur.meta.path, draftSrc(), force);
      setDoc(next);
      endEdit();
      clearDraft(cur.meta.path);
      toast(customMsg ?? "已保存并写回磁盘");
      return true;
    } catch (e) {
      const msg = String(e);
      if (msg.includes("CONFLICT") && !force) {
        // FR-7.5：外部并发编辑 → 重新加载 / 覆盖 二选一
        const reload = await confirmBox(
          "文件在本编辑器之外被修改过。\n确定 = 重新加载磁盘版本（丢弃当前缓冲）；取消 = 以当前内容覆盖磁盘。",
          "保存冲突");
        if (reload) { setDraftSrc(cur.src); setDirty(false); await openPath(cur.meta.path); return true; }
        return await save(customMsg, true);
      }
      toast("保存失败：" + ui.fmtErr(msg));
      return false;
    }
  }
  function discard() {
    const cur = current();
    if (!cur) return;
    setDraftSrc(cur.src);
    endEdit();
    clearDraft(cur.meta.path);
    toast("已放弃未保存修改，返回阅读模式");
  }
  /** 复选框写回等「非用户编辑」的内容变化：原位重渲染，不跳顶 */
  async function applySaved(next: DocFull) {
    const p = posSource ? posSource() : null;
    setDoc(next);
    if (p && p.ratio > 0.001) {
      setNavRequest({ kind: "restore", sec: p.sec, secText: p.secText, ratio: p.ratio, secOff: p.secOff });
    }
  }

  function saveSettings(patch: Partial<Settings>) {
    const next = { ...settings(), ...patch };
    setSettings(next);
    void api.setSettings(next).catch(() => undefined);
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
    if (restore) {
      try {
        const doc = await api.openDoc(restore.path);
        setDoc(doc);
        const pos = positionOf(doc);
        if (pos) setNavRequest({ kind: "restore", sec: pos.sec, secText: pos.secText, ratio: pos.ratio, secOff: pos.secOff });
        pushHist({ docId: doc.meta.id, path: doc.meta.path, sec: null, secText: null, top: null, ratio: null });
      } catch {
        /* 启动恢复目标已丢失：同规则清出历史（不声张，空态自洽），下次恢复看下一条 */
        await dropMissingFromRecents(restore.id);
      }
    }
    dismissSplash(); // 内容决策已定（正文上屏 / 空态），揭幕
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
    window.addEventListener("beforeunload", () => void flushPosition());
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
    docs, recents, roots, current, settings, positionsMap,
    mode, dirty, side, focusMode, activeSec, toasts, navRequest, histIdx, histLen: () => history.length, draftSrc,
    tabs, activeTabId, closeTab,
    refreshDocs, openMeta, openPath, openSlug, requestAnchor,
    enterEdit, toggleEdit, pushHist, setDraft, save, discard, applySaved,
    saveSettings, setSide, toggleFocus, toast, setActiveSec,
    schedulePosition, flushPosition, providePositionSource,
    back, forward, clearNav,
    isTauri: api.isTauriRuntime(),
  };

  return <Ctx.Provider value={store}>{props.children}</Ctx.Provider>;
}
