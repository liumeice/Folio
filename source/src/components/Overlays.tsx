/* 快捷键一览 / 关于 / 文档信息 / 排版弹层 / 命中浮动条 / 图片放大 / 拖放遮罩 */
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { escapeHtml } from "../lib/md";
import { countWords } from "../lib/wordcount";
import { api, isTauri } from "../lib/api";
import { revealInFolder, confirmBox, pickFolderAndScan } from "../lib/actions";
import { APP_VERSION, IS_DEV } from "../lib/version";
import type { CtxTarget } from "../lib/ui";
import type { EditorCmd, ListKind, WrapKind } from "../lib/mdInsert";

const KEYMAP: [string, string][] = [
  ["Ctrl O", "打开本地 .md（可多选）"],
  ["Ctrl N", "新建文档（草稿即写，首次保存确认名字与位置）"],
  ["Ctrl F / Ctrl K", "全文搜索"],
  ["F3 / Shift+F3", "搜索命中下一处 / 上一处"],
  ["Ctrl E", "阅读 ⇄ 编辑（有改动时保存并提示）"],
  ["Ctrl S", "保存（编辑态写回并返回阅读；阅读态提交待保存修改，如任务勾选）"],
  ["Ctrl Shift S", "另存为…（当前内容写到新路径，页签切到新文件，原文件不动）"],
  ["Ctrl 滚轮 ↑ / ↓", "阅读区正文字号放大 / 缩小（仅正文排版，不缩放应用界面）"],
  ["Shift Alt F", "源码自动格式化（标题 / 列表 / 引用 / 围栏空格与空行；代码块内容不动）"],
  ["Alt ↑ / Alt ↓", "上一章 / 下一章"],
  ["Alt ← / Alt →", "后退 / 前进（同文档回当时行）"],
  ["↑ ↓ ← →", "大纲内：移动 / 收起 / 展开（Enter 或空格跳转）"],
  ["Home", "回到顶部（输入焦点内不劫持光标）"],
  ["Esc", "关弹层 → 清高亮 → 退专注 → 编辑中放弃修改"],
  ["Ctrl Q", "退出（有未保存内容需确认）"],
];

