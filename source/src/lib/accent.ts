/* 强调色：色板 12 枚（2026-11-17 配色提案 02 追加六枚「日夜双档」），派生 --accent-dim / --accent-ink / --accent-bg。
 *
 * 为什么单独成模块：派生规则（档位解析、亮度反推前景墨色、dim 压暗、bg 加 alpha）是纯计算，
 * 必须能脱离 DOM 单测；视图只管"选一枚 id 写进设置"，怎么变成四个变量住在这里。
 * 与 prototype.html 的 applyAccent 逐式一致（同源），迁移前后观感不变。
 *
 * 持久化身份 = 浅色档 hex（旧六枚只有一档，即其本体）：
 *   · 暗色主题（dark）取暗档，浅色/米色（light/sepia）取浅档；
 *   · 旧六枚与任意手输 hex 一律原样使用、墨色走旧亮度阈值——「按亮度自动配墨」的既有承诺不破；
 *   · 新六枚墨色改用对比度择优（提案注 02：亮度阈值会把珊瑚红/茶金判反）。 */

import type { MessageKey } from "./i18n/catalog/zh-CN.ts";

export interface AccentDef {
  /** 设置里持久化的值（= 浅色档 hex） */
  id: string;
  /** 色名文案 key（多语言：视图渲染期 t()；持久化只认 id hex） */
  nameKey: MessageKey;
  light: string;
  dark: string;
  /** true = 日夜双档（按主题取档 + 对比度择优墨色） */
  tiered: boolean;
}

/** 色板。顺序即色板渲染序（青绿仍是默认高亮；六枚新色按提案 02 排在其后）。 */
export const ACCENTS: readonly AccentDef[] = [
  { id: "#2DD4BF", nameKey: "accent.teal", light: "#2DD4BF", dark: "#2DD4BF", tiered: false },
  { id: "#7FB2FF", nameKey: "accent.sky", light: "#7FB2FF", dark: "#7FB2FF", tiered: false },
  { id: "#A78BFA", nameKey: "accent.violet", light: "#A78BFA", dark: "#A78BFA", tiered: false },
  { id: "#F59E0B", nameKey: "accent.amber", light: "#F59E0B", dark: "#F59E0B", tiered: false },
  { id: "#FB7185", nameKey: "accent.rose", light: "#FB7185", dark: "#FB7185", tiered: false },
  { id: "#A0562A", nameKey: "accent.ochre", light: "#A0562A", dark: "#A0562A", tiered: false },
  { id: "#B53825", nameKey: "accent.vermilion", light: "#B53825", dark: "#FF826D", tiered: true },
  { id: "#1F6749", nameKey: "accent.pine", light: "#1F6749", dark: "#71D3A4", tiered: true },
  { id: "#3456B5", nameKey: "accent.indigo", light: "#3456B5", dark: "#86A7FF", tiered: true },
  { id: "#8F417B", nameKey: "accent.mauve", light: "#8F417B", dark: "#E5A3D5", tiered: true },
  { id: "#7E5A18", nameKey: "accent.teaGold", light: "#7E5A18", dark: "#E3B25E", tiered: true },
  { id: "#1B6372", nameKey: "accent.azurite", light: "#1B6372", dark: "#6CC8D6", tiered: true },
];

export function hexRgb(h: string): [number, number, number] {
  let x = String(h).replace("#", "");
  if (x.length === 3) x = x.split("").map((c) => c + c).join("");
  const n = parseInt(x, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function findAccent(id: string): AccentDef | undefined {
  const k = String(id).toLowerCase();
  return ACCENTS.find((a) => a.id.toLowerCase() === k);
}

/** 现有三主题的明暗归属；未来五套新主题进仓时在此扩表（提案 THEMES.mode）。 */
export function themeMode(theme: string): "light" | "dark" {
  return theme === "dark" ? "dark" : "light";
}

/** 空串 = 跟随主题内置强调色（不产出覆盖变量，交回 CSS 的 [data-theme] 块）。
 *  非色板 id（历史遗留自由 hex）原样使用，两档同值。 */
export function resolveAccentHex(id: string, theme: string): string {
  const a = findAccent(id);
  if (!a) return id;
  return themeMode(theme) === "dark" ? a.dark : a.light;
}

/** WCAG 相对亮度与对比度（提案 02 口径）。 */
export function relLum(hex: string): number {
  const c = hexRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const x = relLum(a), y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** 强调底上的前景墨：白与深墨谁对比高用谁（双档新色专用；旧色维持亮度阈值）。 */
export function bestInk(hex: string): string {
  return contrast(hex, "#FFFFFF") >= contrast(hex, "#0A1020") ? "#FFFFFF" : "#0A1020";
}

export function accentVars(id: string, theme: string): Record<string, string> {
  if (!id) return {};
  const a = findAccent(id);
  const hex = resolveAccentHex(id, theme);
  const [r, g, b] = hexRgb(hex);
  let ink: string;
  if (a && a.tiered) ink = bestInk(hex);
  else {
    // 相对亮度粗估（同原型口径）：亮色强调配深墨、暗色强调配白墨，保证 primary 按钮文字对比
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    ink = L > 0.6 ? "#0A1020" : "#FFFFFF";
  }
  return {
    "--accent": hex,
    "--accent-bg": `rgba(${r},${g},${b},.14)`,
    "--accent-dim": `rgb(${Math.round(r * 0.82)},${Math.round(g * 0.82)},${Math.round(b * 0.82)})`,
    "--accent-ink": ink,
  };
}

/** 唯一出口：把强调色四变量写进 body 内联。
 * 必须在 body 而非 html——body 也带 [data-theme]，其令牌块会压过 html 上的内联覆盖（同原型的坑）。
 * theme 一并传入：双档色随主题换档，主题切换时由 App 的 createEffect 重放。 */
export function applyAccent(id: string, theme: string): void {
  const vars = accentVars(id, theme);
  const keys = ["--accent", "--accent-bg", "--accent-dim", "--accent-ink"];
  if (!id) { keys.forEach((k) => document.body.style.removeProperty(k)); return; }
  for (const [k, v] of Object.entries(vars)) document.body.style.setProperty(k, v);
}
