/* 设置中心：逐像素移植原型 MoPage 布局——左分组导航 + 右内容（抬头→分组标题→圆角卡片→一行行）。
 * 2026-11-16 形态对齐原型：居中独立浮窗（.st-win 1060×640 上限）+ 轻遮罩（.st-panel 全屏容器），
 * 主界面保持可见且挂载；关闭=Esc / 点遮罩空白（见根节点 onClick）/ 标题栏 ⚙ 再点 / 确定 / 取消。
 * 抬头动作（需求方 2026-11-18 定名）：取消 / 确定（主按钮）/ 导入配置 · 导出配置（图标钮）。
 * 本视图不做数据判断：有哪几组、每组哪几行、每行吃什么控件、取值域、文案，全在 lib/settings-spec.ts（可单测）。
 * 即时写 SQLite 语义保留：改动即时落库；「取消」= 回滚到打开面板时的快照并关窗；「确定」= 直接关窗（早已即时保存）。 */
import { For, Show, createEffect, createSignal, on, untrack } from "solid-js";
import { useStore } from "../lib/store";
import * as ui from "../lib/ui";
import { api } from "../lib/api";
import { ACCENTS } from "../lib/accent";
import { t } from "../lib/i18n";
import LangSelect from "./LangSelect";
import {
  activeDomain, bump, GROUPS, ITEMS, resetPatch,
  type SettingItem,
} from "../lib/settings-spec";

/** 三张主题卡的迷你预览配色（纹路第 1/4 条走 var(--accent)，随所选强调色实时变；其余为各主题中性色） */
const THEME_PREVIEW: Record<string, { bg: string; side: string; bar: string }> = {
  dark: { bg: "#101A2C", side: "#0E1728", bar: "#2A3B58" },
  light: { bg: "#FFFFFF", side: "#E9ECF3", bar: "#DBE0E9" },
  sepia: { bg: "#FAF4E6", side: "#EAE0C4", bar: "#DED2B9" },
};

function Control(props: { item: SettingItem }) {
  const s = useStore();
  const st = () => s.settings();
  const val = () => props.item.get(st());
  const apply = (raw: number | string | boolean) => s.saveSettings(props.item.set(st(), raw));

  if (props.item.control.kind === "themeCard") {
    return (
      <div class="thcs">
        <For each={props.item.control.options}>{([v, labelKey]) => {
          const p = THEME_PREVIEW[v] ?? THEME_PREVIEW.dark;
          return (
            <div class="thc" role="button" tabindex={0} aria-pressed={val() === v} title={t(labelKey)}
              onClick={() => apply(v)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apply(v); } }}>
              <div class="prev" style={{ background: p.bg }}>
                <span class="side" style={{ background: p.side }} />
                <span class="l" style={{ background: "var(--accent)", width: "62%" }} />
                <span class="l" style={{ background: p.bar, width: "90%" }} />
                <span class="l" style={{ background: p.bar, width: "82%" }} />
                <span class="l" style={{ background: "var(--accent)", width: "55%" }} />
              </div>
              <div class="meta">{t(labelKey)}</div>
            </div>
          );
        }}</For>
      </div>
    );
  }

  if (props.item.control.kind === "swatch") {
    const cur = () => String(val()).toLowerCase();
    return (
      <div class="swatches">
        <For each={ACCENTS}>{(a) => (
          <button type="button" class="swatch"
            title={a.tiered ? t("settings.panel.accentTiered", { name: t(a.nameKey), light: a.light, dark: a.dark }) : t(a.nameKey)}
            aria-label={t(a.nameKey)}
            classList={{ on: cur() === a.id.toLowerCase() }}
            style={{ background: a.tiered ? `linear-gradient(135deg, ${a.light} 0 50%, ${a.dark} 50% 100%)` : a.id }}
            onClick={() => apply(a.id)}>
            <span class="dot" />
          </button>
        )}</For>
      </div>
    );
  }

  if (props.item.control.kind === "segment") {
    return (
      <div class="st-radios">
        <For each={props.item.control.options}>{([v, labelKey]) => (
          <button type="button" class="st-radio" aria-pressed={val() === v}
            onClick={() => apply(v)}>{t(labelKey)}</button>
        )}</For>
      </div>
    );
  }
  // switch：布尔开关（§4.8 控件表 34×20 胶囊；aria-checked 驱动配色与钮位）
  if (props.item.control.kind === "switch") {
    const on = () => val() === true;
    return (
      <button type="button" class="st-sw" role="switch" aria-checked={on()}
        aria-label={t(props.item.labelKey)} onClick={() => apply(!on())}>
        <span class="st-sw-knob" />
      </button>
    );
  }
  // language：界面语言下拉（旗帜 + 自身语言名；紧凑形态，后续加语言只加菜单项）
  if (props.item.control.kind === "language") return <LangSelect />;
  const num = () => val() as number;
  const d = () => activeDomain(props.item, st())!;
  const shown = () => props.item.fmt
    ? props.item.fmt(val() as number, st()) : String(val());

  if (props.item.control.kind === "range") {
    return (
      <div class="st-ctlrow">
        <input type="range" class="st-slider" aria-label={t(props.item.labelKey)}
          min={d().min} max={d().max} step={d().step} value={num()}
          onInput={(e) => apply(Number(e.currentTarget.value))}
          onChange={() => s.flushSettings()} />
        <span class="st-value">{shown()}</span>
      </div>
    );
  }
  // stepper：− 值 +
  return (
    <div class="st-ctlrow">
      <button type="button" class="st-btn" aria-label={t("settings.panel.decrease", { label: t(props.item.labelKey) })}
        onClick={() => apply(bump(props.item, st(), -1))}>−</button>
      <span class="st-value">{shown()}</span>
      <button type="button" class="st-btn" aria-label={t("settings.panel.increase", { label: t(props.item.labelKey) })}
        onClick={() => apply(bump(props.item, st(), 1))}>+</button>
    </div>
  );
}

