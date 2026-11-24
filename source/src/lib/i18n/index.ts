/* i18n 唯一入口：locale 信号 + t()/tp() + 解析与持久化。
 * 设计：docs/设计方案/设计文档-多语言支持-20261124.md §3.1 / §3.5 / §3.6。
 * 依赖方向：本模块不依赖 store / ui / components；t() 在渲染期读 locale() 以获得 Solid 追踪。 */
import { createSignal } from "solid-js";
import { zhCN, type MessageKey } from "./catalog/zh-CN.ts";
import { enUS } from "./catalog/en-US.ts";
import type { LanguagePref, Locale, Params } from "./types.ts";

export type { MessageKey, LanguagePref, Locale, Params };

export const LS_PREF = "folio:localePref";
export const LS_RESOLVED = "folio:localeResolved";

const catalogs: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN as unknown as Record<string, string>,
  "en-US": enUS as unknown as Record<string, string>,
};

/** 语言偏好 → 实际 locale（设计 §2.2）：
 *  精确 zh-CN/en-US → 同语言前缀（zh-* / en-*）→ 其他语言回退 en-US → 无 navigator 兜底 zh-CN。 */
export function resolveLocale(pref: string | null | undefined, langs?: readonly string[]): Locale {
  if (pref === "zh-CN" || pref === "en-US") return pref;
  const raw = langs ?? (typeof navigator !== "undefined" ? (navigator.languages as readonly string[] | undefined) ?? [] : []);
  const list = raw.map((l) => String(l).toLowerCase());
  // 按用户语言列表顺序优先（Windows 语言列表有优先级）：先精确，再同语言前缀
  for (const l of list) {
    if (l === "zh-cn") return "zh-CN";
    if (l === "en-us") return "en-US";
  }
  for (const l of list) {
    if (l.startsWith("zh")) return "zh-CN";   // zh-TW/zh-HK/zh-Hant 暂回退 zh-CN
    if (l.startsWith("en")) return "en-US";
  }
  return list.length ? "en-US" : "zh-CN";
}

function readLS(key: string): string | null {
  try { return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null; } catch { return null; }
}
function writeLS(key: string, value: string): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); } catch { /* 隐私模式/演示环境忽略 */ }
}

/** 首帧语言：只读 localStorage 镜像（权威来源始终是 SQLite 设置）。 */
export function bootLocale(): Locale {
  return resolveLocale(readLS(LS_PREF));
}

const [locale, setLocaleSignal] = createSignal<Locale>(bootLocale());
export { locale };

/** 切换 locale：更新信号、<html lang> 与 localStorage 镜像。文档内容与排版设置不受影响。 */
export function setLocale(l: Locale): void {
  setLocaleSignal(l);
  try {
    if (typeof document !== "undefined") {
      document.documentElement.lang = l;
      document.documentElement.dir = "ltr";
    }
  } catch { /* SSR/测试环境 */ }
  writeLS(LS_RESOLVED, l);
}

/** 记住语言偏好（首帧脚本 boot-locale.js 读它） */
export function rememberPref(pref: LanguagePref): void {
  writeLS(LS_PREF, pref);
}

/** {name} 插值：只替换已知占位符；值不转义（由 JSX / escapeHtml 负责） */
export function interpolate(msg: string, params?: Params): string {
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, key: string) => (key in params ? String(params[key]) : m));
}

/** 取一条消息。缺失 key：开发环境告警，生产回退中文目录，最后回退 key 本身。 */
export function t(key: MessageKey, params?: Params): string {
  const table = catalogs[locale()];
  const msg = table[key] ?? (zhCN as unknown as Record<string, string>)[key];
  if (msg === undefined) {
    if (typeof console !== "undefined" && import.meta?.env?.DEV) console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  return interpolate(msg, params);
}

/** 复数：按 base 找 .one/.other（等），中文恒取 .other。params 里自动注入 count。 */
export function tp(base: string, count: number, params?: Params): string {
  const rule = new Intl.PluralRules(locale()).select(count);
  const table = catalogs[locale()];
  const zhTable = zhCN as unknown as Record<string, string>;
  const msg = table[`${base}.${rule}`] ?? table[`${base}.other`] ?? table[base]
    ?? zhTable[`${base}.${rule}`] ?? zhTable[`${base}.other`] ?? zhTable[base];
  if (msg === undefined) {
    if (typeof console !== "undefined" && import.meta?.env?.DEV) console.warn(`[i18n] missing plural key: ${base}`);
    return base;
  }
  return interpolate(msg, { count, ...params });
}