/* 设置中心的声明式规格：有哪几组 · 每组哪几行 · 每行吃什么控件 · 取值域 · 文案 key 与换算，
 * 全在这里，视图（SettingsPanel.tsx）不做数据判断。
 *
 * 多语言（2026-11-24）：文案只存 MessageKey，不存译文；视图在渲染期调用 t()，
 * 语言切换后 Solid 依赖 locale() 信号自动重渲染。中文目录原样搬迁，措辞零 diff。
 * Folio 真实可持久化的设置：theme / accent / restoreOnLaunch / softBreakBr / language /
 * serif / fs* / lh / letterSpacing / paraSpacing / align / width / codeFs / tableDensity / sideWidth。 */
import type { Settings } from "./types";
import type { MessageKey } from "./i18n/catalog/zh-CN.ts";
import { DEFAULTS, RANGE, STEP, clampNum } from "./typography.ts";

export type SettingGroupId = "appearance" | "type" | "paragraph" | "layout" | "code";

export interface SettingGroup {
  readonly id: SettingGroupId;
  readonly titleKey: MessageKey;
  /** 左导航图标：Icons.tsx 里的 symbol id，与原型 stab 同款（2026-11-16 补齐） */
  readonly icon: string;
}

/** 离散选项：value 参与持久化，labelKey 走目录（语言项的三个语言名用自身语言，另行处理） */
export type SettingOption = readonly [value: string, labelKey: MessageKey];

/** 行右侧控件的形状。stepper（−值+）/segment（离散胶囊）/range（滑轨）/themeCard（三张预览卡）/
 * swatch（强调色色板）/switch（开关，布尔项）/language（界面语言下拉，旗帜 + 语言名）。 */
export type SettingControl =
  | { kind: "stepper" }
  | { kind: "segment"; options: readonly SettingOption[] }
  | { kind: "range" }
  | { kind: "themeCard"; options: readonly SettingOption[] }
  | { kind: "swatch" }
  | { kind: "switch" }
  | { kind: "language" };

export interface SettingItem {
  readonly key: string;                       // 调试/测试定位用，不参与读写
  readonly group: SettingGroupId;
  readonly labelKey: MessageKey;
  readonly hintKey?: MessageKey;              // 一句解释——每项说清自己在管什么
  readonly control: SettingControl;
  /** 数值行的取值域（与 typography.RANGE 同源，构造时校验一致） */
  readonly domain?: { min: number; max: number; step: number };
  readonly get: (s: Settings) => number | string | boolean;
  /** 返回要合并进 settings 的补丁（一行可能写多个字段，如字级按 serif 分两档；switch 行给 boolean） */
  readonly set: (s: Settings, raw: number | string | boolean) => Partial<Settings>;
  /** 显示文案：把值翻成人话（带单位/比号），住在数据层，视图不拼字符串；单位不翻译 */
  readonly fmt?: (v: number | string, s: Settings) => string;
}

export const GROUPS: readonly SettingGroup[] = [
  { id: "appearance", titleKey: "settings.group.appearance", icon: "i-contrast" },
  { id: "type", titleKey: "settings.group.type", icon: "i-type" },
  { id: "paragraph", titleKey: "settings.group.paragraph", icon: "i-list" },
  { id: "layout", titleKey: "settings.group.layout", icon: "i-panel-l" },
  { id: "code", titleKey: "settings.group.code", icon: "i-code" },
];

const px = (d: number) => (v: number | string) => `${v} px`;
const em = (d: number) => (v: number | string) => `${v} em`;

/** 数值域直接引 typography 的单一来源，避免两处各写一份 min/max */
const dom = (name: keyof typeof RANGE) => ({ min: RANGE[name][0], max: RANGE[name][1], step: STEP[name] });