export default function SettingsPanel() {
  const s = useStore();
  const items = (gid: string) => ITEMS.filter((i) => i.group === gid);
  const [active, setActive] = createSignal<string>(GROUPS[0]?.id ?? "appearance");
  let baseline: ReturnType<typeof s.settings> | null = null;

  // CON-03：快照只依赖 settingsOpen 的「打开」沿。此前 effect 里裸读 s.settings()，
  // 任何一次改设置都会重跑本 effect 并把基线刷成"刚改完的值"——撤销成了空操作。
  // on() 限定追踪源 + untrack() 取值：只有面板从关到开才抓一次真快照。
  createEffect(on(ui.settingsOpen, (open) => {
    if (open) {
      baseline = untrack(() => ({ ...s.settings() }));
      queueMicrotask(onBodyScroll);   // 打开时先按当前滚动位置校准一次高亮
    } else s.flushSettings();   // 任何关闭路径（确定/取消/Esc/遮罩）都把待写设置落库
  }));

  /* 滚动定位（bug 2026-11-23：滚动详情页时导航高亮不跟随）。
   * 判定线=详情区视口顶 + 12px：最后一个「标题已越过判定线」的分组为当前组；
   * 滚到底时强制最后一组（末组内容短、标题永远到不了判定线的场景）。 */
  let bodyEl: HTMLDivElement | undefined;
  function onBodyScroll() {
    if (!bodyEl) return;
    const line = bodyEl.getBoundingClientRect().top + 12;
    const secs = [...bodyEl.querySelectorAll<HTMLElement>(".st-group")];
    if (!secs.length) return;
    let cur = secs[0].id;
    for (const sec of secs) {
      if (sec.getBoundingClientRect().top <= line) cur = sec.id;
    }
    if (bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 2) cur = secs[secs.length - 1].id;
    const gid = cur.replace(/^cfg-/, "");
    if (gid && gid !== active()) setActive(gid);
  }

  function goGroup(gid: string) {
    setActive(gid);
    document.getElementById(`cfg-${gid}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function onExport() {
    const path = await api.exportSettings(s.settings());
    s.toast(path ? t("settings.panel.exported", { path }) : t("settings.panel.exportCancelled"));
  }
  /* 清空本地数据库：确认框 → 删 SQLite 数据 → 重新加载（浏览器 mock 清演示数据）。
   * 只动本地库，不碰磁盘上的 Markdown 文件；设置的「取消」不参与（已删除的数据无法快照回滚）。 */
  async function onClearDb() {
    const ok = await ui.ask({
      title: t("settings.panel.clearDbTitle"),
      note: t("settings.panel.clearDbNote"),
      icon: "i-warn-tri",
      ok: t("settings.panel.clearDbConfirm"),
    });
    if (ok !== true) return;
    try {
      await api.resetDatabase();
      location.reload();
    } catch (e) {
      s.toast(t("settings.panel.clearDbFailed") + ui.fmtErr(e));
    }
  }

  async function onImport() {
    const r = await api.importSettings();   // UI-12：取消/无效/成功 三态分开提示
    if (r.kind === "cancel") return;        // 取消保持零打扰（与其它对话框口径一致）
    if (r.kind === "invalid") { s.toast(t("settings.panel.importFailed") + r.why); return; }
    s.saveSettings(r.settings);             // 整份覆盖并即时落库（字段已过白名单/夹紧校验）
    s.toast(t("settings.panel.imported"));
  }
  /* 取消 = 恢复打开面板时的快照并关闭窗口（需求方 2026-11-18：撤销更改→取消）。
   * 不弹 toast：窗子一关、界面回退本身就是反馈，取消类操作零打扰（§5.3）。 */
  function onCancel() {
    if (baseline) s.saveSettings(baseline);
    s.flushSettings();       // 回滚也必须立即落库，不能等防抖
    ui.setSettingsOpen(false);
  }

  return (
    <aside class="st-panel" id="settings-panel" role="region" aria-label={t("settings.panel.title")}
      onClick={(e) => { if (e.target === e.currentTarget) ui.setSettingsOpen(false); }}>
      <div class="st-win">

      <nav class="stabs" aria-label={t("settings.panel.sections")}>
        <div class="stabs-hd"><span class="avatar">F</span>{t("settings.panel.title")}</div>
        <For each={GROUPS}>{(g) => (
          <button type="button" class="stab" classList={{ on: active() === g.id }}
            onClick={() => goGroup(g.id)}>
            <svg class="ico ico-14" aria-hidden="true"><use href={`#${g.icon}`} /></svg>{t(g.titleKey)}
          </button>
        )}</For>
      </nav>

      <div class="st-main">
        <header class="st-head">
          <div class="st-headtext">
            <div class="st-title">{t("settings.panel.title")}</div>
            <div class="st-desc">{t("settings.panel.desc")}</div>
          </div>
          <span class="st-spacer" />
          <button type="button" class="st-action" title={t("settings.panel.importTitle")} onClick={() => void onImport()}>
            <svg class="ico ico-14"><use href="#i-upload" /></svg>
          </button>
          <button type="button" class="st-action" title={t("settings.panel.exportTitle")} onClick={() => void onExport()}>
            <svg class="ico ico-14"><use href="#i-download" /></svg>
          </button>
          {/* §8.2 按钮组口径：等宽、取消（dismiss）居左、主操作居右 */}
          <span class="mfb">
            <button type="button" class="st-action" title={t("settings.panel.cancelTitle")} onClick={onCancel}>
              <svg class="ico ico-14"><use href="#i-x" /></svg>{t("common.action.cancel")}
            </button>
            <button type="button" class="st-action primary" title={t("settings.panel.okTitle")} onClick={() => { s.flushSettings(); ui.setSettingsOpen(false); }}>
              <svg class="ico ico-14"><use href="#i-check" /></svg>{t("common.action.ok")}
            </button>
          </span>
        </header>

        <div class="st-body" ref={bodyEl} onScroll={onBodyScroll}>
          <For each={GROUPS}>{(g) => (
            <Show when={items(g.id).length > 0}>
              <section class="st-group" id={`cfg-${g.id}`}>
                <div class="st-group-title">{t(g.titleKey)}</div>
                <div class="st-card">
                  <For each={items(g.id)}>{(item) => (
                    <div class="st-row">
                      <div class="st-info">
                        <div class="st-label">{t(item.labelKey)}</div>
                        <Show when={item.hintKey}><div class="st-hint">{t(item.hintKey!)}</div></Show>
                      </div>
                      <div class="st-ctlbox"><Control item={item} /></div>
                    </div>
                  )}</For>
                </div>
              </section>
            </Show>
          )}</For>

          {/* 预览样张已于 2026-11-16 移除（需求方点名）：正文本就实时吃这些设置，样张属重复 */}

          {/* 破坏性动作放滚动区最末（需求 2026-11-24）：需要主动滚到底才可见，不占抬头/页脚显眼位 */}
          <div class="st-danger-zone">
            <button type="button" class="st-action danger" title={t("settings.panel.clearDbTitle")} onClick={() => void onClearDb()}>
              <svg class="ico ico-14" aria-hidden="true"><use href="#i-co-warning" /></svg>
              {t("settings.panel.clearDb")}
            </button>
          </div>
        </div>

        <footer class="st-foot">
          <button type="button" class="st-action" title={t("settings.panel.resetTitle")}
            onClick={() => { s.saveSettings(resetPatch()); s.toast(t("settings.panel.defaultsRestored")); }}>{t("settings.panel.reset")}</button>
          <span class="st-spacer" />
          <span class="st-foot-hint">{t("settings.panel.footer", { count: ITEMS.length })}</span>
        </footer>
      </div>
      </div>
    </aside>
  );
}