function OverlayShell(props: { id: string; open: boolean; onClose: () => void; mid?: boolean; children: any }) {
  return (
    <div id={props.id} class="overlay" classList={{ mid: !!props.mid, open: props.open }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      {props.children}
    </div>
  );
}

export function KeysModal() {
  return (
    <OverlayShell id="keys-overlay" mid open={ui.keysOpen()} onClose={() => ui.setKeysOpen(false)}>
      <div class="modal">
        <div class="modal-h">
          <span class="mi2"><svg class="ico ico-18"><use href="#i-md" /></svg></span>
          <div><div class="mt">快捷键一览</div><div class="md2">编辑态内快捷键已隔离，不会穿透</div></div>
          <span class="sp" />
          <span class="x" onClick={() => ui.setKeysOpen(false)}><svg class="ico ico-14"><use href="#i-x" /></svg></span>
        </div>
        <div class="modal-b">
          <For each={KEYMAP}>{([k, d]) => (
            <div class="krow"><kbd>{k}</kbd><span class="sp" /><span>{d}</span></div>
          )}</For>
        </div>
        <div class="modal-f">
          <span style={{ "font-size": "11.5px", color: "var(--text-3)" }}>应用内加速键 · 窗口聚焦态生效</span>
          <span class="sp" />
          <button class="btn" onClick={() => ui.setKeysOpen(false)}>知道了</button>
        </div>
      </div>
    </OverlayShell>
  );
}

export function AboutModal() {
  const s = useStore();
  const tags: [string, boolean][] = [   // 首个 accent 底、其余描边——逐条对齐原型 §8.2
    ["Tauri 2.11", false], ["Rust workspace", true], ["SolidJS 1.9", true],
    ["TypeScript 5.8", true], ["CodeMirror 6", true], ["SQLite + FTS5", true], ["Vite 6", true],
  ];
  /* 打开仓库主页：Tauri 下走 opener 插件交系统默认浏览器（同 Reader.openExternal 范式，
   * WebView2 里 target=_blank 不会自己出去，必须 preventDefault + openUrl） */
  const REPO_URL = "https://github.com/liumeice/Folio";
  async function openRepo() {
    if (isTauri) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(REPO_URL);
      } catch {
        s.toast("打开外链失败");
      }
    } else {
      window.open(REPO_URL, "_blank", "noopener");
    }
  }
  return (
    <OverlayShell id="about-overlay" mid open={ui.aboutOpen()} onClose={() => ui.setAboutOpen(false)}>
      <div class="modal" style={{ width: "440px" }}>
        <div class="modal-h">
          <span class="mark" style={{ width: "32px", height: "32px", "border-radius": "9px", "font-size": "15px" }}>F</span>
          <div><div class="mt">Folio <span style={{ "font-size": "11px", color: "var(--text-3)", "font-weight": "400" }}>v{APP_VERSION} · {IS_DEV ? "开发版" : "正式版"}</span></div>
            <div class="md2">把一堆 .md 当成「书」来读</div></div>
          <span class="sp" />
          <span class="x" onClick={() => ui.setAboutOpen(false)}><svg class="ico ico-14"><use href="#i-x" /></svg></span>
        </div>
        <div class="modal-b">
          <div style={{ "font-size": "12.5px", color: "var(--text-2)", "line-height": "1.8", "margin-bottom": "14px" }}>
            Windows 桌面本地 Markdown 阅读器。阅读状态存于本地 SQLite，数据不上传；文档中的网络图片按需在线加载。
          </div>
          <div class="about-stack">
            <For each={tags}>{([t, plain]) => <span class={plain ? "tag plain" : "tag"}>{t}</span>}</For>
          </div>
          <div style={{ "margin-top": "16px", padding: "10px 12px", border: "1px solid var(--line)", "border-radius": "var(--r-2)", "font-family": "var(--font-mono)", "font-size": "11px", color: "var(--text-3)" }}>
            GitHub：<a class="about-repo" href={REPO_URL} target="_blank" rel="noopener"
              onClick={(e) => { e.preventDefault(); openRepo(); }}>github.com/liumeice/Folio</a><br />
            深度链接：<span style={{ color: "var(--accent)" }}>folio://open?doc=&lt;slug&gt;&amp;sec=…</span><br />
            {isTauri ? "单实例 · WebView2 · " + s.docs().length + " 篇已索引" : "浏览器演示环境（Rust 未接入，localStorage 模拟）"}
          </div>
        </div>
        <div class="modal-f"><span style={{ "font-size": "11.5px", color: "var(--text-3)" }}>数据只落本地 · 网络图片在线加载</span><span class="sp" />
          <button class="btn primary" onClick={() => ui.setAboutOpen(false)}>好</button></div>
      </div>
    </OverlayShell>
  );
}

/* 复制成功浮层：中央小卡 2s 自动消失（ui.showCopied 驱动） */
export function CopyPop() {
  return (
    <Show when={ui.copyPop()} keyed>{(p) => (
      <div class="copypop on">
        <svg class="ico ico-14"><use href="#i-check-circle" /></svg>
        <span>{p.msg}</span>
        <Show when={p.link}><code>{p.link}</code></Show>
      </div>
    )}</Show>
  );
}

/* 导出 PDF 进行中浮层（FR-13.2）：顶部居中（与 toast 同位，pointer-events:none），兼互斥指示 */
export function ExportBusy() {
  return (
    <Show when={ui.exportBusy()}>
      <div class="exporting" role="status"><span class="spin" aria-hidden="true" />正在导出 PDF…</div>
    </Show>
  );
}