export const ITEMS: readonly SettingItem[] = [
  {
    key: "theme", group: "appearance", labelKey: "settings.item.theme.label",
    hintKey: "settings.item.theme.hint",
    control: { kind: "themeCard", options: [
      ["dark", "settings.option.theme.dark"], ["light", "settings.option.theme.light"], ["sepia", "settings.option.theme.sepia"],
    ] },
    get: (s) => s.theme,
    set: (_s, v) => ({ theme: v as Settings["theme"] }),
  },
  {
    key: "accent", group: "appearance", labelKey: "settings.item.accent.label",
    hintKey: "settings.item.accent.hint",
    control: { kind: "swatch" },
    get: (s) => s.accent,
    set: (_s, v) => ({ accent: String(v) }),
  },
  {
    key: "restoreOnLaunch", group: "appearance", labelKey: "settings.item.restoreOnLaunch.label",
    hintKey: "settings.item.restoreOnLaunch.hint",
    control: { kind: "switch" },
    get: (s) => s.restoreOnLaunch,
    set: (_s, v) => ({ restoreOnLaunch: v === true }),
  },
  {
    // 界面语言（多语言设计 §4.2.1）：外观与语言组第 4 行；控件是旗帜下拉（原型 2026-11-24 定夺）
    key: "language", group: "appearance", labelKey: "settings.item.language.label",
    hintKey: "settings.item.language.hint",
    control: { kind: "language" },
    get: (s) => s.language,
    set: (_s, v) => ({ language: v as Settings["language"] }),
  },
  // 侧栏宽度不列设置行：它由分隔条拖拽决定（Splitter + settings.sideWidth 持久化），
  // 再放一个 stepper 只会与拖拽各说一套、且改起来反而费劲。
  {
    key: "serif", group: "type", labelKey: "settings.item.serif.label",
    hintKey: "settings.item.serif.hint",
    control: { kind: "segment", options: [["serif", "settings.option.serif.serif"], ["sans", "settings.option.serif.sans"]] },
    get: (s) => (s.serif ? "serif" : "sans"),
    set: (_s, v) => ({ serif: v === "serif" }),
  },
  {
    key: "fs", group: "type", labelKey: "settings.item.fs.label",
    hintKey: "settings.item.fs.hint",
    control: { kind: "stepper" },
    domain: dom("fsSerif"),               // 视图会按 serif 现取 domain（见 activeDomain）
    get: (s) => (s.serif ? s.fsSerif : s.fsSans),
    set: (s, v) => (s.serif ? { fsSerif: clampNum("fsSerif", Number(v)) }
                            : { fsSans: clampNum("fsSans", Number(v)) }),
    fmt: (v) => `${v} px`,
  },

  {
    key: "lh", group: "paragraph", labelKey: "settings.item.lh.label",
    hintKey: "settings.item.lh.hint",
    control: { kind: "range" },
    domain: dom("lh"),
    get: (s) => s.lh,
    set: (_s, v) => ({ lh: clampNum("lh", Number(v)) }),
    fmt: (v) => `${v}×`,
  },
  {
    key: "letterSpacing", group: "paragraph", labelKey: "settings.item.letterSpacing.label",
    hintKey: "settings.item.letterSpacing.hint",
    control: { kind: "range" },
    domain: dom("letterSpacing"),
    get: (s) => s.letterSpacing,
    set: (_s, v) => ({ letterSpacing: clampNum("letterSpacing", Number(v)) }),
    fmt: em(3),
  },
  {
    key: "paraSpacing", group: "paragraph", labelKey: "settings.item.paraSpacing.label",
    hintKey: "settings.item.paraSpacing.hint",
    control: { kind: "stepper" },
    domain: dom("paraSpacing"),
    get: (s) => s.paraSpacing,
    set: (_s, v) => ({ paraSpacing: clampNum("paraSpacing", Number(v)) }),
    fmt: em(2),
  },
  {
    key: "align", group: "paragraph", labelKey: "settings.item.align.label",
    hintKey: "settings.item.align.hint",
    control: { kind: "segment", options: [["left", "settings.option.align.left"], ["justify", "settings.option.align.justify"]] },
    get: (s) => s.align,
    set: (_s, v) => ({ align: v as Settings["align"] }),
  },
  {
    key: "softBreakBr", group: "paragraph", labelKey: "settings.item.softBreakBr.label",
    hintKey: "settings.item.softBreakBr.hint",
    control: { kind: "switch" },
    get: (s) => s.softBreakBr,
    set: (_s, v) => ({ softBreakBr: v === true }),
  },

  {
    key: "width", group: "layout", labelKey: "settings.item.width.label",
    hintKey: "settings.item.width.hint",
    control: { kind: "range" },
    domain: dom("width"),
    get: (s) => s.width,
    set: (_s, v) => ({ width: clampNum("width", Number(v)) }),
    fmt: px(0),
  },

  {
    key: "codeFs", group: "code", labelKey: "settings.item.codeFs.label",
    hintKey: "settings.item.codeFs.hint",
    control: { kind: "stepper" },
    domain: dom("codeFs"),
    get: (s) => s.codeFs,
    set: (_s, v) => ({ codeFs: clampNum("codeFs", Number(v)) }),
    fmt: px(1),
  },
  {
    key: "tableDensity", group: "code", labelKey: "settings.item.tableDensity.label",
    hintKey: "settings.item.tableDensity.hint",
    control: { kind: "segment", options: [
      ["compact", "settings.option.tableDensity.compact"],
      ["standard", "settings.option.tableDensity.standard"],
      ["loose", "settings.option.tableDensity.loose"],
    ] },
    get: (s) => s.tableDensity,
    set: (_s, v) => ({ tableDensity: v as Settings["tableDensity"] }),
  },
];

/** 字号那一行按 serif 取不同域（衬线/无衬线上限不同）；其余行原样返回。 */
export function activeDomain(item: SettingItem, s: Settings): SettingItem["domain"] {
  if (item.key === "fs") {
    const name = s.serif ? "fsSerif" : "fsSans";
    return { min: RANGE[name][0], max: RANGE[name][1], step: STEP[name] };
  }
  return item.domain;
}

/** 步进结果夹到该域；调用方已 clampNum，这里再兜一层防手改值越界 */
export function bump(item: SettingItem, s: Settings, dir: number): number | string | boolean {
  if (typeof item.get(s) !== "number") return item.get(s);
  const d = activeDomain(item, s)!;
  const cur = item.get(s) as number;
  const name = item.key === "fs" ? (s.serif ? "fsSerif" : "fsSans") : item.key;
  const stepped = cur + dir * (d.step ?? 1);
  return Number.isFinite(stepped) ? clampNum(name, stepped) : cur;
}

/** 「恢复默认」用的补丁（只涵盖本面板能改的排版字段；theme/accent/sideWidth/language 不在此列） */
export function resetPatch(): Partial<Settings> {
  return {
    serif: DEFAULTS.serif, fsSerif: DEFAULTS.fsSerif, fsSans: DEFAULTS.fsSans,
    lh: DEFAULTS.lh, width: DEFAULTS.width, letterSpacing: DEFAULTS.letterSpacing,
    paraSpacing: DEFAULTS.paraSpacing, align: DEFAULTS.align as Settings["align"],
    codeFs: DEFAULTS.codeFs, tableDensity: DEFAULTS.tableDensity as Settings["tableDensity"],
  };
}