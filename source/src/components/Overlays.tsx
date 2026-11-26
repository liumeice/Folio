/* 快捷键一览 / 关于 / 文档信息 / 排版弹层 / 命中浮动条 / 图片放大 / 拖放遮罩 */
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { escapeHtml } from "../lib/md";
import { countWords } from "../lib/wordcount";
import { api, isTauri } from "../lib/api";
import { revealInFolder, confirmBox, pickFolderAndScan } from "../lib/actions";
import { encLabel } from "../lib/encoding";
import { APP_VERSION, IS_DEV } from "../lib/version";
import { t, tp, type MessageKey } from "../lib/i18n";
import { formatNumber, formatDateTime, formatFileSize, formatPercent } from "../lib/i18n/format";
import type { CtxTarget } from "../lib/ui";
import type { CalloutKind, EditorCmd, InsertLabels, ListKind, WrapKind } from "../lib/mdInsert";

/* P4b（设计 §4.6.7）：右键插入模板的占位文案在点击时按当前 UI 语言生成（InsertLabels），
 * 写入文档后不回改；缺省中文在 mdInsert.ts 的 zh-CN 目录默认值里兜底。 */
const insertLabels = (): InsertLabels => ({
  column: (n: number) => t("markdown.insert.column", { index: n }),
  imageAlt: t("markdown.insert.imageAlt"),
  imagePath: t("markdown.insert.imagePath"),
  linkText: t("markdown.insert.linkText"),
  linkUrl: t("markdown.insert.linkUrl"),
});

/* 快捷键一览数据：只存 key，中英文案在渲染期经 t() 从目录取（对照表 #1–#19）。 */
const KEYMAP: { keys: MessageKey; desc: MessageKey }[] = [
  { keys: "help.keymap.open.keys", desc: "help.keymap.open.desc" },
  { keys: "help.keymap.new.keys", desc: "help.keymap.new.desc" },
  { keys: "help.keymap.search.keys", desc: "help.keymap.search.desc" },
  { keys: "help.keymap.stepHit.keys", desc: "help.keymap.stepHit.desc" },
  { keys: "help.keymap.toggleEdit.keys", desc: "help.keymap.toggleEdit.desc" },
  { keys: "help.keymap.undo.keys", desc: "help.keymap.undo.desc" },
  { keys: "help.keymap.redo.keys", desc: "help.keymap.redo.desc" },
  { keys: "help.keymap.save.keys", desc: "help.keymap.save.desc" },
  { keys: "help.keymap.saveAs.keys", desc: "help.keymap.saveAs.desc" },
  { keys: "help.keymap.wheelZoom.keys", desc: "help.keymap.wheelZoom.desc" },
  { keys: "help.keymap.format.keys", desc: "help.keymap.format.desc" },
  { keys: "help.keymap.section.keys", desc: "help.keymap.section.desc" },
  { keys: "help.keymap.history.keys", desc: "help.keymap.history.desc" },
  { keys: "help.keymap.outline.keys", desc: "help.keymap.outline.desc" },
  { keys: "help.keymap.home.keys", desc: "help.keymap.home.desc" },
  { keys: "help.keymap.rename.keys", desc: "help.keymap.rename.desc" },
  { keys: "help.keymap.esc.keys", desc: "help.keymap.esc.desc" },
  { keys: "help.keymap.quit.keys", desc: "help.keymap.quit.desc" },
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
          <div><div class="mt">{t("help.keys.title")}</div><div class="md2">{t("help.keys.sub")}</div></div>
          <span class="sp" />
          <span class="x" onClick={() => ui.setKeysOpen(false)}><svg class="ico ico-14"><use href="#i-x" /></svg></span>
        </div>
        <div class="modal-b">
          <For each={KEYMAP}>{(r) => (
            <div class="krow"><kbd>{t(r.keys)}</kbd><span class="sp" /><span>{t(r.desc)}</span></div>
          )}</For>
        </div>
        <div class="modal-f">
          <span style={{ "font-size": "11.5px", color: "var(--text-3)" }}>{t("help.keys.footer")}</span>
          <span class="sp" />
          <button class="btn" onClick={() => ui.setKeysOpen(false)}>{t("help.keys.gotIt")}</button>
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
        s.toast(t("about.openLinkFailed"));
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
          <div><div class="mt">Folio <span style={{ "font-size": "11px", color: "var(--text-3)", "font-weight": "400" }}>v{APP_VERSION} · {IS_DEV ? t("titlebar.chip.dev") : t("titlebar.chip.release")}</span></div>
            <div class="md2">{t("about.tagline")}</div></div>
          <span class="sp" />
          <span class="x" onClick={() => ui.setAboutOpen(false)}><svg class="ico ico-14"><use href="#i-x" /></svg></span>
        </div>
        <div class="modal-b">
          <div style={{ "font-size": "12.5px", color: "var(--text-2)", "line-height": "1.8", "margin-bottom": "14px" }}>
            {t("about.intro")}
          </div>
          <div class="about-stack">
            <For each={tags}>{([tag, plain]) => <span class={plain ? "tag plain" : "tag"}>{tag}</span>}</For>
          </div>
          <div style={{ "margin-top": "16px", padding: "10px 12px", border: "1px solid var(--line)", "border-radius": "var(--r-2)", "font-family": "var(--font-mono)", "font-size": "11px", color: "var(--text-3)" }}>
            {t("about.githubLabel")}<a class="about-repo" href={REPO_URL} target="_blank" rel="noopener"
              onClick={(e) => { e.preventDefault(); openRepo(); }}>github.com/liumeice/Folio</a><br />
            {t("about.docLinkLabel")}<span style={{ color: "var(--accent)" }}>folio://open?doc=&lt;slug&gt;&amp;sec=…</span><br />
            {isTauri ? tp("about.docCount", s.docs().length) : t("about.browserPreview")}
          </div>
        </div>
        <div class="modal-f"><span style={{ "font-size": "11.5px", color: "var(--text-3)" }}>{t("about.footer")}</span><span class="sp" />
          <button class="btn primary" style={{ "min-width": "88px", "justify-content": "center" }}
            onClick={() => ui.setAboutOpen(false)}>{t("about.ok")}</button></div>
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
      <div class="exporting" role="status"><span class="spin" aria-hidden="true" />{t("export.busy")}</div>
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
        <span>{t("scan.busy", { name: leafOf(dir) })}</span>
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
  // v1.1：预览态属性卡跟随草稿（字数/小节按预览文本）
  const cur = () => s.displayDoc();
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
    if (!c) return [[t("props.status"), t("side.status.noDoc")]];
    return [
      [t("props.path"), c.meta.path],
      [t("props.size"), formatFileSize(c.meta.size)],
      [t("props.chars"), t("props.charsValue", { count: formatNumber(countWords(c.src)) })],
      [t("props.sections"), t("props.sectionsValue", { sections: formatNumber(c.meta.secCount), headings: formatNumber(c.outline.length) })],
      [t("props.encoding"), encLabel(c.encoding)],
      [t("props.modified"), formatDateTime(c.meta.mtime * 1000)],
      [t("props.currentSection"), s.activeSec() != null ? (c.outline[s.activeSec()! - 1]?.text ?? "—") : "—"],
      [t("props.progress"), formatPercent(ui.readPct())],
      [t("props.docLink"), link()],
    ];
  };
  return (
    <OverlayShell id="info-overlay" mid open={ui.propsOpen()} onClose={() => ui.setPropsOpen(false)}>
      <div class="modal" style={{ width: "480px" }}>
        <div class="modal-h">
          <span class="mi2"><svg class="ico ico-18"><use href="#i-info" /></svg></span>
          <div style={{ "min-width": "0" }}><div class="mt">{t("side.status.info")}</div><div class="md2 ellip">{cur()?.meta.fileName ?? "—"}</div></div>
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
          <button class="btn" onClick={() => ui.setPropsOpen(false)}>{t("common.action.close")}</button>
          <button class="btn primary" onClick={() => {
            navigator.clipboard?.writeText(link()).then(() => ui.showCopied(t("side.status.linkCopied"), link()))
              .catch(() => s.toast(t("side.status.clipboardFail")));
          }}><svg class="ico ico-14"><use href="#i-copy" /></svg>{t("app.menu.document.copyLink")}</button>
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
        <div style={{ "margin-top": "10px", "font-size": "11.5px", color: "var(--text-3)" }}>{t("imgbox.hint")}</div>
      </div>
    </div>
  );
}