/* 打开文件夹扫描进行中浮层（需求方 2026-11-18 样例定稿「仅顶部小卡」）：
 * 与导出中同位同族，胶囊圆角、圈字间距；转圈=纯合成层动画（JS 忙也转），
 * 秒表=JS 心跳（主线程真被占住会顿住——正是"还活着/真卡了"的判针）。侧栏不做任何效果。 */
export function ScanBusy() {
  const [elapsed, setElapsed] = createSignal(0);
  let timer = 0;
  createEffect(on(ui.scanBusy, (dir) => {
    window.clearInterval(timer);
    if (dir == null) { setElapsed(0); return; }
    const t0 = Date.now();
    setElapsed(0);
    timer = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
  }));
  onCleanup(() => window.clearInterval(timer));
  return (
    <Show when={ui.scanBusy()} keyed>{(dir) => (
      <div class="scanning" role="status">
        <span class="spin" aria-hidden="true" />
        <span>正在扫描文件夹「{leafOf(dir)}」…</span>
        <span class="el">{elapsed().toFixed(1)}s</span>
      </div>
    )}</Show>
  );
}
function leafOf(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  return s.split(/[\\/]/).pop() || s;
}

export function PropsModal() {
  const s = useStore();
  const cur = () => s.current();
  function link(): string {
    const c = cur();
    if (!c) return "—";
    const sec = s.activeSec();
    const o = sec != null ? c.outline[sec - 1] : undefined;
    // 可读原文（§10.9 v1.1）：中文标题/slug 不 percent 编码
    return "folio://open?doc=" + c.meta.slug + (o ? "&sec=" + o.text : "");
  }
  const rows = (): [string, string][] => {
    const c = cur();
    if (!c) return [["状态", "未打开文档"]];
    return [
      ["路径", c.meta.path],
      ["大小", (c.meta.size / 1024).toFixed(1) + " KB"],
      ["字数", countWords(c.src).toLocaleString() + " 字（正文口径 · 不含公式/图表源码）"],
      ["小节 / 标题", c.meta.secCount + " 节 / " + c.outline.length + " 条"],
      ["编码", "UTF-8"],
      ["修改时间", new Date(c.meta.mtime * 1000).toLocaleString()],
      ["当前章节", s.activeSec() != null ? (c.outline[s.activeSec()! - 1]?.text ?? "—") : "—"],
      ["阅读进度", Math.round(ui.readPct() * 100) + "%"],
      ["深度链接", link()],
    ];
  };
  return (
    <OverlayShell id="info-overlay" mid open={ui.propsOpen()} onClose={() => ui.setPropsOpen(false)}>
      <div class="modal" style={{ width: "480px" }}>
        <div class="modal-h">
          <span class="mi2"><svg class="ico ico-18"><use href="#i-info" /></svg></span>
          <div style={{ "min-width": "0" }}><div class="mt">文档信息</div><div class="md2 ellip">{cur()?.meta.fileName ?? "—"}</div></div>
          <span class="sp" />
          <span class="x" onClick={() => ui.setPropsOpen(false)}><svg class="ico ico-14"><use href="#i-x" /></svg></span>
        </div>
        <div class="modal-b">
          <For each={rows()}>{([k, v]) => (
            <div class="krow"><span style={{ color: "var(--text-3)" }}>{k}</span><span class="sp" />
              <span style={{ "font-family": "var(--font-mono)", "font-size": "11.5px", "word-break": "break-all", "text-align": "right" }}>{v}</span></div>
          )}</For>
        </div>
        {/* §8.2 按钮组口径：等宽、dismiss（关闭）居左 */}
        <div class="modal-f"><span class="sp" /><span class="mfb">
          <button class="btn" onClick={() => ui.setPropsOpen(false)}>关闭</button>
          <button class="btn primary" onClick={() => {
            navigator.clipboard?.writeText(link()).then(() => ui.showCopied("已复制深度链接", link()))
              .catch(() => s.toast("剪贴板不可用"));
          }}><svg class="ico ico-14"><use href="#i-copy" /></svg>复制深度链接</button>
        </span></div>
      </div>
    </OverlayShell>
  );
}

