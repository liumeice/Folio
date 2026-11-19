/* 设置中心的声明式规格：有哪几组 · 每组哪几行 · 每行吃什么控件 · 取值域 · 文案与换算，
 * 全在这里，视图（SettingsPanel.tsx）一个判断都不做——照 mdediter 的 prefs/settings.ts 那套分法。
 *
 * 为什么把数据抽出来：① 能单测（每行 get/set 往返、值域与 typography.RANGE 不打架、fmt 单位、
 * 分组齐全）；② 加一栏设置只改这里一行，视图不动；③ 界面不许说谎——没在后端落地的项就不列。
 * Folio 真实可持久化的设置：theme（含护眼米色 sepia）/ accent（强调色，后端已落地，故可摆真实色板）/
 * restoreOnLaunch（启动恢复开关）/ serif / fs* / lh / letterSpacing / paraSpacing / align / width / codeFs / tableDensity / sideWidth。
 * 仍未做的（文档字体名、内容缩放、自动进入阅读、快捷键编辑、等宽连字 / 行号缩略图 / 保存时自动格式化等
 * MoPage 装饰开关）这里依旧不摆空控件——界面不许说谎。 */
import type { Settings } from "./types";
import { DEFAULTS, RANGE, STEP, clampNum } from "./typography.ts";

export type SettingGroupId = "appearance" | "type" | "paragraph" | "layout" | "code";

export interface SettingGroup {
  readonly id: SettingGroupId;
  readonly title: string;
  /** 左导航图标：Icons.tsx 里的 symbol id，与原型 stab 同款（2026-11-16 补齐） */
  readonly icon: string;
}

/** 行右侧控件的形状。stepper（−值+）/segment（离散胶囊）/range（滑轨）/themeCard（三张预览卡）/swatch（强调色色板）/switch（开关，布尔项）。 */
export type SettingControl =
  | { kind: "stepper" }
  | { kind: "segment"; options: readonly (readonly [string, string])[] }
  | { kind: "range" }
  | { kind: "themeCard"; options: readonly (readonly [string, string])[] }
  | { kind: "swatch" }
  | { kind: "switch" };

export interface SettingItem {
  readonly key: string;                       // 调试/测试定位用，不参与读写
  readonly group: SettingGroupId;
  readonly label: string;
  readonly hint?: string;                     // 一句解释——正是"层次不清"的解药：每项说清自己在管什么
  readonly control: SettingControl;
  /** 数值行的取值域（与 typography.RANGE 同源，构造时校验一致） */
  readonly domain?: { min: number; max: number; step: number };
  readonly get: (s: Settings) => number | string | boolean;
  /** 返回要合并进 settings 的补丁（一行可能写多个字段，如字级按 serif 分两档；switch 行给 boolean） */
  readonly set: (s: Settings, raw: number | string | boolean) => Partial<Settings>;
  /** 显示文案：把值翻成人话（带单位/比号），住在数据层，视图不拼字符串 */
  readonly fmt?: (v: number | string, s: Settings) => string;
}

export const GROUPS: readonly SettingGroup[] = [
  { id: "appearance", title: "外观", icon: "i-contrast" },
  { id: "type", title: "字体", icon: "i-type" },
  { id: "paragraph", title: "段落", icon: "i-list" },
  { id: "layout", title: "版面", icon: "i-panel-l" },
  { id: "code", title: "代码与表格", icon: "i-code" },
];

const px = (d: number) => (v: number | string) => `${v} px`;
const em = (d: number) => (v: number | string) => `${v} em`;

/** 数值域直接引 typography 的单一来源，避免两处各写一份 min/max */
const dom = (name: keyof typeof RANGE) => ({ min: RANGE[name][0], max: RANGE[name][1], step: STEP[name] });