/* 排版设置已从浮层 FontPopover 迁到右侧抽屉 components/TypeDrawer.tsx（控件多了，浮层挤不下）。 */

export function HitNav() {
  return (
    <Show when={ui.hitNavVisible()}>
      <div class="hitnav">
        <button type="button" title={t("hitnav.prevTitle")} aria-label={t("hitnav.prevTitle")} onClick={() => ui.stepHit(-1)}>
          <svg class="ico ico-14"><use href="#i-chev-u" /></svg>
        </button>
        <span>{t("hitnav.match")} <b>{formatNumber(ui.hitIdx() + 1)} / {formatNumber(ui.hitCount())}</b></span>
        <button type="button" title={t("hitnav.nextTitle")} aria-label={t("hitnav.nextTitle")} onClick={() => ui.stepHit(1)}>
          <svg class="ico ico-14"><use href="#i-chev-d" /></svg>
        </button>
        <span><kbd>Enter</kbd> {t("hitnav.nextWord")} · <kbd>Esc</kbd> {t("common.action.clear")}</span>
      </div>
    </Show>
  );
}

/* ── 编辑窗右键菜单（方案 N-CTX-01；2026-11-19 按原型改版）──────
 * 功能图标一律 ui-iconset-18 图标集（需求方定夺）；标注块/Emoji 两枚图标集未覆盖，
 * 分别用原型线性符号 ix-callout 与 🙂 字形；
 * 表格/标题/代码（语言分组面板）/标注块/Emoji 表情走子面板；列表连点不关菜单。
 * 动作全部经 EditorBridge 回到 CM，文档变更一次事务。 */
/* 文案迁移 P3：常量只存 MessageKey（对照表 Overlays #62–#75），渲染期 t() 取词，语言切换即重渲染 */
interface CTool { act: string; label: MessageKey; kbd: string; needSel: boolean; icon?: string; glyph?: string; glyphCls?: string }
interface WTool { style: WrapKind; label: MessageKey; kbd: string; icon?: string; glyph?: string; glyphCls?: string }
interface LTool { list: ListKind | "quote"; label: MessageKey; icon?: string; glyph?: string; glyphCls?: string }
interface BTool { cmd: "image" | "link" | "hr" | "yaml"; label: MessageKey; icon?: string; icoCls?: string }

