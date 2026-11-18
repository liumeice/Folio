/* 整篇替换的最小编辑区间（源码格式化专用）。
 * 只替换公共前缀/后缀之间的中段：光标在未变化区域原样保留，一次 dispatch 可整体撤销。
 * 代理对被切开时退回整篇替换——绝不产生半个 emoji（评审 P3-4）。 */

export interface EditRange {
  from: number;
  to: number;
  insert: string;
}

/** i 是否切在代理对中间（i 指向低代理、i-1 是高代理） */
function splitsPair(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return false;
  const a = s.charCodeAt(i - 1);
  const b = s.charCodeAt(i);
  return a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff;
}

/** 把 cur 替换成 next 的最小编辑；文本相同返回 null。 */
export function commonEditRange(cur: string, next: string): EditRange | null {
  if (cur === next) return null;
  let p = 0;
  const maxP = Math.min(cur.length, next.length);
  while (p < maxP && cur.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  const maxS = Math.min(cur.length - p, next.length - p);
  while (s < maxS && cur.charCodeAt(cur.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  const from = p;
  const to = cur.length - s;
  const nextFrom = next.length - s;
  // 任一字符串的边界落在代理对中间：宁可整篇替换，也不制造非法字符串
  if (splitsPair(cur, from) || splitsPair(next, from) || splitsPair(cur, to) || splitsPair(next, nextFrom)) {
    return { from: 0, to: cur.length, insert: next };
  }
  return { from, to, insert: next.slice(from, nextFrom) };
}