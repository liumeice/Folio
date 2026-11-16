/* 导航目标判定（PRD FR-4.1 / FR-5.2 的纯函数表达，供 store 与单测共用）。
 * 语义定稿（评审 D1，v1.1）：
 *  - 打开/跨会话恢复：锚点+偏移优先，ratio 兜底（内容漂移鲁棒）——由 switchTo/positions 承担；
 *  - 同文档历史导航：绝对位置优先（忠实回到"当时那一行"），锚点次之，顶部兜底；
 *  - 跨文档历史导航：secText 锚点优先，ratio 兜底（switchTo 走 positions 恢复）。 */

export type NavRequest =
  | { kind: "restore"; sec: number | null; secText: string | null; ratio: number; secOff?: number;
      /** "position"：按 ratio 绝对位置回位（历史导航）；缺省 "anchor"：锚点优先（打开恢复） */
      prefer?: "anchor" | "position" }
  | { kind: "anchor"; sec: number }
  /** 编辑 ⇄ 阅读互切的位置交接：章节 + 章节内比例（v1.2 滚动同步） */
  | { kind: "secFrac"; sec: number | null; frac: number }
  | { kind: "top" }
  | null;

/** 源码行 → {章节, 章节内比例}（topLine 为 0 起行号；outline 按 line 升序） */
export function secFracFromTopline(
  outline: { sec: number; line: number }[], topLine: number,
): { sec: number | null; frac: number } {
  if (!outline.length) return { sec: null, frac: 0 };
  if (topLine < outline[0].line) return { sec: outline[0].sec, frac: 0 };
  for (let i = outline.length - 1; i >= 0; i--) {
    const h = outline[i];
    if (topLine >= h.line) {
      const next = outline[i + 1];
      const span = next ? next.line - h.line : 1;
      return { sec: h.sec, frac: Math.min(1, Math.max(0, (topLine - h.line) / span)) };
    }
  }
  return { sec: outline[0].sec, frac: 0 };
}

/** {章节, 比例} → 源码行（0 起；找不到章节回文档首行） */
export function lineForSecFrac(
  outline: { sec: number; line: number }[], sec: number | null, frac: number,
): number {
  if (!outline.length || sec == null) return 0;
  const i = outline.findIndex((o) => o.sec === sec);
  if (i < 0) return 0;
  const h = outline[i];
  const next = outline[i + 1];
  const span = next ? next.line - h.line : 1;
  return h.line + Math.round(Math.min(1, Math.max(0, frac)) * span);
}

export interface HistLike {
  docId: number;
  sec: number | null;
  secText: string | null;
  ratio: number | null;
}

/** ratio 太小视为"在顶部"，避免微小残留触发无意义恢复 */
const RATIO_EPS = 0.02;

/** 同文档历史导航的目标判定：绝对位置优先 → 锚点 → 顶部（FR-5.2） */
export function navForHistEntrySameDoc(e: HistLike): Exclude<NavRequest, null> {
  if (e.ratio != null && e.ratio > RATIO_EPS) {
    return { kind: "restore", sec: e.sec, secText: e.secText, ratio: e.ratio, prefer: "position" };
  }
  if (e.sec != null) return { kind: "anchor", sec: e.sec };
  return { kind: "top" };
}