const EDIT_ACTIONS: CTool[] = [
  { act: "cut", label: "editor.action.cut", kbd: "Ctrl+X", needSel: true, icon: "i-scissors" },
  { act: "copy", label: "editor.action.copy", kbd: "Ctrl+C", needSel: true, icon: "i-copy" },
  { act: "paste", label: "editor.action.paste", kbd: "Ctrl+V", needSel: false, icon: "i-paste" },
  { act: "delete", label: "editor.action.delete", kbd: "Delete", needSel: true, icon: "i-trash" },
  { act: "selectAll", label: "editor.action.selectAll", kbd: "Ctrl+A", needSel: false, icon: "i-select-all" },
];

const WRAP_ACTIONS: WTool[] = [
  { style: "bold", label: "editor.wrap.bold", kbd: "Ctrl+B", icon: "i-bold" },
  { style: "italic", label: "editor.wrap.italic", kbd: "Ctrl+I", icon: "i-italic" },
  { style: "code", label: "editor.wrap.code", kbd: "", icon: "i-code" },
  { style: "strike", label: "editor.wrap.strike", kbd: "", icon: "i-strikethrough" },
  { style: "link", label: "editor.wrap.link", kbd: "", icon: "i-link" },
];

const LIST_ACTIONS: LTool[] = [
  { list: "ul", label: "editor.list.ul", icon: "i-list-bullet" },
  { list: "ol", label: "editor.list.ol", icon: "i-list-number" },
  { list: "task", label: "editor.list.task", icon: "i-task-list" },
  { list: "quote", label: "editor.list.quote", icon: "i-quote" },
];

/* 块级工具行（2026-11-26）：图片 / 链接 / 分割线 / YAML 头图标化，紧贴列表四工具下方。
 * 分割线（三段短划）与 YAML 字标在 16px 框里偏小，按原型口径单独放大。 */
const BLOCK_ACTIONS: BTool[] = [
  { cmd: "image", label: "editor.block.image", icon: "i-image" },
  { cmd: "link", label: "editor.block.link", icon: "i-link" },
  { cmd: "hr", label: "editor.block.divider", icon: "i-divider", icoCls: "ico-20" },
  { cmd: "yaml", label: "editor.block.yaml", icon: "i-yaml", icoCls: "ico-28" },
];

/* 代码块语言面板（原型口径）：分组 + 芯片；lang 即写进围栏的值，""=不带语言标识。
 * 语言标识与技术名（Rust/Python/JavaScript 等）按对照表「不翻译」口径保留字面；
 * 分组名与 纯文本/无/差异对比、「不带语言标识」提示是文案，走 key（对照表 #76–#86）。 */
interface LangItem { lang: string; label?: string; labelKey?: MessageKey; tip?: string; tipKey?: MessageKey; mute?: boolean }
const LANG_GROUPS: { group: MessageKey; items: LangItem[] }[] = [
  { group: "editor.lang.group.general", items: [
    { lang: "plaintext", labelKey: "editor.lang.option.plaintext", tip: "plaintext / text" },
    { lang: "md", label: "Markdown", tip: "md / markdown" },
    { lang: "", labelKey: "editor.lang.option.none", tipKey: "editor.lang.tip.noTag", mute: true },
  ] },
  { group: "editor.lang.group.frontend", items: [
    { lang: "js", label: "JavaScript", tip: "js / javascript" },
    { lang: "ts", label: "TypeScript", tip: "ts / typescript" },
    { lang: "jsx", label: "React", tip: "jsx / tsx" },
    { lang: "html", label: "HTML", tip: "html" },
    { lang: "css", label: "CSS", tip: "css" },
  ] },
  { group: "editor.lang.group.backend", items: [
    { lang: "rust", label: "Rust", tip: "rust" },
    { lang: "python", label: "Python", tip: "python / py" },
    { lang: "go", label: "Go", tip: "go" },
    { lang: "java", label: "Java", tip: "java" },
    { lang: "cpp", label: "C / C++", tip: "c / cpp / c++" },
    { lang: "cs", label: "C#", tip: "cs" },
  ] },
  { group: "editor.lang.group.data", items: [
    { lang: "json", label: "JSON", tip: "json" },
    { lang: "toml", label: "TOML", tip: "toml" },
    { lang: "xml", label: "XML", tip: "xml" },
    { lang: "sql", label: "SQL", tip: "sql" },
  ] },
  { group: "editor.lang.group.scripts", items: [
    { lang: "bash", label: "Shell", tip: "bash / sh / shell" },
    { lang: "powershell", label: "PowerShell", tip: "powershell" },
  ] },
  { group: "editor.lang.group.diagrams", items: [
    { lang: "mermaid", label: "Mermaid", tip: "mermaid" },
    { lang: "mathjax", label: "MathJax", tip: "mathjax / math" },
  ] },
  { group: "editor.lang.group.other", items: [
    { lang: "dockerfile", label: "Dockerfile", tip: "dockerfile" },
    { lang: "diff", labelKey: "editor.lang.option.diff", tip: "diff" },
  ] },
];

