/* 强调色：用户可选 6 枚色板，派生 --accent-dim / --accent-ink / --accent-bg。
 *
 * 为什么单独成模块：派生规则（亮度反推前景墨色、dim 压暗、bg 加 alpha）是纯计算，
 * 必须能脱离 DOM 单测；视图只管"选一枚 hex"，怎么变成四个变量住在这里。
 * 与 prototype.html 的 applyAccent 逐式一致（同源），迁移前后观感不变。 */

/** 色板：hex→名称。顺序与原型设置页 .swatches 一致（青绿是默认高亮）。 */
export const ACCENTS: readonly (readonly [string, string])[] = [
  ["#2DD4BF", "青绿"],
  ["#7FB2FF", "淡蓝"],
  ["#A78BFA", "紫罗兰"],
  ["#F59E0B", "琥珀"],
  ["#FB7185", "玫红"],
  ["#A0562A", "赭石"],
];

export function hexRgb(h: string): [number, number, number] {
  let x = String(h).replace("#", "");
  if (x.length === 3) x = x.split("").map((c) => c + c).join("");
  const n = parseInt(x, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 空串 = 跟随主题内置强调色（不产出覆盖变量，交回 CSS 的 [data-theme] 块）。 */
export function accentVars(hex: string): Record<string, string> {
  if (!hex) return {};
  const [r, g, b] = hexRgb(hex);
  // 相对亮度粗估（同原型口径）：亮色强调配深墨、暗色强调配白墨，保证 primary 按钮文字对比
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return {
    "--accent": hex,
    "--accent-bg": `rgba(${r},${g},${b},.14)`,
    "--accent-dim": `rgb(${Math.round(r * 0.82)},${Math.round(g * 0.82)},${Math.round(b * 0.82)})`,
    "--accent-ink": L > 0.6 ? "#0A1020" : "#FFFFFF",
  };
}

/** 唯一出口：把强调色四变量写进 body 内联。
 * 必须在 body 而非 html——body 也带 [data-theme]，其令牌块会压过 html 上的内联覆盖（同原型的坑）。 */
export function applyAccent(hex: string): void {
  const vars = accentVars(hex);
  const keys = ["--accent", "--accent-bg", "--accent-dim", "--accent-ink"];
  if (!hex) { keys.forEach((k) => document.body.style.removeProperty(k)); return; }
  for (const [k, v] of Object.entries(vars)) document.body.style.setProperty(k, v);
}
