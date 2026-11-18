import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { newDoc, pickAndOpen, pickFolderAndScan, quitApp, copyDeepLink, exportHtml, exportPdf, openGuide } from "../lib/actions";
import { APP_VERSION, IS_DEV } from "../lib/version";

/** theme 字段只给「主题▸」子项：与 settings().theme 相等时打 accent 点（单选可视化） */
interface MItem { act: string; label: string; kbd?: string; icon?: string; theme?: "dark" | "light" | "sepia"; sub?: MItem[] }
interface Menu { name: string; items: (MItem | { sep: true })[] }

const MENUS: Menu[] = [
  { name: "文件", items: [
    { act: "new-doc", label: "新建文档", kbd: "Ctrl N", icon: "i-new-file" },
    { act: "open", label: "打开文档…", kbd: "Ctrl O", icon: "i-open-file" },
    { act: "open-dir", label: "打开文件夹…", icon: "i-open-folder" },
    { sep: true },
    { act: "export", label: "导出为 HTML…", icon: "i-external" },
    { act: "export-pdf", label: "导出为 PDF…", icon: "i-download" },
    { sep: true },
    { act: "quit", label: "退出", kbd: "Ctrl Q", icon: "i-x" },
  ] },
  { name: "查看", items: [
    { act: "focus", label: "专注模式（Esc 退出）", icon: "i-panel-l" },
    { act: "library", label: "文件夹面板", icon: "i-open-folder" },
    { act: "recents", label: "最近打开面板", icon: "i-recent" },
    { act: "outline", label: "大纲面板", icon: "i-outline" },
    { sep: true },
    // 原「深色 / 浅色主题」二态互斥项退役（2026-11-16）→ 主题子菜单三选（当前项打点）
    { act: "theme-sub", label: "主题", icon: "i-contrast", sub: [
      { act: "theme-dark", label: "深色", icon: "i-moon", theme: "dark" },
      { act: "theme-light", label: "浅色", icon: "i-sun", theme: "light" },
      { act: "theme-sepia", label: "米色", icon: "i-contrast", theme: "sepia" },
    ] },
    { act: "font", label: "设置…", icon: "i-sliders" },
    { sep: true },
    { act: "top", label: "回到顶部", kbd: "Home", icon: "i-arrow-up" },
  ] },
  { name: "文档", items: [
    { act: "prev-sec", label: "上一章", kbd: "Alt ↑", icon: "i-arrow-up" },
    { act: "next-sec", label: "下一章", kbd: "Alt ↓", icon: "i-arrow-down" },
    { sep: true },
    { act: "search", label: "全文搜索…", kbd: "Ctrl F", icon: "i-search" },
    { sep: true },
    { act: "edit", label: "切换编辑模式", kbd: "Ctrl E", icon: "i-type" },
    { act: "save", label: "保存并返回阅读", kbd: "Ctrl S", icon: "i-save" },
    { sep: true },
    { act: "props", label: "文档信息", icon: "i-info" },
    { act: "link", label: "复制深度链接", icon: "i-copy" },
  ] },
  { name: "帮助", items: [
    { act: "guide", label: "Folio 使用指南", icon: "i-md" },
    { act: "keys", label: "快捷键一览…", kbd: "Ctrl /", icon: "i-md" },
    { sep: true },
    { act: "about", label: "关于 Folio", icon: "i-info" },
  ] },
];

const allItems = (): MItem[] => MENUS.flatMap((m) => m.items.filter((i) => "act" in i) as MItem[]);