/* GitHub 风格标注块（> [!KIND]，阅读区按 md.ts GFM Callouts 渲染）；配色沿用原型口径。
 * H2 口径统一（设计文档 4.4.8）：菜单中文标签改为 NOTE=「说明」、TIP=「提示」，
 * 与 md.ts 渲染标题（说明/提示/重要/警告/危险）一致；标签走 editor.callout.* key。 */
const CALLOUTS: { kind: CalloutKind; label: MessageKey }[] = [
  { kind: "NOTE", label: "editor.callout.note" },      // 说明 / Note
  { kind: "TIP", label: "editor.callout.tip" },        // 提示 / Tip
  { kind: "IMPORTANT", label: "editor.callout.important" },
  { kind: "WARNING", label: "editor.callout.warning" },
  { kind: "CAUTION", label: "editor.callout.caution" },
];

/* Emoji 插入面板（原型 editor-ctxmenu.html 2026-11-25 目录：8 组 105 项）。
 * 单击默认插入 Unicode 字符（面板内可切「短代码」）；alt 为短代码别名，仅进悬浮提示。
 * 短代码一律取 GitHub gemoji 正名；场景提示 key 由短代码派生（editor.emoji.scene.<shortcode>），
 * 组名走 editor.emoji.group.*；Emoji 字符与 :shortcode: 不翻译。 */