export function ImgBox() {
  return (
    <div class="overlay mid" classList={{ open: ui.imgSrc() != null }} id="imgbox"
      onMouseDown={() => ui.setImgSrc(null)}>
      <div style={{ "pointer-events": "none", "text-align": "center" }}>
        <Show when={ui.imgSrc()}>
          <img src={ui.imgSrc()!} alt="" style={{ "max-width": "90vw", "max-height": "78vh", "box-shadow": "var(--shadow-pop)" }} />
        </Show>
        <div style={{ "margin-top": "10px", "font-size": "11.5px", color: "var(--text-3)" }}>点击任意处关闭 · Esc</div>
      </div>
    </div>
  );
}

/* 排版设置已从浮层 FontPopover 迁到右侧抽屉 components/TypeDrawer.tsx（控件多了，浮层挤不下）。 */

export function HitNav() {
  return (
    <Show when={ui.hitNavVisible()}>
      <div class="hitnav">
        <button type="button" title="上一处 (Shift+Enter)" onClick={() => ui.stepHit(-1)}>
          <svg class="ico ico-14"><use href="#i-chev-u" /></svg>
        </button>
        <span>命中 <b>{ui.hitIdx() + 1} / {ui.hitCount()}</b></span>
        <button type="button" title="下一处 (Enter / F3)" onClick={() => ui.stepHit(1)}>
          <svg class="ico ico-14"><use href="#i-chev-d" /></svg>
        </button>
        <span><kbd>Enter</kbd> 下一处 · <kbd>Esc</kbd> 清除</span>
      </div>
    </Show>
  );
}

/* ── 编辑窗右键菜单（方案 N-CTX-01）────────────────────────────
 * 三条图标行等分铺满；表格/标题/代码走子面板；列表连点不关菜单。
 * 动作全部经 EditorBridge 回到 CM，文档变更一次事务。 */
const EDIT_ACTIONS = [
  ["cut", "剪切", "Ctrl+X", "i-cut", true],
  ["copy", "复制", "Ctrl+C", "i-copy", true],
  ["paste", "粘贴", "Ctrl+V", "i-paste", false],
  ["delete", "删除所选", "Delete", "i-trash", true],
  ["selectAll", "全选", "Ctrl+A", "i-select-all", false],
] as const;

const WRAP_ACTIONS = [
  ["bold", "加粗", "Ctrl+B", "i-bold"],
  ["italic", "斜体", "Ctrl+I", "i-italic"],
  ["code", "行内代码", "", "i-code"],
  ["strike", "删除线", "", "i-strike"],
  ["link", "链接", "", "i-link"],
] as const;

const LIST_ACTIONS = [
  ["ul", "无序列表", "i-list"],
  ["ol", "有序列表", "i-ol"],
  ["task", "任务清单", "i-task"],
  ["quote", "引用", "i-quote"],
] as const;

const CODE_LANGS = ["", "text", "ts", "js", "py", "rs", "html", "css", "json", "mermaid"];

