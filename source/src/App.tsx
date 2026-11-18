import { createEffect, createSignal, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { useStore } from "./lib/store";
import { api } from "./lib/api";
import * as ui from "./lib/ui";
import { newDoc, pickAndOpen, quitApp } from "./lib/actions";
import Icons from "./components/Icons";
import TitleBar from "./components/TitleBar";
import { Rail, LibraryPanel, RecentsPanel, OutlinePanel, PaneBar, CrumbBar, StatusBar } from "./components/SidePanels";
import Reader from "./components/Reader";
import Splitter from "./components/Splitter";
/* 编辑器拆包懒加载（性能 P0-2）：CodeMirror 不再进入入口 bundle，首次进入编辑模式才拉取 */
const EditorPane = lazy(() => import("./components/EditorPane"));
import SearchPalette from "./components/SearchPalette";
import { AboutModal, ContextMenu, CopyPop, DropVeil, ExportBusy, HitNav, ImgBox, KeysModal, PropsModal } from "./components/Overlays";
import SettingsPanel from "./components/SettingsPanel";
import AskDialog from "./components/AskDialog";
import { typeVars } from "./lib/typography";
import { applyAccent } from "./lib/accent";
import ToastZone from "./components/Toast";

export default function App() {
  const s = useStore();
  const [veil, setVeil] = createSignal(false);

  createEffect(() => {
    const th = s.settings().theme;
    document.body.dataset.theme = th;
    document.documentElement.dataset.theme = th;
    document.title = s.current() ? `${s.current()!.meta.fileName} — Folio` : "Folio";
  });

  // 强调色覆盖写进 body 内联（压在 [data-theme] 令牌块之上）；空值则清掉内联交回主题内置色。
  // theme 一并追踪：日夜双档色（朱砂等六枚）随主题切档,单档旧色解析结果恒等不受影响。
  createEffect(() => applyAccent(s.settings().accent, s.settings().theme));

  // 菜单关闭（任何途径）时子菜单一并收起——状态放 ui，复位收敛在这一处
  createEffect(() => { if (!ui.menuOpen()) ui.setThemeSubOpen(false); });

  createEffect(() => {
    const p = s.settings();
    // 排版设置的唯一出口：区间夹紧与单位换算都在 lib/typography.ts（有单测）
    const vars = typeVars(p);
    const r = document.documentElement.style;
    for (const [k, v] of Object.entries(vars)) r.setProperty(k, v);
  });

  async function handleTauriDrop(paths: string[]) {
    const files: string[] = [];
    for (const p of paths) {
      const kind = await api.pathKind(p);
      if (kind === "dir") {
        try {
          const r = await api.scanFolder(p);
          s.toast(`目录已登记：新增 ${r.inserted} · 更新 ${r.updated} · 移除 ${r.removed}`
            + (r.truncated ? `（${r.truncated} 篇超出扫描上限未索引）` : ""));
          s.setSide("library");   // 2026-11-16：拖入文件夹=打开库，自动切到文档库面板
        } catch (e) {
          s.toast("目录登记失败：" + ui.fmtErr(e));
        }
      } else if (kind === "file" && /\.(md|markdown|txt)$/i.test(p)) {
        files.push(p);
      }
    }
    // UI-04：多文件拖放与「文件→打开」同口径——全部登记打开（反序走打开漏斗，最后展示第一个），
    // 不再静默丢弃第一个之后的文件
    if (files.length) {
      const batch = files.slice(0, 100);   // FR-1.2 批量上限与 pickAndOpen 一致
      for (const p of [...batch].reverse()) {
        try { await s.openPath(p); } catch (e) { s.toast("打开失败：" + String(e) + "（" + p + "）"); }
      }
      if (files.length > batch.length) s.toast(`文件较多，本次仅打开前 ${batch.length} 个`);
      s.setSide("outline");   // 2026-11-16：打开文件自动切到大纲面板
    }
    void s.refreshDocs();
  }

  async function handleBrowserDrop(files: FileList) {
    const arr = [...files].filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (!arr.length) { s.toast("未找到 Markdown 文件（支持 .md / .markdown / .txt；目录拖放为正式版能力）"); return; }
    let first: string | null = null;
    for (const f of arr.slice(0, 100)) {
      const p = await api.importBrowserFile(f);
      if (p && !first) first = p;
    }
    if (first) await s.openPath(first);
    void s.refreshDocs();
  }

  function onKeyDown(ev: KeyboardEvent) {
    const t = ev.target as HTMLElement;
    const typing = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t.isContentEditable;
    // UI-01：Esc 的「丢弃编辑」语义只属于编辑器本身；筛选框/对话框输入框里的 Esc 不许静默丢内容
    const inEditor = typing && !!(t as HTMLElement).closest?.(".cm-host");
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key;
    if (mod && (k === "q" || k === "Q")) {
      ev.preventDefault();   // 无论焦点在哪都不漏给系统默认（WebView2 里 Ctrl+W 会直接关窗）
      if (!typing || inEditor) void quitApp(s);   // UI-03：非编辑器输入框中不触发退出确认
      return;
    }
    if (mod && (k === "w" || k === "W")) {
      ev.preventDefault();
      if (typing && !inEditor) return;
      const cur = s.current();
      if (cur) void s.closeTab(cur.meta.id);
      return;
    }
    if (typing) {
      if (mod && (k === "s" || k === "S")) {
        ev.preventDefault();   // 任何焦点下都不漏给浏览器「保存网页」（v2 N7）
        if (s.mode() === "edit") void s.save();
        else s.toast("当前处于阅读模式 · Ctrl+E 进入编辑后可保存");
        return;
      }
      if (mod && (k === "e" || k === "E")) { ev.preventDefault(); s.toggleEdit(); return; }
      if (mod && (k === "f" || k === "F" || k === "k" || k === "K")) { ev.preventDefault(); ui.setSearchOpen(true); return; }
      if (k !== "Escape") return;
      if (s.mode() === "edit" && inEditor && !ui.anyOverlayOpen()) { ev.preventDefault(); s.discard(); return; }
      // 其余输入框里的 Esc：落到下面的通用弹层关闭链（关弹层/关设置，不再丢弃编辑内容）
    }
    if (k === "Escape") {
      if (ui.closeTopOverlay()) return;
      if (s.focusMode()) s.toggleFocus();
      return;
    }
    if (mod && (k === "n" || k === "N")) { ev.preventDefault(); void newDoc(s); return; }
    if (mod && (k === "o" || k === "O")) { ev.preventDefault(); void pickAndOpen(s); return; }
    if (mod && (k === "f" || k === "F" || k === "k" || k === "K")) { ev.preventDefault(); ui.setSearchOpen(true); return; }
    if (mod && (k === "e" || k === "E")) { ev.preventDefault(); s.toggleEdit(); return; }
    if (mod && ev.shiftKey && (k === "s" || k === "S")) { ev.preventDefault(); void s.saveAs(); return; }
    if (mod && (k === "s" || k === "S")) { ev.preventDefault(); void s.saveSmart(); return; }
    if (mod && k === "/") { ev.preventDefault(); ui.setKeysOpen(true); return; }
    if (k === "F3") { ev.preventDefault(); if (ui.hitNavVisible()) ui.stepHit(ev.shiftKey ? -1 : 1); return; }
    if (k === "Enter" && ui.hitNavVisible()) { ev.preventDefault(); ui.stepHit(ev.shiftKey ? -1 : 1); return; }
    if (ev.altKey && k === "ArrowLeft") { ev.preventDefault(); void s.back(); return; }
    if (ev.altKey && k === "ArrowRight") { ev.preventDefault(); void s.forward(); return; }
    if (ev.altKey && k === "ArrowUp") { ev.preventDefault(); ui.navSection(-1); return; }
    if (ev.altKey && k === "ArrowDown") { ev.preventDefault(); ui.navSection(1); return; }
    if (k === "Home") { ev.preventDefault(); ui.navTop(); }
  }

  function onDocClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (!t.closest("#menubar")) ui.setMenuOpen(null);
    // 注意：Solid 事件委托在 document 派发，按钮内 stopPropagation 挡不住本监听器
    // （同节点冒泡需 stopImmediatePropagation）——因此这里显式豁免触发按钮自身
    // 排版抽屉不在这里自动关：它是常驻面板，只由 ✕ / Esc / 再次点触发按钮关闭
    if (ui.ctxMenu() && !t.closest(".ctxmenu")) ui.setCtxMenu(null);
  }

  onMount(() => {
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onDocClick);
    let disposeDrag: (() => void) | undefined;
    if (s.isTauri) {
      void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
        const un = await getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload as { type: string; paths?: string[] };
          if (p.type === "enter" || p.type === "over") setVeil(true);
          else if (p.type === "leave") setVeil(false);
          else if (p.type === "drop") { setVeil(false); void handleTauriDrop(p.paths ?? []); }
        });
        disposeDrag = un;
      });
    } else {
      const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
      const over = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setVeil(true); } };
      const leave = (e: DragEvent) => { if (hasFiles(e)) setVeil(false); };
      const drop = (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); setVeil(false);
        if (e.dataTransfer?.files.length) void handleBrowserDrop(e.dataTransfer.files);
      };
      window.addEventListener("dragover", over);
      window.addEventListener("dragleave", leave);
      window.addEventListener("drop", drop);
      disposeDrag = () => {
        window.removeEventListener("dragover", over);
        window.removeEventListener("dragleave", leave);
        window.removeEventListener("drop", drop);
      };
    }
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onDocClick);
      disposeDrag?.();
    });
  });

  return (
    <>
      <Icons />
      <div class="win" classList={{ "focus": s.focusMode(), "hnv": ui.hitNavVisible() }}>
        <TitleBar />
        <div class="body" classList={{ "settings-open": ui.settingsOpen() }}>
          <Rail />
          <aside class="side">
            <Show when={s.side() === "outline"}>
              <div class="side-view"><OutlinePanel /></div>
            </Show>
            <Show when={s.side() === "library"}>
              <div class="side-view"><LibraryPanel /></div>
            </Show>
            <Show when={s.side() === "recents"}>
              <div class="side-view"><RecentsPanel /></div>
            </Show>
          </aside>
          {/* 分隔条：拖它改左右两栏宽度（双击回默认、←/→ 微调），宽度落在 settings.sideWidth */}
          <Splitter />
          <section class="center">
            <PaneBar />
            <CrumbBar />
            <Reader />
            <Show when={s.mode() === "edit"}>
              <Suspense fallback={<div style="display:grid;place-items:center;height:100%;opacity:.6;font-size:12px">编辑器加载中…</div>}>
                <EditorPane />
              </Suspense>
            </Show>
            <StatusBar />
          </section>
          {/* 设置视图：与 side/center 同层的全屏 flex 子项（原型布局）——打开时 side、center、splitter 一起隐藏 */}
          <SettingsPanel />
        </div>
        <SearchPalette />
        <KeysModal />
        <AboutModal />
        <PropsModal />
        <ImgBox />
        <HitNav />
        <DropVeil on={veil()} />
        <ContextMenu />
        {/* 2026-11-17：文件/目录/另存为已改回 Windows 原生系统对话框，不再挂 PickDialog；询问框仍在 */}
        <AskDialog />
        <CopyPop />
        <ExportBusy />
        <ToastZone />
      </div>
    </>
  );
}