interface EmojiItem { char: string; code: string; scene: MessageKey; alt?: string }
const EMOJI_GROUPS: { group: MessageKey; items: EmojiItem[] }[] = [
  { group: "editor.emoji.group.status", items: [
    { char: "✅", code: ":white_check_mark:", scene: "editor.emoji.scene.white_check_mark" },
    { char: "❌", code: ":x:", scene: "editor.emoji.scene.x" },
    { char: "⚠️", code: ":warning:", scene: "editor.emoji.scene.warning" },
    { char: "❗", code: ":exclamation:", scene: "editor.emoji.scene.exclamation" },
    { char: "❓", code: ":question:", scene: "editor.emoji.scene.question" },
    { char: "🚫", code: ":no_entry_sign:", scene: "editor.emoji.scene.no_entry_sign" },
    { char: "⛔", code: ":no_entry:", scene: "editor.emoji.scene.no_entry" },
    { char: "🔴", code: ":red_circle:", scene: "editor.emoji.scene.red_circle" },
    { char: "🟡", code: ":yellow_circle:", scene: "editor.emoji.scene.yellow_circle" },
    { char: "🟢", code: ":green_circle:", scene: "editor.emoji.scene.green_circle" },
    { char: "🔵", code: ":large_blue_circle:", scene: "editor.emoji.scene.large_blue_circle" },
    { char: "⭕", code: ":o:", scene: "editor.emoji.scene.o" },
    { char: "✔️", code: ":heavy_check_mark:", scene: "editor.emoji.scene.heavy_check_mark" },
    { char: "❎", code: ":negative_squared_cross_mark:", scene: "editor.emoji.scene.negative_squared_cross_mark" },
    { char: "🏁", code: ":checkered_flag:", scene: "editor.emoji.scene.checkered_flag" },
    { char: "🔒", code: ":lock:", scene: "editor.emoji.scene.lock" },
  ] },
  { group: "editor.emoji.group.tips", items: [
    { char: "💡", code: ":bulb:", scene: "editor.emoji.scene.bulb" },
    { char: "📝", code: ":memo:", scene: "editor.emoji.scene.memo" },
    { char: "📌", code: ":pushpin:", scene: "editor.emoji.scene.pushpin" },
    { char: "📍", code: ":round_pushpin:", scene: "editor.emoji.scene.round_pushpin" },
    { char: "ℹ️", code: ":information_source:", scene: "editor.emoji.scene.information_source" },
    { char: "📢", code: ":loudspeaker:", scene: "editor.emoji.scene.loudspeaker" },
    { char: "📣", code: ":mega:", scene: "editor.emoji.scene.mega" },
    { char: "🔔", code: ":bell:", scene: "editor.emoji.scene.bell" },
    { char: "🧠", code: ":brain:", scene: "editor.emoji.scene.brain" },
    { char: "🎯", code: ":dart:", scene: "editor.emoji.scene.dart" },
    { char: "🧩", code: ":jigsaw:", scene: "editor.emoji.scene.jigsaw" },
    { char: "🔍", code: ":mag:", scene: "editor.emoji.scene.mag" },
    { char: "🔎", code: ":mag_right:", scene: "editor.emoji.scene.mag_right" },
    { char: "📖", code: ":book:", scene: "editor.emoji.scene.book" },
    { char: "📚", code: ":books:", scene: "editor.emoji.scene.books" },
    { char: "🗂️", code: ":card_index_dividers:", scene: "editor.emoji.scene.card_index_dividers" },
  ] },
  { group: "editor.emoji.group.structure", items: [
    { char: "📋", code: ":clipboard:", scene: "editor.emoji.scene.clipboard" },
    { char: "📄", code: ":page_facing_up:", scene: "editor.emoji.scene.page_facing_up" },
    { char: "📑", code: ":bookmark_tabs:", scene: "editor.emoji.scene.bookmark_tabs" },
    { char: "🗒️", code: ":spiral_notepad:", scene: "editor.emoji.scene.spiral_notepad" },
    { char: "📊", code: ":bar_chart:", scene: "editor.emoji.scene.bar_chart" },
    { char: "📈", code: ":chart_with_upwards_trend:", scene: "editor.emoji.scene.chart_with_upwards_trend" },
    { char: "📉", code: ":chart_with_downwards_trend:", scene: "editor.emoji.scene.chart_with_downwards_trend" },
    { char: "🧾", code: ":receipt:", scene: "editor.emoji.scene.receipt" },
    { char: "🗓️", code: ":spiral_calendar:", scene: "editor.emoji.scene.spiral_calendar" },
    { char: "⏱️", code: ":stopwatch:", scene: "editor.emoji.scene.stopwatch" },
    { char: "⏳", code: ":hourglass_flowing_sand:", scene: "editor.emoji.scene.hourglass_flowing_sand" },
    { char: "🔖", code: ":bookmark:", scene: "editor.emoji.scene.bookmark" },
    { char: "🔗", code: ":link:", scene: "editor.emoji.scene.link" },
    { char: "📎", code: ":paperclip:", scene: "editor.emoji.scene.paperclip" },
    { char: "🖇️", code: ":paperclips:", scene: "editor.emoji.scene.paperclips" },
    { char: "🗃️", code: ":card_file_box:", scene: "editor.emoji.scene.card_file_box" },
  ] },
  { group: "editor.emoji.group.dev", items: [
    { char: "💻", code: ":computer:", scene: "editor.emoji.scene.computer" },
    { char: "⌨️", code: ":keyboard:", scene: "editor.emoji.scene.keyboard" },
    { char: "🖥️", code: ":desktop_computer:", scene: "editor.emoji.scene.desktop_computer" },
    { char: "🐛", code: ":bug:", scene: "editor.emoji.scene.bug" },
    { char: "🔧", code: ":wrench:", scene: "editor.emoji.scene.wrench" },
    { char: "🔨", code: ":hammer:", scene: "editor.emoji.scene.hammer" },
    { char: "⚙️", code: ":gear:", scene: "editor.emoji.scene.gear" },
    { char: "🛠️", code: ":hammer_and_wrench:", scene: "editor.emoji.scene.hammer_and_wrench" },
    { char: "🚀", code: ":rocket:", scene: "editor.emoji.scene.rocket" },
    { char: "📦", code: ":package:", scene: "editor.emoji.scene.package" },
    { char: "🏗️", code: ":building_construction:", scene: "editor.emoji.scene.building_construction" },
    { char: "🧪", code: ":test_tube:", scene: "editor.emoji.scene.test_tube" },
    { char: "🧫", code: ":petri_dish:", scene: "editor.emoji.scene.petri_dish" },
    { char: "🔐", code: ":closed_lock_with_key:", scene: "editor.emoji.scene.closed_lock_with_key" },
    { char: "🌐", code: ":globe_with_meridians:", scene: "editor.emoji.scene.globe_with_meridians" },
    { char: "☁️", code: ":cloud:", scene: "editor.emoji.scene.cloud" },
    { char: "🗄️", code: ":file_cabinet:", scene: "editor.emoji.scene.file_cabinet" },
    { char: "🔄", code: ":arrows_counterclockwise:", scene: "editor.emoji.scene.arrows_counterclockwise" },
    { char: "♻️", code: ":recycle:", scene: "editor.emoji.scene.recycle" },
    { char: "🧹", code: ":broom:", scene: "editor.emoji.scene.broom" },
  ] },
  { group: "editor.emoji.group.version", items: [
    { char: "🏷️", code: ":label:", scene: "editor.emoji.scene.label" },
    { char: "📅", code: ":date:", scene: "editor.emoji.scene.date" },
    { char: "🆕", code: ":new:", scene: "editor.emoji.scene.new" },
    { char: "🆙", code: ":up:", scene: "editor.emoji.scene.up" },
    { char: "🐣", code: ":hatching_chick:", scene: "editor.emoji.scene.hatching_chick" },
    { char: "🎉", code: ":tada:", scene: "editor.emoji.scene.tada" },
    { char: "🏆", code: ":trophy:", scene: "editor.emoji.scene.trophy" },
    { char: "🥇", code: ":1st_place_medal:", scene: "editor.emoji.scene.1st_place_medal" },
    { char: "🥈", code: ":2nd_place_medal:", scene: "editor.emoji.scene.2nd_place_medal" },
    { char: "🚧", code: ":construction:", scene: "editor.emoji.scene.construction" },
    { char: "⏸️", code: ":pause_button:", scene: "editor.emoji.scene.pause_button" },
    { char: "▶️", code: ":arrow_forward:", scene: "editor.emoji.scene.arrow_forward" },
  ] },
  { group: "editor.emoji.group.collab", items: [
    { char: "👤", code: ":bust_in_silhouette:", scene: "editor.emoji.scene.bust_in_silhouette" },
    { char: "👥", code: ":busts_in_silhouette:", scene: "editor.emoji.scene.busts_in_silhouette" },
    { char: "🙋", code: ":raising_hand:", scene: "editor.emoji.scene.raising_hand" },
    { char: "✍️", code: ":writing_hand:", scene: "editor.emoji.scene.writing_hand" },
    { char: "👀", code: ":eyes:", scene: "editor.emoji.scene.eyes" },
    { char: "👍", code: ":+1:", scene: "editor.emoji.scene.+1", alt: ":thumbsup:" },
    { char: "👎", code: ":-1:", scene: "editor.emoji.scene.-1", alt: ":thumbsdown:" },
    { char: "💬", code: ":speech_balloon:", scene: "editor.emoji.scene.speech_balloon" },
    { char: "🤝", code: ":handshake:", scene: "editor.emoji.scene.handshake" },
    { char: "📮", code: ":postbox:", scene: "editor.emoji.scene.postbox" },
    { char: "🧑‍💻", code: ":technologist:", scene: "editor.emoji.scene.technologist" },
    { char: "🙌", code: ":raised_hands:", scene: "editor.emoji.scene.raised_hands" },
  ] },
  { group: "editor.emoji.group.emphasis", items: [
    { char: "⭐", code: ":star:", scene: "editor.emoji.scene.star" },
    { char: "🌟", code: ":star2:", scene: "editor.emoji.scene.star2" },
    { char: "🔥", code: ":fire:", scene: "editor.emoji.scene.fire" },
    { char: "💯", code: ":100:", scene: "editor.emoji.scene.100" },
    { char: "✨", code: ":sparkles:", scene: "editor.emoji.scene.sparkles" },
    { char: "🎨", code: ":art:", scene: "editor.emoji.scene.art" },
    { char: "🖼️", code: ":framed_picture:", scene: "editor.emoji.scene.framed_picture" },
    { char: "🎬", code: ":clapper:", scene: "editor.emoji.scene.clapper" },
  ] },
  { group: "editor.emoji.group.extra", items: [
    { char: "📱", code: ":iphone:", scene: "editor.emoji.scene.iphone" },
    { char: "📧", code: ":email:", scene: "editor.emoji.scene.email" },
    { char: "💰", code: ":moneybag:", scene: "editor.emoji.scene.moneybag" },
    { char: "💸", code: ":money_with_wings:", scene: "editor.emoji.scene.money_with_wings" },
    { char: "⏰", code: ":alarm_clock:", scene: "editor.emoji.scene.alarm_clock" },
  ] },
];
type EmojiMode = "code" | "unicode";
const emojiCodes = (it: EmojiItem) => (it.alt ? `${it.code} / ${it.alt}` : it.code);

