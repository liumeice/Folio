/* 多语言类型：语言偏好、解析后的 locale、消息占位符与结构化错误
 * 设计：docs/设计方案/设计文档-多语言支持-20261124.md §3.2 / §4.7 */

export const LANGUAGE_PREFS = ["auto", "zh-CN", "en-US"] as const;
export type LanguagePref = (typeof LANGUAGE_PREFS)[number];
/** 解析后的实际界面语言（auto 已被解析掉） */
export type Locale = Exclude<LanguagePref, "auto">;

/** 消息占位符：一律 {name} 形式，只允许字母/数字/下划线 */
export type Params = Record<string, string | number>;

/** Rust 命令层的结构化错误（设计 §4.7.2）。code 稳定、可翻译；detail 只进日志。 */
export interface ApiError {
  code: string;
  reason?: string;
  detail?: string;
  path?: string;
}