export default function TitleBar() {
  const s = useStore();
  const bs: HTMLElement[] = [];   // 注意：不能写 `let bs!:T`——运行时是 undefined，ref 赋值会炸
  let kb = -1;
  const [ovf, setOvf] = createSignal(false);

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
      case "save":
        if (s.mode() === "edit") void s.save();
        else s.toast("当前处于阅读模式 · Ctrl+E 进入编辑后可保存");
        break;
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
    const items = host ? [...host.querySelectorAll<HTMLElement>(".mi[data-act]")] : [];
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
      const next = bs[(idx + (ev.key === "ArrowRight" ? 1 : -1) + MENUS.length) % MENUS.length];
      kb = -1;
      ui.setMenuOpen(next.dataset.menu!);
      (next.querySelector(".mi[data-act]") as HTMLElement | null)?.focus();
    }
  }
  onMount(() => {
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  async function winCmd(kind: "min" | "max" | "close") {
    if (!s.isTauri) { s.toast("窗口控制由 Tauri 接管（浏览器演示环境无效）"); return; }
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
          : <div class="mi" data-act={it.act} role="menuitem" tabindex={-1}
              onClick={(e) => { e.stopImmediatePropagation(); ui.setMenuOpen(null); act(it.act); }}>
              <Show when={!props.group}>
                <svg class="ico ico-14"><use href={"#" + (it.icon ?? "i-md")} /></svg>
              </Show>
              <span class="t">{it.label}</span>
              <Show when={it.kbd}><kbd>{it.kbd}</kbd></Show>
            </div>}
      </For>
    </>
  );

  return (
    <header class="tbar" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>
        <span class="mark">F</span>
        <span class="brand-name">Folio</span>
        <span class="brand-chip" title="版本=主.次.修复.编译次数（release.sh 自增）">v{APP_VERSION} {IS_DEV ? "开发版" : "正式版"}</span>
      </div>

      <nav class="menu" role="menubar" id="menubar">
        <For each={MENUS}>{(m, i) => (
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
                (e.currentTarget.querySelector(".mi[data-act]") as HTMLElement | null)?.focus();
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
        >菜单
          <div class="mdrop" id="ovf-drop" role="menu">
            <For each={MENUS}>{(m) => <MenuItems items={m.items} group={m.name} />}</For>
          </div>
        </b>
      </nav>

      {/* data-tauri-drag-region：Tauri 只对「被点中的那个元素」查属性（不冒泡）——tabs 条是
          header 里最宽的"空白区"，缺这属性时 Tab 可见段整条拖不动窗口（需求反馈 #2） */}
      <div class="tabs" data-tauri-drag-region>
        <For each={s.tabs()}>{(t) => (
          <div class="tab" classList={{ on: s.activeTabId() === t.docId }} title={t.path + "\n单击切换 · 中键/✕ 关闭"}
            onClick={() => { if (s.activeTabId() !== t.docId) void s.openPath(t.path); }}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void s.closeTab(t.docId); } }}>
            <svg class="ico ico-14 fi"><use href="#i-md" /></svg>
            <span class="tn">{t.fileName}</span>
            <Show when={s.activeTabId() === t.docId && s.dirty()}>
              <span class="dirtydot" title="有未保存修改" />
            </Show>
            <span class="tabx" title="关闭页签 (Ctrl+W)"
              onClick={(e) => { e.stopPropagation(); void s.closeTab(t.docId); }}>
              <svg class="ico ico-12"><use href="#i-x" /></svg>
            </span>
          </div>
        )}</For>
      </div>

      <div class="tbar-right">
        <div class="seg">
          <button classList={{ on: s.mode() !== "edit" }} title="阅读模式 (Ctrl+E)" onClick={() => { if (s.mode() === "edit") s.toggleEdit(); }}>
            <svg class="ico ico-14"><use href="#i-eye" /></svg>阅读
          </button>
          <button classList={{ on: s.mode() === "edit" }} title="编辑模式 (Ctrl+E)" onClick={() => s.toggleEdit()}>
            <svg class="ico ico-14"><use href="#i-type" /></svg>编辑
          </button>
        </div>
        <span style={{ width: "1px", height: "15px", background: "var(--line)", margin: "0 3px" }} />
        {/* 与原型同款按钮集：搜索 + 专注 + ⚙设置 + 窗口三钮。主题切换收进「查看」菜单（原型同款）；
            2026-11-16：设置入口从 rail 底部迁到标题栏（专注右边，唯一快捷入口，rail 钮已撤） */}
        <span class="iconbtn" title="全文搜索 (Ctrl+F / Ctrl+K)" onClick={() => ui.setSearchOpen(true)}>
          <svg class="ico ico-18"><use href="#i-search" /></svg>
        </span>
        <span class="iconbtn" classList={{ on: s.focusMode() }} title="专注模式 (Esc 退出)" onClick={() => s.toggleFocus()}>
          <svg class="ico ico-18"><use href="#i-panel-l" /></svg>
        </span>
        <span class="iconbtn" classList={{ on: ui.settingsOpen() }} title="设置" onClick={() => ui.setSettingsOpen(!ui.settingsOpen())}>
          <svg class="ico ico-18"><use href="#i-sliders" /></svg>
        </span>
        <div class="wctl">
          <i title="最小化" onClick={() => void winCmd("min")}><svg class="ico ico-14"><use href="#i-minus" /></svg></i>
          <i title="最大化 / 还原" onClick={() => void winCmd("max")}><svg class="ico ico-14"><use href="#i-max" /></svg></i>
          <i class="close" title="关闭" onClick={() => void winCmd("close")}><svg class="ico ico-14"><use href="#i-x" /></svg></i>
        </div>
      </div>
    </header>
  );
}