const toolIcon = (t: { icon?: string; glyph?: string; glyphCls?: string; icoCls?: string }) =>
  t.icon
    ? <svg class={"ico" + (t.icoCls ? " " + t.icoCls : "")}><use href={"#" + t.icon} /></svg>
    : <span class={t.glyphCls}>{t.glyph}</span>;

function EditorCtxMenu(props: { tt: CtxTarget & { kind: "editor" } }) {
  const [hasSel, setHasSel] = createSignal(props.tt.hasSelection);
  const [openSub, setOpenSub] = createSignal<string | null>(null);
  const [hover, setHover] = createSignal({ c: 3, r: 3 });
  /* Emoji 插入制式：默认 Unicode 字符；面板内可切短代码（:smile:），切换不关菜单（2026-11-25 需求） */
  const [emojiMode, setEmojiMode] = createSignal<EmojiMode>("unicode");
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

  function runBlock(a: BTool) {
    if (a.cmd === "image") void run({ kind: "image", labels: insertLabels() });
    else if (a.cmd === "link") void run({ kind: "link", labels: insertLabels() });
    else if (a.cmd === "hr") void run({ kind: "hr" });
    else void run({ kind: "yaml" });
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
    return [...el.querySelectorAll<HTMLElement>(".ctool:not(:disabled), .mi[data-ctx], .lchip, .emoji-mode, .emoji-item")]
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
        queueMicrotask(() => cur.querySelector<HTMLElement>(".sub-drop .mi, .sub-drop .lchip, .sub-drop .emoji-item")?.focus());
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
          queueMicrotask(() => cur.querySelector<HTMLElement>(".sub-drop .mi, .sub-drop .lchip, .sub-drop .emoji-item")?.focus());
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

  /* label 为 MessageKey：data-ctx 用它做稳定标识（ASCII），显示文案渲染期 t() 取 */
  const menuItem = (icon: string, label: MessageKey, runFn: () => void,
    opts: { sub?: string; default?: boolean; glyph?: string; subClass?: string } = {}) => (
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
      {opts.glyph
        ? <span class="mi-glyph">{opts.glyph}</span>
        : <svg class="ico ico-14"><use href={"#" + icon} /></svg>}
      <span class="t">{t(label)}</span>
      <Show when={opts.sub}>
        <svg class="ico ico-12"><use href="#i-chev-r" /></svg>
        <Show when={openSub() === opts.sub}>
        <div class={"sub-drop open" + (opts.subClass ? " " + opts.subClass : "")}
          ref={(node) => queueMicrotask(() => positionSub(node))}>
          {opts.sub === "table" ? (
            <div class="ctx-gridwrap" onClick={(e) => e.stopPropagation()}>
              <div class="ctx-gridlab">{t("editor.panel.tableSize", { c: hover().c, r: hover().r })}</div>
              <div class="ctx-grid">
                <For each={[1, 2, 3, 4, 5, 6]}>{(r) => (
                  <For each={[1, 2, 3, 4, 5, 6, 7, 8]}>{(c) => (
                    <span class="cell" classList={{ fill: c <= hover().c && r <= hover().r }}
                      role="button" aria-label={t("editor.panel.tableSize", { c, r })}
                      onMouseEnter={() => setHover({ c, r })}
                      onClick={(e) => { e.stopPropagation(); void run({ kind: "table", cols: c, rows: r, labels: insertLabels() }); }} />
                  )}</For>
                )}</For>
              </div>
            </div>
          ) : opts.sub === "heading" ? (
            <For each={[1, 2, 3, 4, 5, 6]}>{(lv) => (
              <div class="mi" data-ctx={`head-${lv}`} role="menuitem" tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); void run({ kind: "heading", level: lv }); }}>
                <span class="mi-glyph">{`H${lv}`}</span>
                <span class="t">{t("editor.panel.headingLevel", { lv })}</span>
              </div>
            )}</For>
          ) : opts.sub === "callout" ? (
            <For each={CALLOUTS}>{(c) => (
              <div class="mi" data-ctx={`callout-${c.kind}`} data-callout={c.kind}
                role="menuitem" tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); void run({ kind: "callout", callout: c.kind }); }}>
                <span class="callout-tag">
                  <svg class="ico ico-14"><use href={"#s-" + c.kind.toLowerCase()} /></svg>
                  <b>{c.kind}</b>
                </span>
                <span class="t">{t(c.label)}</span>
              </div>
            )}</For>
          ) : opts.sub === "emoji" ? (
            <div class="ctx-emoji" onClick={(e) => e.stopPropagation()}>
              <div class="emoji-top">
                <div>
                  <div class="emoji-title">{t("editor.emoji.title")}</div>
                  <div class="emoji-sub">{t("editor.emoji.hint")}</div>
                </div>
                <div class="emoji-modes">
                  <For each={["code", "unicode"] as EmojiMode[]}>{(m) => (
                    <button type="button" class="emoji-mode" classList={{ on: emojiMode() === m }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => { e.stopPropagation(); setEmojiMode(m); }}>
                      {m === "code" ? t("editor.emoji.modeCode") : "Unicode"}
                    </button>
                  )}</For>
                </div>
              </div>
              <div class="emoji-body">
                <For each={EMOJI_GROUPS}>{(g) => (
                  <div class="emoji-group">
                    <div class="emoji-gt">{`${t(g.group)} · ${formatNumber(g.items.length)}`}</div>
                    <div class="emoji-grid">
                      <For each={g.items}>{(it) => (
                        <button type="button" class="emoji-item"
                          title={t("editor.emoji.tipFmt", { codes: emojiCodes(it), scene: t(it.scene) })}
                          aria-label={t("editor.emoji.ariaFmt", { codes: emojiCodes(it), scene: t(it.scene) })}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            void run({ kind: "emoji", text: emojiMode() === "code" ? it.code : it.char });
                          }}>
                          {it.char}
                        </button>
                      )}</For>
                    </div>
                  </div>
                )}</For>
              </div>
              <div class="emoji-foot">
                <span>{t("editor.emoji.footUnicode")}</span>
                <span>{t("editor.emoji.footCodeExample")}<code>:smile:</code></span>
              </div>
            </div>
          ) : (
            <div class="ctx-lang" onClick={(e) => e.stopPropagation()}>
              <For each={LANG_GROUPS}>{(g) => (
                <div class="lgroup">
                  <span class="glabel">{t(g.group)}</span>
                  <span class="lchips">
                    <For each={g.items}>{(it) => (
                      <span class="lchip" classList={{ mute: !!it.mute }} role="menuitem" tabIndex={-1}
                        data-ctx={`lang-${it.lang || "none"}`} title={it.tipKey ? t(it.tipKey) : it.tip}
                        onClick={(e) => { e.stopPropagation(); void run({ kind: "code", lang: it.lang }); }}>
                        {it.labelKey ? t(it.labelKey) : it.label}
                      </span>
                    )}</For>
                  </span>
                </div>
              )}</For>
            </div>
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
          <button type="button" class="ctool" title={t("editor.panel.tooltip", { label: t(a.label), kbd: a.kbd })} aria-label={t(a.label)}
            role="menuitem" disabled={a.needSel && !hasSel()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void run({ kind: "clip", action: a.act as "cut" | "copy" | "paste" | "delete" | "selectAll" })}>
            {toolIcon(a)}
          </button>
        )}</For>
      </div>
      <div class="msep" />
      <div class="ctx-tools">
        <For each={WRAP_ACTIONS}>{(a) => (
          <button type="button" class="ctool" title={t("editor.panel.tooltip", { label: t(a.label), kbd: a.kbd || t("editor.panel.needSel") })} aria-label={t(a.label)}
            role="menuitem" disabled={!hasSel()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void run({ kind: "wrap", style: a.style })}>
            {toolIcon(a)}
          </button>
        )}</For>
      </div>
      <div class="msep" />
      <div class="mgrp">{t("editor.block.insert")}</div>
      <div class="ctx-tools">
        <For each={LIST_ACTIONS}>{(a) => (
          <button type="button" class="ctool" title={t(a.label)} aria-label={t(a.label)} role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void run({ kind: "list", list: a.list }, a.list !== "quote")}>
            {toolIcon(a)}
          </button>
        )}</For>
      </div>
      <div class="ctx-tools block-tools">
        <For each={BLOCK_ACTIONS}>{(a) => (
          <button type="button" class="ctool" title={t(a.label)} aria-label={t(a.label)} role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runBlock(a)}>
            {toolIcon(a)}
          </button>
        )}</For>
      </div>
      {menuItem("i-table", "editor.block.table", () => void run({ kind: "table", cols: 3, rows: 3, labels: insertLabels() }), { sub: "table", default: true })}
      {menuItem("i-heading", "editor.block.heading", () => setOpenSub("heading"), { sub: "heading" })}
      {menuItem("i-code", "editor.block.code", () => void run({ kind: "code", lang: "" }), { sub: "code", default: true, subClass: "langpick" })}
      {menuItem("ix-callout", "editor.block.callout", () => setOpenSub("callout"), { sub: "callout" })}
      {menuItem("", "editor.emoji.title", () => setOpenSub("emoji"), { sub: "emoji", glyph: "🙂", subClass: "emojipick" })}
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
      // 重命名 = 只进就地编辑态（Enter/失焦提交、Esc 取消，见 SidePanels::RenameBox）
      if (item === "rename") { ui.setRenaming({ kind: "file", path: m.path }); return; }
      if (item === "pin") { await api.setPinned(m.id, !m.pinned); s.toast(m.pinned ? t("ctx.unpinned") : t("ctx.pinned")); }
      // 从文档库移除 = 取消库成员身份：登记/进度/打开历史都留着，重扫该目录会再入库
      else if (item === "unlibrary") {
        await api.setInLibrary(m.id, false);
        s.toast(t("ctx.removedFromFolder"));
      }
      // 从最近打开移除 = 删打开记录；若这文件从没入过库，登记连带回收
      else if (item === "unrecent") {
        const purged = await api.removeRecent(m.id);
        s.toast(purged ? t("ctx.removedFromRecentPruned") : t("ctx.removedFromRecent"));
      }
      else if (item === "reveal") { void revealInFolder(m.path, s); return; }
      else if (item === "path") { void copyText(m.path); return; }
      else if (item === "link") {
        const l = "folio://open?doc=" + m.slug;
        navigator.clipboard?.writeText(l).then(() => ui.showCopied(t("side.status.linkCopied"), l))
          .catch(() => s.toast(t("side.status.clipboardFail")));
        return;
      }
      void s.refreshDocs();
    } catch (e) {
      s.toast(t("ctx.actionFailed") + String(e));   // UI-15：菜单动作失败必须有声
    }
  }
  function copyText(text: string) {
    navigator.clipboard?.writeText(text)
      .then(() => s.toast(t("ctx.copied") + (text.length > 40 ? text.slice(0, 40) + "…" : text)))
      .catch(() => s.toast(t("side.status.clipboardFail")));
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
        : tt.kind === "dir"
          /* 目录树文件夹菜单（增强 2026-11-20）：暂只有「重命名」一项，位置与文档菜单同一套 left/top */
          ? <div class="ctxmenu" style={{ left: tt.x + "px", top: tt.y + "px" }} onClick={(e) => e.stopPropagation()}>
              <div class="mi" onClick={() => {
                ui.setCtxMenu(null);
                ui.setRenaming({ kind: "dir", path: tt.path });
              }}>
                <svg class="ico ico-14"><use href="#i-edit" /></svg><span class="t">{t("ctx.rename")}</span>
              </div>
            </div>
          : <div class="ctxmenu" style={{ left: tt.x + "px", top: tt.y + "px" }} onClick={(e) => e.stopPropagation()}>
            {/* 文件夹/历史是两套清单：置顶与「从文件夹移除」只对文件夹成员开放，「从最近打开移除」只在历史面板开放 */}
            {(() => { const d = tt as CtxTarget & { kind: "doc" }; return (<>
              <Show when={d.meta.inLibrary}>
                {item(d.meta.pinned ? t("ctx.unpin") : t("side.library.pinned"), "pin", d, "i-arrow-up")}
              </Show>
              {/* 重命名只在文件夹目录树开放（需求方 2026-11-20）：历史面板同文件走这里也能改，
                  但入口口径是目录树；内置文档不许改（帮助链接按文件名找它） */}
              <Show when={d.from === "library" && !d.meta.builtin}>
                {item(t("ctx.rename"), "rename", d, "i-edit")}
              </Show>
              {item(t("ctx.reveal"), "reveal", d, "i-folder-open")}
              {item(t("ctx.copyPath"), "path", d, "i-copy")}
              {item(t("app.menu.document.copyLink"), "link", d, "i-external")}
              <div class="msep" />
              <Show when={d.meta.inLibrary}>
                {item(t("ctx.removeFromFolder"), "unlibrary", d, "i-x")}
              </Show>
              <Show when={d.from === "recents"}>
                {item(t("side.recents.remove"), "unrecent", d, "i-x")}
              </Show>
            </>); })()}
          </div>
    )}</Show>
  );
}

export function DropVeil(props: { on: boolean }) {
  return (
    <div id="dropveil" classList={{ on: props.on }}>
      {t("dragdrop.release")}
      <small>{t("dragdrop.hint", { mode: isTauri ? t("dragdrop.modeDisk") : t("dragdrop.modeBrowser") })}</small>
    </div>
  );
}