function EditorCtxMenu(props: { tt: CtxTarget & { kind: "editor" } }) {
  const [hasSel, setHasSel] = createSignal(props.tt.hasSelection);
  const [openSub, setOpenSub] = createSignal<string | null>(null);
  const [hover, setHover] = createSignal({ c: 3, r: 3 });
  let el!: HTMLDivElement;

  const bridge = () => ui.getEditorBridge();

  async function run(cmd: EditorCmd, keep = false) {
    const b = bridge();
    if (!b) { ui.setCtxMenu(null); return; }
    const still = await b.runEditorCommand(cmd);
    setHasSel(still);
    if (!keep) {
      ui.setCtxMenu(null);
      b.focusEditor();
    }
  }

  function clamp() {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(props.tt.x, window.innerWidth - r.width - 8));
    const y = Math.max(8, Math.min(props.tt.y, window.innerHeight - r.height - 8));
    el.style.left = x + "px";
    el.style.top = y + "px";
  }

  /** 子菜单相对父项定位：右侧不够向左翻，下方不够向上翻，最后夹在窗口内。
   *  fixed 定位（相对视口），主菜单超高滚动时也不会被裁切。 */
  function positionSub(sub: HTMLDivElement | null) {
    if (!sub) return;
    const parent = sub.closest<HTMLElement>(".mi");
    if (!parent) return;
    const pr = parent.getBoundingClientRect();
    const r = sub.getBoundingClientRect();
    const gap = 10;   // 与父项轻微重叠，鼠标从父项移入子菜单不中断 hover
    let left = pr.right - gap;
    if (left + r.width > window.innerWidth - 8) left = pr.left - r.width + gap;
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
    let top = pr.top - 6;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    top = Math.max(8, top);
    sub.style.left = left + "px";
    sub.style.top = top + "px";
  }

  function focusables(): HTMLElement[] {
    if (!el) return [];
    return [...el.querySelectorAll<HTMLElement>(".ctool:not(:disabled), .mi[data-ctx]")]
      .filter((x) => x.offsetParent !== null);
  }

  function onKey(e: KeyboardEvent) {
    const handled = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", " ", "Escape", "Home", "End"];
    if (!handled.includes(e.key)) return;
    e.stopImmediatePropagation();
    const cur = document.activeElement as HTMLElement | null;
    const list = focusables();
    const move = (n: number) => list[(n + list.length) % Math.max(1, list.length)]?.focus();
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        ui.setCtxMenu(null);
        bridge()?.focusEditor();
        break;
      case "ArrowDown":
        e.preventDefault();
        move(Math.max(0, list.indexOf(cur!)) + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(Math.max(0, list.indexOf(cur!)) - 1);
        break;
      case "ArrowRight": {
        if (!cur?.dataset.sub) break;
        e.preventDefault();
        setOpenSub(cur.dataset.ctx ?? null);
        queueMicrotask(() => cur.querySelector<HTMLElement>(".sub-drop .mi")?.focus());
        break;
      }
      case "ArrowLeft": {
        const sub = cur?.closest<HTMLElement>(".sub-drop");
        if (!sub) break;
        e.preventDefault();
        const parent = sub.closest<HTMLElement>(".mi");
        setOpenSub(null);
        parent?.focus();
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        if (cur?.dataset.sub && !cur.dataset.default) {
          setOpenSub(cur.dataset.ctx ?? null);
          queueMicrotask(() => cur.querySelector<HTMLElement>(".sub-drop .mi")?.focus());
        } else {
          cur?.click();
        }
        break;
      case "Home":
        e.preventDefault();
        list[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        list[list.length - 1]?.focus();
        break;
    }
  }

  const menuItem = (icon: string, label: string, runFn: () => void, opts: { sub?: string; default?: boolean } = {}) => (
    <div class="mi" classList={{ sub: !!opts.sub }}
      data-ctx={opts.sub ?? label} data-sub={opts.sub ? "1" : undefined}
      data-default={opts.default ? "1" : undefined}
      role="menuitem" tabIndex={-1}
      onMouseEnter={() => setOpenSub(opts.sub ?? null)}
      onMouseLeave={(e) => {
        if (!opts.sub) return;
        const to = e.relatedTarget as Node | null;
        if (to && (e.currentTarget as HTMLElement).contains(to)) return;
        setOpenSub(null);
      }}
      onClick={(e) => { e.stopPropagation(); runFn(); }}>
      <svg class="ico ico-14"><use href={"#" + icon} /></svg>
      <span class="t">{label}</span>
      <Show when={opts.sub}>
        <svg class="ico ico-12"><use href="#i-chev-r" /></svg>
        <Show when={openSub() === opts.sub}>
        <div class="sub-drop open" ref={(node) => queueMicrotask(() => positionSub(node))}>
          {opts.sub === "table" ? (
            <div class="ctx-gridwrap" onClick={(e) => e.stopPropagation()}>
              <div class="ctx-gridlab">{hover().c} 列 × {hover().r} 行</div>
              <div class="ctx-grid">
                <For each={[1, 2, 3, 4, 5, 6]}>{(r) => (
                  <For each={[1, 2, 3, 4, 5, 6, 7, 8]}>{(c) => (
                    <span class="cell" classList={{ fill: c <= hover().c && r <= hover().r }}
                      role="button" aria-label={`${c} 列 × ${r} 行`}
                      onMouseEnter={() => setHover({ c, r })}
                      onClick={(e) => { e.stopPropagation(); void run({ kind: "table", cols: c, rows: r }); }} />
                  )}</For>
                )}</For>
              </div>
            </div>
          ) : opts.sub === "heading" ? (
            <For each={[1, 2, 3, 4, 5, 6]}>{(lv) => (
              <div class="mi" data-ctx={`head-${lv}`} role="menuitem" tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); void run({ kind: "heading", level: lv }); }}>
                <span class="t">{`标题 ${lv} 级`}</span>
              </div>
            )}</For>
          ) : (
            <For each={CODE_LANGS}>{(lang) => (
              <div class="mi" data-ctx={`lang-${lang || "none"}`} role="menuitem" tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); void run({ kind: "code", lang }); }}>
                <span class="t">{lang || "无语言"}</span>
              </div>
            )}</For>
          )}
        </div>
        </Show>
      </Show>
    </div>
  );

  return (
    <div class="ctxmenu editor" ref={(node) => {
      el = node;
      queueMicrotask(() => { clamp(); focusables()[0]?.focus(); });
    }} role="menu" tabIndex={-1}
      style={{ left: props.tt.x + "px", top: props.tt.y + "px" }}
      onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
      <div class="ctx-tools">
        <For each={EDIT_ACTIONS}>{(a) => (
          <button type="button" class="ctool" title={`${a[1]}（${a[2]}）`} aria-label={a[1]}
            role="menuitem" disabled={a[4] && !hasSel()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void run({ kind: "clip", action: a[0] })}>
            <svg class="ico"><use href={"#" + a[3]} /></svg>
          </button>
        )}</For>
      </div>
      <div class="msep" />
      <div class="ctx-tools">
        <For each={WRAP_ACTIONS}>{(a) => (
          <button type="button" class="ctool" title={`${a[1]}（${a[2] || "需先选中文字"}）`} aria-label={a[1]}
            role="menuitem" disabled={!hasSel()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void run({ kind: "wrap", style: a[0] as WrapKind })}>
            <svg class="ico"><use href={"#" + a[3]} /></svg>
          </button>
        )}</For>
      </div>
      <div class="msep" />
      <div class="mgrp">插入块</div>
      <div class="ctx-tools">
        <For each={LIST_ACTIONS}>{(a) => (
          <button type="button" class="ctool" title={a[1]} aria-label={a[1]} role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void run({ kind: "list", list: a[0] as ListKind | "quote" }, a[0] !== "quote")}>
            <svg class="ico"><use href={"#" + a[2]} /></svg>
          </button>
        )}</For>
      </div>
      {menuItem("i-table", "表格", () => void run({ kind: "table", cols: 3, rows: 3 }), { sub: "table", default: true })}
      {menuItem("i-heading", "标题", () => setOpenSub("heading"), { sub: "heading" })}
      {menuItem("i-code", "代码块", () => void run({ kind: "code", lang: "" }), { sub: "code", default: true })}
      {menuItem("i-image", "图片", () => void run({ kind: "image" }))}
      {menuItem("i-link", "链接（新建）", () => void run({ kind: "link" }))}
      {menuItem("i-hr", "分隔线", () => void run({ kind: "hr" }))}
    </div>
  );
}

