/* 排版设置：范围、夹紧、以及"设置 → CSS 变量"的唯一映射。
 *
 * 为什么单独成模块：抽屉里七八个控件，真正决定阅读区长相的是这层映射。
 * 放这里就能用 tests/unit/typography.test.ts 机械核对（范围夹紧 / 变量拼出的字符串 /
 * 与 Rust Settings::default 的一致性 / 密度类名在 CSS 里是否真的存在），
 * 不必每次开窗口用肉眼比。
 *
 * 与 Rust 侧的约定：字段名 camelCase 对 snake_case 由 serde 负责；
 * 默认值两边各写一份，测试负责盯住它们不打架（DEFAULTS 必须等于 DEFAULT_SETTINGS）。 */
import type { Settings } from "./types";

/** 每个数值控件的可调区间（与抽屉里的 min/max 同源，别在组件里各写一遍） */
export const RANGE: Record<string, readonly [number, number]> = {
  fsSerif: [12.5, 19.5],
  fsSans: [12.5, 18],
  lh: [1.4, 2.4],
  width: [640, 1280],
  letterSpacing: [0, 0.12],
  paraSpacing: [0.6, 2],
  codeFs: [10.5, 15.5],
  // 侧栏宽度与 layout.ts 的 SIDE_MIN/SIDE_MAX_STATIC 同界（那里还额外受窗口宽度约束，
  // 这里是设置面板里手填/步进的硬边界；上限留有余量，实际渲染时 Splitter 会按窗口再夹）
  sideWidth: [210, 560],
};

/** 控件步长（滑块刻度；字距这种小数值走 0.005 才不觉得跳） */
export const STEP: Record<string, number> = {
  fsSerif: 0.5, fsSans: 0.5, lh: 0.05, width: 20,
  letterSpacing: 0.005, paraSpacing: 0.05, codeFs: 0.5,
  sideWidth: 10,
};

/** 恢复默认用的基准（必须与 Rust `Settings::default` 一致，测试盯这件事） */
export const DEFAULTS = {
  serif: true, fsSerif: 15.5, fsSans: 14.0, width: 900, lh: 1.85,
  letterSpacing: 0, paraSpacing: 1.0, align: "left", codeFs: 12.5,
  tableDensity: "standard",
} as const;

export function clampNum(key: string, v: number): number {
  const r = RANGE[key];
  if (!r) return v;
  const [lo, hi] = r;
  // 取整精度跟着**步长**走（不是区间端点）：paraSpacing 的区间是 [0.6,2]，
  // 端点没有小数位却按 0 位取整，0 → 会错夹成 1 而不是 0.6
  const step = STEP[key] ?? 1;
  const digits = String(step).split(".")[1]?.length ?? 0;
  const f = 10 ** digits;
  return Math.round(Math.min(Math.max(v, lo), hi) * f) / f;
}

/** 段距用 em 表达，落到 CSS 时换算成 px（相对当前正文字号，视觉上才是"几行空白"） */
export function paraPx(p: Pick<Settings, "serif" | "fsSerif" | "fsSans" | "paraSpacing">): number {
  const fs = p.serif ? p.fsSerif : p.fsSans;
  return Math.round(fs * p.paraSpacing * 10) / 10;
}

export type Align = "left" | "justify";
export type Density = "compact" | "standard" | "loose";

/** 表格密度是类名而不是变量（padding 成对出现，用类比一堆变量好读） */
export function densityClass(d: string): string {
  return d === "compact" ? "density-compact" : d === "loose" ? "density-loose" : "";
}

/** 唯一的"设置 → CSS 变量"出口：App 与抽屉样张共用同一份，样张才能真的等价于正文 */
export function typeVars(p: Settings): Record<string, string> {
  return {
    "--prose-fs": `${p.serif ? p.fsSerif : p.fsSans}px`,
    // 行宽也要夹：旧库或手改 DB 里可能存着窗口放不下的值（宽度上限同 1280）
    "--prose-w": `${clampNum("width", p.width)}px`,
    "--prose-lh": `${p.lh}`,
    "--prose-ls": `${clampNum("letterSpacing", p.letterSpacing)}em`,
    "--prose-para": `${paraPx(p)}px`,
    "--prose-align": p.align,
    "--code-fs": `${clampNum("codeFs", p.codeFs)}px`,
  };
}
