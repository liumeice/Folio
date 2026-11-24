import type { Settings } from "./types";

/* 首启默认＝浅色主题 + 石青强调（需求方 2026-11-18 定夺）。
 * 必须与 folio-core::Settings::default() 逐字段一致：生产首启实际走 Rust 默认
 * （db.settings() 无行时 unwrap_or_default），此处服务于浏览器 mock 与导入兜底。 */
export const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  accent: "#1B6372",
  serif: true,
  fsSerif: 15.5,
  fsSans: 14,
  width: 900,
  lh: 1.85,
  libraryRoot: null,
  scanLimit: null,
  sideWidth: null,
  letterSpacing: 0,
  paraSpacing: 1.0,
  align: "left",
  codeFs: 12.5,
  tableDensity: "standard",
  restoreOnLaunch: true,
  softBreakBr: false,
  language: "auto",
};
