/* 左右栏宽度：分隔条拖动 + 约束计算。纯函数放这里，便于单测（tests/layout.test.ts）。
 *
 * 约束怎么定的：窗口最小宽 1000（PRD FR-11.2），rail 48 + 分隔条 6 固定，
 * 阅读区至少要留 CENTER_MIN=680（行宽上限 1120 时靠 flex 自然缩，但正文不能挤到没法读），
 * 左侧面板再宽也不超过 SIDE_MAX_STATIC=560（大纲/库列表再宽就是浪费）。
 * 所以 side 的上限 = min(560, 窗口宽 - 680)，并且永远 ≥ 下限 210。 */

export const SIDE_MIN = 210;
export const SIDE_DEFAULT = 266;      // 与 app.css 的 --w-side 初值一致，改一处必须改两处
export const SIDE_MAX_STATIC = 560;
export const CENTER_MIN = 680;
export const STEP = 16;               // 键盘方向键步长

/** 当前窗口宽度下，左侧面板允许的最大宽度 */
export function sideMax(innerWidth: number): number {
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX_STATIC, Math.floor(innerWidth) - CENTER_MIN));
}

/** 把任意来源的宽度（含 null/越界/窗口已缩窄）夹进合法区间 */
export function clampSide(px: number | null | undefined, innerWidth: number): number {
  const v = Math.round(px ?? SIDE_DEFAULT);
  return Math.min(Math.max(v, SIDE_MIN), sideMax(innerWidth));
}

/** 写 CSS 变量：侧栏宽度唯一的生效路径（.side{width:var(--w-side)}） */
export function applySide(px: number): void {
  document.documentElement.style.setProperty("--w-side", px + "px");
}
