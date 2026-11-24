import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { newDoc, pickAndOpen, pickFolderAndScan, quitApp, copyDeepLink, exportHtml, exportPdf, openGuide, formatDocument, undoDocument, redoDocument } from "../lib/actions";
import { APP_VERSION, IS_DEV } from "../lib/version";
import { t } from "../lib/i18n";

/** theme 字段只给「主题▸」子项：与 settings().theme 相等时打 accent 点（单选可视化） */
interface MItem { act: string; label: string; kbd?: string; icon?: string; theme?: "dark" | "light" | "sepia"; sub?: MItem[];
  /** 返回 false 时菜单项置灰且不可执行（撤销/重做方案 v1.0）；省略表示始终可用 */ enabled?: () => boolean }
interface Menu { name: string; items: (MItem | { sep: true })[] }

export default function TitleBar() {
  const s = useStore();
  const bs: HTMLElement[] = [];   // 注意：不能写 `let bs!:T`——运行时是 undefined，ref 赋值会炸
  let kb = -1;
  const [ovf, setOvf] = createSignal(false);

  /* 菜单是模块加载时求值的重灾区（设计 §3.5）：改为 createMemo 依赖 locale()，
   * 语言切换即整体重建；撤销/重做的 enabled() 置灰逻辑原样保留。 */
  const menus = createMemo<Menu[]>(() => [
    { name: t("app.menu.file"), items: [
      { act: "new-doc", label: t("app.menu.file.new"), kbd: "Ctrl N", icon: "i-new-file" },
      { act: "open", label: t("app.menu.file.open"), kbd: "Ctrl O", icon: "i-open-file" },
      { act: "open-dir", label: t("app.menu.file.openFolder"), icon: "i-open-folder" },
      { sep: true },
      { act: "save", label: t("app.menu.file.save"), kbd: "Ctrl S", icon: "i-save" },
      { act: "save-as", label: t("app.menu.file.saveAs"), kbd: "Ctrl Shift S", icon: "i-save-as" },
      { sep: true },
      { act: "export", label: t("app.menu.file.exportHtml"), icon: "i-external" },
      { act: "export-pdf", label: t("app.menu.file.exportPdf"), icon: "i-download" },
      { sep: true },
      { act: "quit", label: t("app.menu.file.quit"), kbd: "Ctrl Q", icon: "i-x" },
    ] },
    { name: t("app.menu.view"), items: [
      { act: "focus", label: t("app.menu.view.focus"), icon: "i-panel-l" },
      { act: "library", label: t("app.menu.view.libraryPanel"), icon: "i-open-folder" },
      { act: "recents", label: t("app.menu.view.recentsPanel"), icon: "i-recent" },
      { act: "outline", label: t("app.menu.view.outlinePanel"), icon: "i-outline" },
      { sep: true },
      // 原「深色 / 浅色主题」二态互斥项退役（2026-11-16）→ 主题子菜单三选（当前项打点）
      { act: "theme-sub", label: t("app.menu.view.theme"), icon: "i-contrast", sub: [
        { act: "theme-dark", label: t("app.menu.view.theme.dark"), icon: "i-moon", theme: "dark" },
        { act: "theme-light", label: t("app.menu.view.theme.light"), icon: "i-sun", theme: "light" },
        { act: "theme-sepia", label: t("app.menu.view.theme.sepia"), icon: "i-contrast", theme: "sepia" },
      ] },
      { act: "font", label: t("app.menu.view.settings"), icon: "i-sliders" },
      { sep: true },
      { act: "top", label: t("app.menu.view.top"), kbd: "Home", icon: "i-arrow-up" },
    ] },
    { name: t("app.menu.document"), items: [
      // 撤销/重做（方案 v1.0，2026-11-23）：编辑动作放最上方一组；阅读态/空历史/编辑器未挂载置灰
      { act: "undo", label: t("app.menu.document.undo"), kbd: "Ctrl Z", icon: "i-undo", enabled: () => ui.editorCanUndo() },
      { act: "redo", label: t("app.menu.document.redo"), kbd: "Ctrl Y", icon: "i-redo", enabled: () => ui.editorCanRedo() },
      { sep: true },
      { act: "prev-sec", label: t("app.menu.document.prevSection"), kbd: "Alt ↑", icon: "i-arrow-up" },
      { act: "next-sec", label: t("app.menu.document.nextSection"), kbd: "Alt ↓", icon: "i-arrow-down" },
      { sep: true },
      { act: "search", label: t("app.menu.document.search"), kbd: "Ctrl F", icon: "i-search" },
      { sep: true },
      { act: "edit", label: t("app.menu.document.toggleEdit"), kbd: "Ctrl E", icon: "i-type" },
      // 源码自动格式化（2026-11-18）：结构空白归一，不改代码块内容；结果可 Ctrl+Z 整体撤销
      { act: "format", label: t("app.menu.document.format"), kbd: "Shift Alt F", icon: "i-format" },
      { sep: true },
      { act: "props", label: t("app.menu.document.props"), icon: "i-info" },
      { act: "link", label: t("app.menu.document.copyLink"), icon: "i-copy" },
    ] },
    { name: t("app.menu.help"), items: [
      { act: "guide", label: t("app.menu.help.guide"), icon: "i-md" },
      { act: "keys", label: t("app.menu.help.keys"), kbd: "Ctrl /", icon: "i-md" },
      { sep: true },
      { act: "about", label: t("app.menu.help.about"), icon: "i-info" },
    ] },
  ]);

  function act(a: string) {
    switch (a) {
      case "new-doc": void newDoc(s); break;
      case "open": void pickAndOpen(s); break;
      case "open-dir": void pickFolderAndScan(s); break;
      case "quit": void quitApp(s); break;
      case "export": void exportHtml(s); break;
      case "export-pdf": void exportPdf(s); break;
      case "focus": s.toggleFocus(); break;
      case "library": s.setSide("library"); break;
      case "recents": s.setSide("recents"); break;
      case "outline": s.setSide("outline"); break;
      case "theme-sub": ui.setThemeSubOpen(!ui.themeSubOpen()); break;
      case "theme-dark": s.saveSettings({ theme: "dark" }); break;
      case "theme-light": s.saveSettings({ theme: "light" }); break;
      case "theme-sepia": s.saveSettings({ theme: "sepia" }); break;
      case "font": ui.setSettingsOpen(!ui.settingsOpen()); break;
      case "top": ui.navTop(); break;
      case "prev-sec": ui.navSection(-1); break;
      case "next-sec": ui.navSection(1); break;
      case "search": ui.setSearchOpen(true); break;
      case "edit": s.toggleEdit(); break;
      case "undo": undoDocument(s); break;
      case "redo": redoDocument(s); break;
      case "format": void formatDocument(s); break;
      case "save": void s.saveSmart(); break;
      case "save-as": void s.saveAs(); break;
      case "props": ui.setPropsOpen(true); break;
      case "link": copyDeepLink(s); break;
      case "guide": void openGuide(s); break;
      case "keys": ui.setKeysOpen(true); break;
      case "about": ui.setAboutOpen(true); break;
    }
  }

  function onKey(ev: KeyboardEvent) {
    const open = ui.menuOpen();
    if (!open) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;   // v2 N12：修饰键组合归全局导航
    const host = open === "ovf" ? document.getElementById("ovf-drop") : bs.find((b) => b.classList.contains("open"))?.querySelector(".mdrop");
    const items = host ? [...host.querySelectorAll<HTMLElement>(".mi[data-act]:not(.dis)")] : [];
    if (!items.length) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      kb = (kb + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle("kb", i === kb));
      items[kb].scrollIntoView({ block: "nearest" });
      // 键盘光标进入子菜单项：自动展开（可见即可达，与鼠标 hover 同语义）
      if (items[kb].closest(".sub-drop")) ui.setThemeSubOpen(true);
    } else if (ev.key === "Enter") {
      if (kb >= 0 && items[kb]) {
        ev.preventDefault();
        const a = items[kb].dataset.act!;
        if (a === "theme-sub") { ui.setThemeSubOpen(true); }   // 父项回车=展开，不关菜单
        else { act(a); ui.setMenuOpen(null); kb = -1; }
      } else ui.setMenuOpen(null);
    } else if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft") && open !== "ovf") {
      ev.preventDefault();
      const idx = Number(open);
      const next = bs[(idx + (ev.key === "ArrowRight" ? 1 : -1) + menus().length) % menus().length];
      kb = -1;
      ui.setMenuOpen(next.dataset.menu!);
      (next.querySelector(".mi[data-act]:not(.dis)") as HTMLElement | null)?.focus();
    }
  }
  onMount(() => {
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  async function winCmd(kind: "min" | "max" | "close") {
    if (!s.isTauri) { s.toast(t("titlebar.win.browserOnly")); return; }
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (kind === "min") await w.minimize();
    else if (kind === "max") await w.toggleMaximize();
    else await quitApp(s);
  }

  const MenuItems = (props: { items: (MItem | { sep: true })[]; group?: string }) => (
    <>
      <Show when={props.group}>
        <div class="mgrp">{props.group}</div>
      </Show>
      <For each={props.items}>
        {(it) => "sep" in it
          ? <div class="msep" />
          : it.sub ? <>
              {/* 子菜单父项：与兄弟项同字体同高；点击/悬停展开右侧 flyout，不关整菜单 */}
              <div class="mi sub" data-act={it.act} role="menuitem" tabindex={-1} aria-haspopup="true"
                onClick={(e) => { e.stopImmediatePropagation(); ui.setThemeSubOpen(!ui.themeSubOpen()); }}>
                <svg class="ico ico-14"><use href={"#" + (it.icon ?? "i-md")} /></svg>
                <span class="t">{it.label}</span>
                <svg class="ico ico-12"><use href="#i-chev-r" /></svg>
                <div class="sub-drop" classList={{ open: ui.themeSubOpen() }} role="menu">
                  <For each={it.sub}>{(c) => (
                    <div class="mi" data-act={c.act} role="menuitem" tabindex={-1}
                      onClick={(e) => { e.stopImmediatePropagation(); ui.setMenuOpen(null); ui.setThemeSubOpen(false); act(c.act); }}>
                      <span class="ck" style={{ visibility: c.theme && s.settings().theme === c.theme ? "visible" : "hidden" }} />
                      <svg class="ico ico-14"><use href={"#" + (c.icon ?? "i-md")} /></svg>
                      <span class="t">{c.label}</span>
                    </div>
                  )}</For>
                </div>
              </div>
            </>
          : (() => {
              // 禁用态（撤销/重做方案 v1.0）：置灰、不响应点击、键盘导航跳过（:not(.dis)）
              const dis = () => !!it.enabled && !it.enabled();
              return <div class="mi" data-act={it.act} role="menuitem" tabindex={-1}
                classList={{ dis: dis() }}
                aria-disabled={dis() ? "true" : undefined}
                onClick={(e) => { e.stopImmediatePropagation(); if (dis()) return; ui.setMenuOpen(null); act(it.act); }}>
                <Show when={!props.group}>
                  <svg class="ico ico-14"><use href={"#" + (it.icon ?? "i-md")} /></svg>
                </Show>
                <span class="t">{it.label}</span>
                <Show when={it.kbd}><kbd>{it.kbd}</kbd></Show>
              </div>;
            })()}
      </For>
    </>
  );

  return (
    <header class="tbar" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>
        <span class="mark">F</span>
        <span class="brand-name">Folio</span>
        <span class="brand-chip" title={t("titlebar.chip.version", { version: APP_VERSION })}>v{APP_VERSION} {IS_DEV ? t("titlebar.chip.dev") : t("titlebar.chip.release")}</span>
      </div>

      <nav class="menu" role="menubar" id="menubar">
        <For each={menus()}>{(m, i) => (
          <b
            ref={(el) => { bs[i()] = el; }}
            data-menu={String(i())}
            classList={{ open: ui.menuOpen() === String(i()) }}
            tabindex={0}
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              kb = -1;
              const cur = ui.menuOpen();
              ui.setMenuOpen(cur === String(i()) ? null : String(i()));
              if (ui.menuOpen() !== null) {
                (e.currentTarget.querySelector(".mi[data-act]:not(.dis)") as HTMLElement | null)?.focus();
              }
            }}
          >{m.name}
            <div class="mdrop" role="menu"><MenuItems items={m.items} /></div>
          </b>
        )}</For>
        {/* 窄窗溢出（仅 ≤980px 显示；生产 minWidth=1000 下为休眠档位，保留以对齐原型降级链） */}
        <b
          id="menu-ovf"
          data-menu="ovf"
          classList={{ open: ui.menuOpen() === "ovf" }}
          tabindex={0}
          role="menuitem"
          onClick={(e) => { e.stopPropagation(); kb = -1; ui.setMenuOpen(ui.menuOpen() === "ovf" ? null : "ovf"); }}
        >{t("app.menu.overflow")}
          <div class="mdrop" id="ovf-drop" role="menu">
            <For each={menus()}>{(m) => <MenuItems items={m.items} group={m.name} />}</For>
          </div>
        </b>
      </nav>

      {/* data-tauri-drag-region：Tauri 只对「被点中的那个元素」查属性（不冒泡）——tabs 条是
          header 里最宽的"空白区"，缺这属性时 Tab 可见段整条拖不动窗口（需求反馈 #2） */}
      <div class="tabs" data-tauri-drag-region>
        <For each={s.tabs()}>{(tab) => (
          <div class="tab" classList={{ on: s.activeTabId() === tab.docId }} title={tab.path + "\n" + t("titlebar.tab.switch")}
            onClick={() => { if (s.activeTabId() !== tab.docId) void s.openPath(tab.path); }}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void s.closeTab(tab.docId); } }}>
            <svg class="ico ico-14 fi"><use href="#i-md" /></svg>
            <span class="tn">{tab.fileName}</span>
            <Show when={s.activeTabId() === tab.docId && s.dirty()}>
              <span class="dirtydot" title={t("titlebar.tab.unsaved")} />
            </Show>
            <span class="tabx" title={t("titlebar.tab.close")}
              onClick={(e) => { e.stopPropagation(); void s.closeTab(tab.docId); }}>
              <svg class="ico ico-12"><use href="#i-x" /></svg>
            </span>
          </div>
        )}</For>
      </div>

      <div class="tbar-right">
        <div class="seg">
          <button classList={{ on: s.mode() !== "edit" }} title={t("titlebar.mode.read.title")} onClick={() => { if (s.mode() === "edit") s.toggleEdit(); }}>
            <svg class="ico ico-14"><use href="#i-eye" /></svg>{t("titlebar.mode.read")}
          </button>
          <button classList={{ on: s.mode() === "edit" }} title={t("titlebar.mode.edit.title")} onClick={() => s.toggleEdit()}>
            <svg class="ico ico-14"><use href="#i-type" /></svg>{t("titlebar.mode.edit")}
          </button>
        </div>
        <span style={{ width: "1px", height: "15px", background: "var(--line)", margin: "0 3px" }} />
        {/* 与原型同款按钮集：搜索 + 专注 + ⚙设置 + 窗口三钮。主题切换收进「查看」菜单（原型同款）；
            2026-11-16：设置入口从 rail 底部迁到标题栏（专注右边，唯一快捷入口，rail 钮已撤） */}
        <span class="iconbtn" title={t("titlebar.icon.search")} onClick={() => ui.setSearchOpen(true)}>
          <svg class="ico ico-18"><use href="#i-search" /></svg>
        </span>
        <span class="iconbtn" classList={{ on: s.focusMode() }} title={t("titlebar.icon.focus")} onClick={() => s.toggleFocus()}>
          <svg class="ico ico-18"><use href="#i-panel-l" /></svg>
        </span>
        <span class="iconbtn" classList={{ on: ui.settingsOpen() }} title={t("titlebar.icon.settings")} onClick={() => ui.setSettingsOpen(!ui.settingsOpen())}>
          <svg class="ico ico-18"><use href="#i-sliders" /></svg>
        </span>
        <div class="wctl">
          <i title={t("titlebar.win.min")} onClick={() => void winCmd("min")}><svg class="ico ico-14"><use href="#i-minus" /></svg></i>
          <i title={t("titlebar.win.max")} onClick={() => void winCmd("max")}><svg class="ico ico-14"><use href="#i-max" /></svg></i>
          <i class="close" title={t("titlebar.win.close")} onClick={() => void winCmd("close")}><svg class="ico ico-14"><use href="#i-x" /></svg></i>
        </div>
      </div>
    </header>
  );
}