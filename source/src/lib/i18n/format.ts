/* 数字 / 日期 / 相对日 的统一格式化出口（设计 §3.4 / §4.5）。
 * 一律走原生 Intl；formatter 按 (locale, options) 缓存，避免每次渲染新建对象。 */
import { locale } from "./index.ts";

const numCache = new Map<string, Intl.NumberFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();
const relCache = new Map<string, Intl.RelativeTimeFormat>();

function num(l: string, opts?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = l + "|" + JSON.stringify(opts ?? {});
  let f = numCache.get(key);
  if (!f) { f = new Intl.NumberFormat(l, opts); numCache.set(key, f); }
  return f;
}
function dateFmt(l: string, opts?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = l + "|" + JSON.stringify(opts ?? {});
  let f = dateCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(l, opts); dateCache.set(key, f); }
  return f;
}
function relFmt(l: string): Intl.RelativeTimeFormat {
  let f = relCache.get(l);
  if (!f) { f = new Intl.RelativeTimeFormat(l, { numeric: "auto" }); relCache.set(l, f); }
  return f;
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return num(locale(), opts).format(n);
}
export function formatPercent(p: number, digits = 0): string {
  return num(locale(), { style: "percent", maximumFractionDigits: digits }).format(p);
}
export function formatDate(ts: number, opts?: Intl.DateTimeFormatOptions): string {
  return dateFmt(locale(), opts ?? { year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
}
export function formatTime(ts: number): string {
  return dateFmt(locale(), { hour: "2-digit", minute: "2-digit" }).format(ts);
}
export function formatDateTime(ts: number): string {
  return dateFmt(locale(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ts);
}

/** 文件大小：KB/MB 固定两位有效小数；单位本身不翻译 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${formatNumber(Math.round(kb * 10) / 10)} KB`;
  const mb = kb / 1024;
  return `${formatNumber(Math.round(mb * 10) / 10)} MB`;
}

export type DayKind = "today" | "yesterday" | "date";

/** 本地零点差判定（侧栏与阅读器共用的唯一口径） */
export function dayKind(ts: number, now = Date.now()): DayKind {
  const a = new Date(ts); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  const diff = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  return "date";
}

/** 今天/昨天 → Intl 相对日；更早 → 日期（跨年带年份） */
export function formatRelativeDay(ts: number): string {
  const kind = dayKind(ts);
  if (kind === "today") return relFmt(locale()).format(0, "day");
  if (kind === "yesterday") return relFmt(locale()).format(-1, "day");
  const now = new Date();
  const sameYear = new Date(ts).getFullYear() === now.getFullYear();
  return formatDate(ts, sameYear
    ? { month: "2-digit", day: "2-digit" }
    : { year: "numeric", month: "2-digit", day: "2-digit" });
}