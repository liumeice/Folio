/* 导航目标判定（PRD FR-4.1 / FR-5.2 的纯函数表达，供 store 与单测共用）。
 * 语义定稿（评审 D1，v1.1）：
 *  - 打开/跨会话恢复：锚点+偏移优先，ratio 兜底（内容漂移鲁棒）——由 switchTo/positions 承担；
 *  - 同文档历史导航：绝对位置优先（忠实回到"当时那一行"），锚点次之，顶部兜底；
 *  - 跨文档历史导航：secText 锚点优先，ratio 兜底（switchTo 走 positions 恢复）。
 *
 * v1.2（滚动定位同步方案）新增「一把尺」坐标系：小数源码行号 lineFloat。
 *  - 阅读窗几何 ↔ 编辑器行号一律经 data-line-start/end 锚点块表换算（本文件纯函数，单测覆盖）；
 *  - 三常量各司其职且**互不串用**（串用即累计漂移，方案 §3-R3 的 70px/80px 教训）：
 *      SYNC_TOP 只用于交接采样线；ACTIVE_SEC_ZONE 只用于大纲高亮；HEAD_OFFSET 只用于标题锚点留白。 */

export type NavRequest =
  | { kind: "restore"; sec: number | null; secText: string | null; ratio: number; secOff?: number;
      /** "position"：按 ratio 绝对位置回位（历史导航）；缺省 "anchor"：锚点优先（打开恢复） */
      prefer?: "anchor" | "position" }
  | { kind: "anchor"; sec: number }
  /** v1.2 主交接坐标：小数源码行号（编辑⇄阅读互切、跨会话恢复走这里） */
  | { kind: "line"; line: number }
  /** 原始像素复位（2026-11-18 勾选滚动修复）：版式不变的内存更新专用——
   *  line↔px 往返非互逆（pxFromLine 插值到自身 bottom，lineFromAnchors 采样到 next top），
   *  每次恢复向块顶收缩 f×块间距、连续操作累积成持续滚动。同布局恢复必须绕开行制换算。 */
  | { kind: "pixel"; y: number }
  | { kind: "top" }
  | null;

/* ── 滚动交接三常量（方案 v1.2 §4.1(e)；改任何一个都要过 tests/unit/nav.test.ts） ── */
/** 交接采样线 = 视口真实顶边。唯一容差是 1px 亚像素 epsilon（两端同用）；
 *  容差值一旦混进交接公式，就会变成"每往返一次 +容差"的累计漂移。 */
export const SYNC_TOP = 0;
/** 大纲"当前章节"判据的顶部 zone（单向使用，永不参与交接） */
export const ACTIVE_SEC_ZONE = 80;
/** 标题锚点留白 px。**唯一事实源是 app.css 的 .prose h* { scroll-margin-top: 60px }**，
 *  两处必须同值（JS 旧值 70 与 CSS 差 10px 的教训，二轮评审 3.5）。 */
export const HEAD_OFFSET = 60;
/** 交接采样点相对 scrollTop 的亚像素 epsilon（阅读/编辑两侧对称使用） */
export const SYNC_EPSILON = 1;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 锚点块：DOM 元素相对滚动内容顶的几何 + 源码行区间（闭区间，行号 0 起） */
export interface AnchorBlk { start: number; end: number; top: number; bottom: number }

/** 阅读窗像素 → 小数源码行号（方案 §4.1(b) 阅读→编辑规则，含三个防呆）：
 *  ① 取「第一个 bottom > sampleY」的块——标题外边距自然归属下一块，零高度占位自动跳过；
 *  ② 零跨度块（标题/hr，start===end）用下一块 start 补跨度，防卡行；
 *  ③ 零高度相邻块（denom≤0）pxFrac 取 0，防 NaN。 */
export function lineFromAnchors(blks: AnchorBlk[], sampleY: number, docLines: number): number | null {
  if (!blks.length) return null;
  let idx = 0;
  if (sampleY >= blks[0].top) {
    let lo = 0, hi = blks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (blks[mid].top <= sampleY) lo = mid; else hi = mid - 1;
    }
    idx = lo;
  }
  while (idx < blks.length - 1 && blks[idx].bottom <= sampleY) idx++;
  const b = blks[idx], nx = blks[idx + 1];
  const lineEnd = b.end > b.start ? b.end : (nx ? nx.start : Math.min(docLines - 1, b.start + 1));
  // 末块没有 next：用块自身渲染高度继续插值（末章读到底不失去行内精度）；零高度块防 NaN
  const denom = nx ? nx.top - b.top : Math.max(0, b.bottom - b.top);
  const pxFrac = denom > 0 ? clamp01((sampleY - b.top) / denom) : 0;
  return Math.min(docLines - 1, b.start + pxFrac * (lineEnd - b.start));
}

/** 小数源码行号 → 阅读窗像素（相对滚动内容顶；方案 §4.1(b) 编辑→阅读规则）。
 *  块选取=「包含 L 的最窄跨度块」（嵌套块中取最深处：pre>codeblock、tr>table、li>ul）；
 *  无包含块（如表分隔行）→ 就近取其后一块的顶边。 */