export const ITEMS: readonly SettingItem[] = [
  {
    key: "theme", group: "appearance", label: "主题",
    hint: "三套配色都按小字可读性调过对比度；选中立即生效，下次启动仍然记得。",
    control: { kind: "themeCard", options: [["dark", "深色"], ["light", "浅色"], ["sepia", "护眼米色"]] },
    get: (s) => s.theme,
    set: (_s, v) => ({ theme: v as Settings["theme"] }),
  },
  {
    key: "accent", group: "appearance", label: "强调色",
    hint: "选一个颜色用在按钮、链接和高亮上；深色和浅色主题下会自动取合适的深浅，保证看得清。",
    control: { kind: "swatch" },
    get: (s) => s.accent,
    set: (_s, v) => ({ accent: String(v) }),
  },
  {
    key: "restoreOnLaunch", group: "appearance", label: "启动时恢复上次文档",
    hint: "关闭后启动不再自动打开上次关闭时的文档，启动更快；需要时从「最近打开」随时找回，阅读位置不丢。",
    control: { kind: "switch" },
    get: (s) => s.restoreOnLaunch,
    set: (_s, v) => ({ restoreOnLaunch: v === true }),
  },
  // 侧栏宽度不列设置行：它由分隔条拖拽决定（Splitter + settings.sideWidth 持久化），
  // 再放一个 stepper 只会与拖拽各说一套、且改起来反而费劲。
  {
    key: "serif", group: "type", label: "字体族",
    hint: "正文用衬线还是无衬线；两族各自记住字号，切换不丢设置。",
    control: { kind: "segment", options: [["serif", "衬线"], ["sans", "无衬线"]] },
    get: (s) => (s.serif ? "serif" : "sans"),
    set: (_s, v) => ({ serif: v === "serif" }),
  },
  {
    key: "fs", group: "type", label: "正文字号",
    hint: "范围随字体族不同（衬线上限更高）；恢复默认回到各族基准。",
    control: { kind: "stepper" },
    domain: dom("fsSerif"),               // 视图会按 serif 现取 domain（见 activeDomain）
    get: (s) => (s.serif ? s.fsSerif : s.fsSans),
    set: (s, v) => (s.serif ? { fsSerif: clampNum("fsSerif", Number(v)) }
                            : { fsSans: clampNum("fsSans", Number(v)) }),
    fmt: (v) => `${v} px`,
  },

  {
    key: "lh", group: "paragraph", label: "行高",
    hint: "行距 = 字号 × 倍数。中文正文 1.7–2.0 最舒服。",
    control: { kind: "range" },
    domain: dom("lh"),
    get: (s) => s.lh,
    set: (_s, v) => ({ lh: clampNum("lh", Number(v)) }),
    fmt: (v) => `${v}×`,
  },
  {
    key: "letterSpacing", group: "paragraph", label: "字距",
    hint: "字与字之间多加一点空隙，0 就是不加；中文长文稍加一点更好读。",
    control: { kind: "range" },
    domain: dom("letterSpacing"),
    get: (s) => s.letterSpacing,
    set: (_s, v) => ({ letterSpacing: clampNum("letterSpacing", Number(v)) }),
    fmt: em(3),
  },
  {
    key: "paraSpacing", group: "paragraph", label: "段落间距",
    hint: "段与段之间的空白，按正文字号倍数换算。",
    control: { kind: "stepper" },
    domain: dom("paraSpacing"),
    get: (s) => s.paraSpacing,
    set: (_s, v) => ({ paraSpacing: clampNum("paraSpacing", Number(v)) }),
    fmt: em(2),
  },
  {
    key: "align", group: "paragraph", label: "对齐方式",
    hint: "两端对齐让中文右缘整齐；左对齐保留自然参差。",
    control: { kind: "segment", options: [["left", "左对齐"], ["justify", "两端对齐"]] },
    get: (s) => s.align,
    set: (_s, v) => ({ align: v as Settings["align"] }),
  },

  {
    key: "width", group: "layout", label: "页面最大宽度",
    hint: "正文一行最宽多少像素；越窄越好读，越宽屏利用率越高。",
    control: { kind: "range" },
    domain: dom("width"),
    get: (s) => s.width,
    set: (_s, v) => ({ width: clampNum("width", Number(v)) }),
    fmt: px(0),
  },

  {
    key: "codeFs", group: "code", label: "代码字号",
    hint: "代码块比正文略小更耐读；只影响代码块，不动正文。",
    control: { kind: "stepper" },
    domain: dom("codeFs"),
    get: (s) => s.codeFs,
    set: (_s, v) => ({ codeFs: clampNum("codeFs", Number(v)) }),
    fmt: px(1),
  },
  {
    key: "tableDensity", group: "code", label: "表格密度",
    hint: "表格单元格的松紧三档。",
    control: { kind: "segment", options: [["compact", "紧凑"], ["standard", "标准"], ["loose", "宽松"]] },
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

/** 「恢复默认」用的补丁（只涵盖本面板能改的字段，theme/sideWidth 不在此列——那是偏好不是排版） */
export function resetPatch(): Partial<Settings> {
  return {
    serif: DEFAULTS.serif, fsSerif: DEFAULTS.fsSerif, fsSans: DEFAULTS.fsSans,
    lh: DEFAULTS.lh, width: DEFAULTS.width, letterSpacing: DEFAULTS.letterSpacing,
    paraSpacing: DEFAULTS.paraSpacing, align: DEFAULTS.align as Settings["align"],
    codeFs: DEFAULTS.codeFs, tableDensity: DEFAULTS.tableDensity as Settings["tableDensity"],
  };
}