export function ContextMenu() {
  const s = useStore();
  async function run(tt: CtxTarget & { kind: "doc" }, item: string) {
    const m = tt.meta;
    ui.setCtxMenu(null);
    // UI-15/统一口径：菜单动作失败一律顶部提示，不再无声吞掉
    try {
      if (item === "pin") { await api.setPinned(m.id, !m.pinned); s.toast(m.pinned ? "已取消置顶" : "已置顶"); }
      // 从文档库移除 = 取消库成员身份：登记/进度/打开历史都留着，重扫该目录会再入库
      else if (item === "unlibrary") {
        await api.setInLibrary(m.id, false);
        s.toast("已从文件夹移除（进度与历史保留 · 重新打开该文件夹会再列入）");
      }
      // 从最近打开移除 = 删打开记录；若这文件从没入过库，登记连带回收
      else if (item === "unrecent") {
        const purged = await api.removeRecent(m.id);
        s.toast(purged ? "已从最近打开移除（该文档不在库，登记一并回收）" : "已从最近打开移除");
      }
      else if (item === "reveal") { void revealInFolder(m.path, s); return; }
      else if (item === "path") { void copyText(m.path); return; }
      else if (item === "link") {
        const l = "folio://open?doc=" + m.slug;
        navigator.clipboard?.writeText(l).then(() => ui.showCopied("已复制深度链接", l))
          .catch(() => s.toast("剪贴板不可用"));
        return;
      }
      void s.refreshDocs();
    } catch (e) {
      s.toast("操作失败：" + String(e));   // UI-15：菜单动作失败必须有声
    }
  }
  function copyText(text: string) {
    navigator.clipboard?.writeText(text)
      .then(() => s.toast("已复制：" + (text.length > 40 ? text.slice(0, 40) + "…" : text)))
      .catch(() => s.toast("剪贴板不可用"));
  }
  const item = (label: string, key: string, tt: CtxTarget & { kind: "doc" }, icon = "i-md") => (
    <div class="mi" onClick={() => run(tt, key)}>
      <svg class="ico ico-14"><use href={"#" + icon} /></svg><span class="t">{label}</span>
    </div>
  );
  return (
    <Show when={ui.ctxMenu()} keyed>{(tt) => (
      tt.kind === "editor"
        ? <EditorCtxMenu tt={tt as CtxTarget & { kind: "editor" }} />
        : <div class="ctxmenu" style={{ left: tt.x + "px", top: tt.y + "px" }} onClick={(e) => e.stopPropagation()}>
            {/* 文件夹/历史是两套清单：置顶与「从文件夹移除」只对文件夹成员开放，「从最近打开移除」只在历史面板开放 */}
            {(() => { const d = tt as CtxTarget & { kind: "doc" }; return (<>
              <Show when={d.meta.inLibrary}>
                {item(d.meta.pinned ? "取消置顶" : "置顶", "pin", d, "i-arrow-up")}
              </Show>
              {item("打开所在目录", "reveal", d, "i-folder-open")}
              {item("复制路径", "path", d, "i-copy")}
              {item("复制深度链接", "link", d, "i-external")}
              <div class="msep" />
              <Show when={d.meta.inLibrary}>
                {item("从文件夹移除", "unlibrary", d, "i-x")}
              </Show>
              <Show when={d.from === "recents"}>
                {item("从最近打开移除", "unrecent", d, "i-x")}
              </Show>
            </>); })()}
          </div>
    )}</Show>
  );
}

export function DropVeil(props: { on: boolean }) {
  return (
    <div id="dropveil" classList={{ on: props.on }}>
      松开鼠标即打开
      <small>支持 .md / .markdown / .txt · 多文件 · 整目录（{isTauri ? "真实磁盘路径" : "浏览器演示环境"}）</small>
    </div>
  );
}