export function pxFromLine(blks: AnchorBlk[], lineFloat: number, docLines: number): number | null {
  if (!blks.length) return null;
  const L = Math.max(0, Math.min(docLines - 1, lineFloat));
  let best: AnchorBlk | null = null;
  for (const b of blks) {
    if (b.start <= L && L <= b.end && (!best || b.end - b.start <= best.end - best.start)) best = b;
  }
  if (!best) {
    const after = blks.find((b) => b.start >= Math.ceil(L));
    return Math.max(0, (after ?? blks[blks.length - 1]).top);
  }
  const span = best.end - best.start;
  const frac = span > 0 ? clamp01((L - best.start) / span) : 0;
  return Math.max(0, best.top + frac * Math.max(0, best.bottom - best.top));
}

/** 小数源码行号 → { 锚定章节, 章节内行偏移 }（持久化主坐标；方案 §4.3）。
 *  无 outline 时 sec=null、off=绝对行（相对第 0 行）——无标题文档同链覆盖（R4）。 */
export function lineOffFromLine(
  outline: { sec: number; line: number }[], line: number,
): { sec: number | null; off: number } {
  if (!outline.length) return { sec: null, off: line };
  if (line < outline[0].line) return { sec: null, off: line };
  let h = outline[0];
  for (let i = outline.length - 1; i >= 0; i--) if (line >= outline[i].line) { h = outline[i]; break; }
  return { sec: h.sec, off: line - h.line };
}

/** 恢复主链（方案 §4.3）：sec 仍在当前 outline 且有行偏移 → line；
 *  否则 null，调用方退回 sec 锚点+secOff / ratio 旧链（老库行兼容）。 */
export function navForRestorePos(
  pos: { sec: number | null; secLineOff: number },
  outline: { sec: number; line: number }[], docLines: number,
): NavRequest {
  const off = pos.secLineOff;
  if (off != null && off >= 0) {
    if (pos.sec == null) return { kind: "line", line: Math.min(docLines - 1, off) };
    const i = outline.findIndex((o) => o.sec === pos.sec);
    if (i >= 0) {
      const span = (i + 1 < outline.length ? outline[i + 1].line : docLines) - outline[i].line;
      return { kind: "line", line: outline[i].line + Math.min(Math.max(off, 0), Math.max(0, span - 1)) };
    }
    // 章节已被删改 → 退回旧链
  }
  return null;
}

/* ── 兼容期旧坐标（sectionFrac 交接已被 line 取代；两函数保留供搜索/深链等章节级换算复用） ── */

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

/** 章节 → 该章节起始源码行（找不到返回 null；大纲点击/Alt+↑↓ 跳章用） */
export function lineForSec(
  outline: { sec: number; line: number }[], sec: number,
): number | null {
  const i = outline.findIndex((o) => o.sec === sec);
  return i < 0 ? null : outline[i].line;
}

export interface HistLike {
  docId: number;
  sec: number | null;
  secText: string | null;
  ratio: number | null;
  /** v1.2：同文档历史的绝对位置改存小数源码行号（布局无关，免疫塌陷期 ratio 污染） */
  lineFloat?: number | null;
}

/* ── 运行期挂钩（Reader 注册实现；mathjax/mermaid/zenuml 与 store 消费）。
 * 刻意放这个零依赖模块：渲染模块 import 它不牵出 solid/ui.tsx，node --experimental-strip-types
 * 测试链（.tsx 不可解析）才能继续直测排版模块。 ── */

/** 逐块锚点补偿（方案 §4.2 第一层）：原地 DOM 替换前后以可见块为参照抵消 scrollTop 位移。
 *  补偿与"抢滚动"性质不同（抵消别人的移动而非移动内容），不受让路条件约束。 */
type Compensator = (fn: () => void) => void;
let compensator: Compensator | null = null;
export function registerAnchorCompensate(fn: Compensator | null) { compensator = fn; }
export function compensateAnchor(fn: () => void): void {
  if (compensator) compensator(fn);
  else fn();
}

/** 排版落定标记（方案 §4.3）：finalize 前 ratio 是布局塌陷值，不许覆盖已存 ratio */
let settledDocId = -1;
export function markTypesetSettled(docId: number) { settledDocId = docId; }
export function isTypesetSettled(docId: number) { return settledDocId === docId; }

/** ratio 太小视为"在顶部"，避免微小残留触发无意义恢复 */
const RATIO_EPS = 0.02;
/** lineFloat 同理：文档最开头几行的残留不算"有位置" */
const LINE_EPS = 0.5;

/** 同文档历史导航的目标判定：绝对位置优先 → 锚点 → 顶部（FR-5.2）。
 *  绝对位置 v1.2 起优先用 lineFloat（行号布局无关），旧条目退回 ratio。 */
export function navForHistEntrySameDoc(e: HistLike): Exclude<NavRequest, null> {
  if (e.lineFloat != null && e.lineFloat > LINE_EPS) return { kind: "line", line: e.lineFloat };
  if (e.ratio != null && e.ratio > RATIO_EPS) {
    return { kind: "restore", sec: e.sec, secText: e.secText, ratio: e.ratio, prefer: "position" };
  }
  if (e.sec != null) return { kind: "anchor", sec: e.sec };
  return { kind: "top" };
}
