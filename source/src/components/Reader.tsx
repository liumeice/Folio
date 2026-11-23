/* 阅读视图：渲染 + 滚动联动 + 位置源注册 + 导航执行 + 任务勾选/外链/图片。
 * 语义全部对齐 PRD：FR-2（渲染）、FR-3（大纲联动/判据）、FR-4（恢复）、FR-5（历史）、FR-7.6（勾选）。 */
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import * as ui from "../lib/ui";
import { mdToHtml, taskOrdinalOf, flipTaskInSrc, setSoftBreakBr } from "../lib/md";
import { applyColorChips } from "../lib/colorchip";
import { countWords } from "../lib/wordcount";
import { typesetMathIn } from "../lib/mathjax";
import { renderMermaid } from "../lib/mermaidRender";
import { renderZenuml } from "../lib/zenumlRender";
import {
  ACTIVE_SEC_ZONE, HEAD_OFFSET, SYNC_EPSILON,
  lineFromAnchors, pxFromLine, lineOffFromLine,
  registerAnchorCompensate, markTypesetSettled, type AnchorBlk,
} from "../lib/nav";
import type { DocFull } from "../lib/types";

/** 大纲坐标系：只认携带 data-sec 的标题（引用块/提示块内的标题无锚点，见 lib/md.ts CON-02） */
const HSEC = "h1[data-sec],h2[data-sec],h3[data-sec],h4[data-sec],h5[data-sec],h6[data-sec]";

const clip = (u: string) => (u.length > 48 ? u.slice(0, 48) + "…" : u);
function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
/** 词法拼接 base + rel（相对 .md 链接用；与 folio-fs::normalize_join 同思路，不触盘）。
 *  保留盘符/共享名根，".." 最多退到根为止，不越界。 */
function joinDocPath(baseDir: string, rel: string): string | null {
  if (!baseDir) return null;
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const parts = baseDir.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (parts.length > 1) parts.pop(); }
    else parts.push(seg);
  }
  return parts.length ? parts.join(sep) : null;
}

const EMPTY_HTML = `
  <div class="empty-state">
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="margin:0 auto;opacity:.5">
      <path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/><path d="M9 13h6M9 17h4"/>
    </svg>
    <h3>还没有打开文档</h3>
    <p>按 <b>Ctrl+O</b> 打开本地 .md，或把文件直接拖进窗口。<br>
    用菜单「文件 → 打开文件夹…」登记整个文档目录。</p>
  </div>`;

export default function Reader() {
  const s = useStore();
  let view!: HTMLDivElement;
  let article!: HTMLElement;

  /* ══ 滚动同步坐标设施（方案 v1.2 §4.1/§4.2）══
   * 一把尺：小数源码行号 lineFloat；阅读窗几何一律经 data-line-start/end 锚点块表换算。 */
  let layoutEpoch = 0;                            // 排版/主题/尺寸变化 → 锚点表几何失效
  let lastNav: ReturnType<typeof s.navRequest> = null; // 等待"终局重放"的定位请求
  let replayRounds = 0;
  let settleDeadline = 0;
  let scrollGuardUntil = 0;                       // 程序滚动豁免窗（ms）
  let pendingImages: Promise<void> = Promise.resolve();
  let lastTopLine = 0;                            // 视口顶行号（设置变更后原位还原用）
  let lastWordCount = 0;                          // 最近一次渲染的字数（任务勾选 fast path 增量维护）
  let curDoc: DocFull | null = null;              // 补偿路径同步读文档（避开信号）
  const lineCountCache = new WeakMap<DocFull, number>();

  /** 所有程序写 scrollTop 的唯一通道（applyNav/补偿/重放/设置还原）：
   *  写后开豁免窗——scroll 事件异步且可能被合并，onScroll 内滚动会滚动续窗（滚动续窗见 onScroll）。 */
  function programScroll(fn: () => void) {
    fn();
    scrollGuardUntil = Date.now() + 100;
  }

  interface AnchorSet { blks: AnchorBlk[]; els: HTMLElement[]; docLines: number }
  let anchorsCache: { key: string; set: AnchorSet } | null = null;
  /** 影响排版几何的设置签名（不含 theme：颜色不改度量，图表变色由补偿层接住）+ 视口宽（侧栏/焦点模式） */
  function typeSig(): string {
    const st = s.settings();
    return [st.serif, st.fsSerif, st.fsSans, st.width, st.lh, st.letterSpacing,
      st.paraSpacing, st.align, st.codeFs, st.tableDensity, view ? view.clientWidth : 0].join("|");
  }
  function anchors(doc: DocFull): AnchorSet | null {
    if (!view || !article || !article.isConnected) return null;
    const key = doc.meta.id + "|" + renderSeq + "|" + layoutEpoch + "|" + typeSig();
    if (anchorsCache && anchorsCache.key === key) return anchorsCache.set;
    const raw = [...article.querySelectorAll<HTMLElement>("[data-line-start]")];
    if (!raw.length) return null;
    const vr = view.getBoundingClientRect();
    const baseTop = vr.top - view.scrollTop;
    const pairs = raw.map((el) => {
      const st = Number(el.getAttribute("data-line-start"));
      const enRaw = Number(el.getAttribute("data-line-end"));
      const en = Number.isFinite(enRaw) && enRaw >= st ? enRaw : st;
      const r = el.getBoundingClientRect();
      const top = Math.max(0, r.top - baseTop);
      return { el, blk: { start: st, end: en, top, bottom: Math.max(top, r.bottom - baseTop) } };
    }).filter((p) => Number.isFinite(p.blk.start));
    // 二分不变量=按 top 升序（文档序通常成立；防御性同键双排序保持 els 配对）
    pairs.sort((a, b) => a.blk.top - b.blk.top || a.blk.start - b.blk.start);
    let n = lineCountCache.get(doc);
    if (n == null) { n = doc.src.replace(/\r\n/g, "\n").split("\n").length; lineCountCache.set(doc, n); }
    const set: AnchorSet = { blks: pairs.map((p) => p.blk), els: pairs.map((p) => p.el), docLines: n };
    anchorsCache = { key, set };
    return set;
  }
  /** 仍是同一篇文档？（任务勾选 fast path 会换 DocFull 对象但 DOM 不换；
   *  异步排版链必须按 id 判活，否则一次勾选就会让在途的公式/图表/图片水合提前中止） */
  function sameDoc(doc: DocFull): boolean {
    return s.current()?.meta.id === doc.meta.id;
  }

  /** 小数行号 → 阅读窗像素并落位 */
  function scrollToLine(line: number, doc: DocFull) {
    lastTopLine = line;
    const A = anchors(doc);
    if (!A) { programScroll(() => { view.scrollTop = 0; }); return; }
    const y = pxFromLine(A.blks, line, A.docLines);
    if (y != null) programScroll(() => { view.scrollTop = y; });
  }
  /** 视口顶（SYNC_TOP + 1px 亚像素 epsilon，与编辑侧对称）→ 小数行号 */
  function topLineOf(doc: DocFull): number | null {
    const A = anchors(doc);
    if (!A) return null;
    return lineFromAnchors(A.blks, view.scrollTop + SYNC_EPSILON, A.docLines);
  }
  /** 逐块锚点补偿：包住每次原地 DOM 替换（排版/水合/重渲），块顶位移即时抵消——
   *  用户正在读也不跳（二轮评审 3.1/3.3）；不受"让路"约束（它抵消移动，不移动内容） */
  function compensateDom(fn: () => void) {
    const doc = curDoc;
    const A = doc && s.mode() === "read" ? anchors(doc) : null;
    if (!A) { fn(); layoutEpoch++; return; }
    const y = view.scrollTop;
    let idx = A.blks.findIndex((b) => b.bottom > y + 1);
    if (idx < 0) idx = A.blks.length - 1;
    const el = A.els[idx];
    if (!el || !el.isConnected) { fn(); layoutEpoch++; return; }
    const before = el.getBoundingClientRect().top;
    fn();
    layoutEpoch++;
    const dy = el.getBoundingClientRect().top - before;
    if (Math.abs(dy) >= 1) {
      programScroll(() => { view.scrollTop = Math.max(0, view.scrollTop + dy); });
    }
  }

  /* ── 渲染（同文档对象不重刷：编辑⇄阅读互切只需要 nav，不需要重渲染） ── */
  let lastRendered: DocFull | null | undefined;
  let lastSoftBr = false; // 软换行显示策略（设置项）：变化要整篇重渲染
  let renderSeq = 0; // 防异步图片/高亮落到更新的渲染结果上
  createEffect(() => {
    const doc = s.current();
    const nav = s.navRequest();
    // 设置项依赖（需求 2026-11-23）：读取即注册依赖，开关切换时本 effect 重跑并重渲染
    const softBr = s.settings().softBreakBr === true;
    // 编辑态不渲染隐藏的阅读视图（评审 P2-2）：格式化大文档时省掉一次整篇 mdToHtml；
    // mode 是本 effect 的依赖，endEdit 设回 read 时会重跑并按新正文补渲染。
    if (s.mode() === "edit") return;
    if (!doc) {
      if (lastRendered !== null) {
        article.innerHTML = EMPTY_HTML;
        ui.setReadPct(0);
        s.setActiveSec(null);
        lastRendered = null;
      }
      return;
    }
    if (doc !== lastRendered || softBr !== lastSoftBr) {
      lastRendered = doc;
      lastSoftBr = softBr;
      setSoftBreakBr(softBr);   // 渲染前落开关（App 级 effect 已设一次，这里兜顺序）
      render(doc);
    }
    requestAnimationFrame(() => {
      applyNav(nav, doc);
      if (nav) s.clearNav();
      const [pq, hit] = ui.takePendingHighlight();
      if (pq) {
        ui.highlightAll(pq);
        if (ui.hitCount()) ui.showHitNav(ui.firstMarkOfSection(hit?.sec ?? null, hit?.text ?? null));
      }
    });
  });

  function subHtml(wc: number, doc: DocFull): string {
    return '<div class="sub"><svg class="ico"><use href="#i-file-text"/></svg><span>' +
      wc.toLocaleString() + " 字</span><span>·</span><span>约 " +
      Math.max(1, Math.round(wc / 400)) + " 分钟</span><span>·</span><span>" +
      doc.meta.secCount + " 个小节</span><span>·</span><span>更新于 " + fmtDate(doc.meta.mtime) +
      "</span></div>";
  }
  /** 任务勾选 fast path 的 .sub 同步：只换一小段 HTML，不重算整篇字数 */
  function updateSubStats(wc: number, doc: DocFull) {
    const sub = article.querySelector(".sub");
    if (sub) sub.outerHTML = subHtml(wc, doc);
  }

  function render(doc: DocFull) {
    ui.clearHits();           // 旧命中标记随 DOM 消亡，浮动条状态同步清零
    const seq = ++renderSeq;
    curDoc = doc;
    anchorsCache = null;      // 新 DOM：锚点表作废
    lastTopLine = 0;
    markTypesetSettled(-1);   // 新一版内容尚未排版：ratio 落定门重新关闸（同文档重开也不豁免）
    performance.mark("folio:render:start");
    article.innerHTML = mdToHtml(doc.src);
    performance.mark("folio:render:innerHTML");
    performance.measure("folio:render", "folio:render:start", "folio:render:innerHTML");
    // 色值前置色块（规范 §4.5）。性能审查 v3.0 P1-2：两处改动——
    // ① src 预筛：正文没有任何颜色 token 的文档直接跳过（大文档省 55–63 ms DOM 遍历）；
    // ② 有颜色的延后一帧：色块纯装饰，不参与锚点/大纲/进度几何，首帧文字先出。
    if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(doc.src)) {
      requestAnimationFrame(() => { if (seq === renderSeq) applyColorChips(article); });
    }
    const h1 = article.querySelector("h1");
    if (h1) {
      // 字数/阅读时长按正文口径现算（公式/图表源码不计，需求方 2026-11-17；lib/wordcount.ts 与 Rust stats 同规则）
      lastWordCount = countWords(doc.src);
      h1.insertAdjacentHTML("afterend", subHtml(lastWordCount, doc));
    }
    // P0-3 让路首屏：文字（含 .sub）已进 DOM，图片水合与代码着色挪到下一帧；
    // codehl 模块本身也是动态的（P0-2），highlight.js 不进入口包。
    requestAnimationFrame(() => {
      if (seq !== renderSeq) return;
      const run = () => {
        if (seq !== renderSeq) return;
        performance.mark("folio:images:start");
        pendingImages = hydrateImages(doc, seq).finally(() => {   // v1.2：图片水合收编进 typesetDone 组成项（二轮评审 3.2）
          performance.mark("folio:images:end");
          performance.measure("folio:images", "folio:images:start", "folio:images:end");
        });
        void import("../lib/codehl").then((m) => { if (seq === renderSeq) void m.highlightCodeBlocks(article); });
        void typesetDoc(doc, seq); // 公式 → 图表（内部自守卫；库缺失时各自退化 pre，不惊主流程）
      };
      // P2-4：让完一帧再让完空闲——主线程忙时压后处理，800ms 超时兜底保证最终执行
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 800 });
      else window.setTimeout(run, 120);
    });
  }

  /* 主题 ⇄ 图表配色（需求方反馈：切亮色流程图仍黑）：mermaid SVG 是烘焙色，主题变化必须原位重渲。
   * 主题值直接取 settings 信号传入——App 落 data-theme 的 effect 与本效果同源不同序，读 DOM 会慢半拍。
   * MathJax 公式用 currentColor，自动随主题，无需重排。defer 跳过首轮（首排在 typesetDoc 链里）。 */
  createEffect(on(() => s.settings().theme, (theme, prev) => {
    if (prev === undefined || theme === prev) return;
    void renderMermaid(article, undefined, theme);
    void renderZenuml(article, theme);
  }, { defer: true }));

  /* 公式/图表排版链（MathJax + Mermaid 集成 §3.1；v1.2 升级为显式排版完成信号）：
   * innerHTML 之后才准排版。顺序：math 在前、mermaid await math ——mermaid 内部要调 MathJax
   * （math mode 标签），且同容器二次 innerHTML 会抹掉首次排版产物（易错点 #9/#10）。
   * 三道守卫：renderSeq（重渲丢弃）、el.isConnected（模块内，切文档静默中止）、visibilityState
   * （隐藏页 mermaid 测量文本尺寸需要布局，恢复可见再排——易错点 #4）。
   * 链尾（含图片水合）= typesetDone：标记落定（ratio 门）+ 对 lastNav 做一次终局重放（第一层
   * 补偿保证过程不跳，这一步保证终点对；采样稳定后再兜一轮，方案 §4.2 第二/三层）。 */
  async function typesetDoc(doc: DocFull, seq: number) {
    performance.mark("folio:typeset:start");
    try {
      await whenVisible();
      if (seq !== renderSeq) return;
      await typesetMathIn(article);
      if (seq !== renderSeq || !sameDoc(doc)) return; // 或 article.contains(el)：容器已换即停
      await renderMermaid(article, undefined, s.settings().theme);
      if (seq !== renderSeq || !sameDoc(doc)) return;
      await renderZenuml(article, s.settings().theme); // zenuml 原生通道（@zenuml/core，mermaid v11 已不含该类型）
      await pendingImages;                              // 远程/本地图片尺寸落定（load 迟到由兜底层再收）
      if (seq !== renderSeq || !sameDoc(doc)) return;
      onTypesetSettled(doc, seq);
      // 第三层兜底：排版链 resolve 后仍可能有迟到尺寸（未测高远程图、字体到达）——采样稳定后再补一次
      void ui.waitArticleStable(350, 3, 4000).then(() => {
        if (seq === renderSeq && sameDoc(doc)) { layoutEpoch++; replayNav(doc); }
      });
    } finally {
      performance.mark("folio:typeset:end");
      performance.measure("folio:typeset", "folio:typeset:start", "folio:typeset:end");
    }
  }

  function onTypesetSettled(doc: DocFull, seq: number) {
    if (seq !== renderSeq || !sameDoc(doc)) return;
    layoutEpoch++;
    markTypesetSettled(doc.meta.id);
    replayNav(doc);
  }

  /** 终局重放：把最近一次定位请求在"已稳定布局"上再施加一次；最多 2 轮、8s 截止、用户滚过即让路 */
  function replayNav(doc: DocFull) {
    if (!lastNav || Date.now() > settleDeadline || replayRounds >= 2) return;
    if (!sameDoc(doc) || s.mode() !== "read") return;
    replayRounds++;
    navApply(lastNav, doc);
  }

  function whenVisible(): Promise<void> {
    if (document.visibilityState !== "hidden") return Promise.resolve();
    return new Promise((res) => {
      const f = () => { document.removeEventListener("visibilitychange", f); res(); };
      document.addEventListener("visibilitychange", f);
    });
  }

  function fmtDate(ts: number): string {
    const d = new Date(ts * 1000);
    const now = Date.now();
    if (now - ts * 1000 < 86400000) return "今天";
    if (now - ts * 1000 < 172800000) return "昨天";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /* ── 导航执行（FR-4/5） ── */
  function headingBy(anchor: number | null, text: string | null): HTMLElement | null {
    if (anchor != null) {
      const h = article.querySelector<HTMLElement>(`[data-sec="${anchor}"]`);
      if (h) return h;
    }
    if (text) {
      const hs = [...article.querySelectorAll<HTMLElement>(HSEC)];
      return hs.find((x) => x.textContent === text) ?? null;
    }
    return null;
  }


  /** 定位请求入口：登记 lastNav（供排版完成后的终局重放）并立即施加。
   *  即时首落不等排版完成——过程稳定由逐块补偿层负责，方案 §4.2 二轮评审 3.3 的取舍。 */
  function applyNav(nav: ReturnType<typeof s.navRequest>, doc: DocFull) {
    if (!nav) return;
    lastNav = nav;
    replayRounds = 0;
    settleDeadline = Date.now() + 8000;
    navApply(nav, doc);
  }

  function navApply(nav: Exclude<ReturnType<typeof s.navRequest>, null>, doc: DocFull) {
    if (nav.kind === "top") { programScroll(() => { view.scrollTop = 0; }); return; }
    // 版式不变的原位更新（勾选翻转等）：原始像素直接复位，不经 line↔px 换算（见 nav.ts pixel 注释）
    if (nav.kind === "pixel") { programScroll(() => { view.scrollTop = Math.max(0, nav.y); }); return; }
    if (nav.kind === "line") { scrollToLine(nav.line, doc); return; }
    if (nav.kind === "anchor") {
      const h = headingBy(nav.sec, doc.outline.find((o) => o.sec === nav.sec)?.text ?? null);
      if (h) { h.scrollIntoView({ behavior: "smooth", block: "start" }); flash(h); }
      return;
    }
    // restore：prefer=position → ratio 绝对优先；否则锚点+偏移优先、ratio 兜底（FR-4.1 / FR-5.2）。
    // secOff 与保存式子镜像对称（存 scrollTop-(offsetTop-HEAD_OFFSET)，恢复 +(HEAD_OFFSET)，R3 收口）
    const max = view.scrollHeight - view.clientHeight;
    if (nav.prefer !== "position") {
      const h = headingBy(nav.sec, nav.secText);
      if (h) { programScroll(() => { view.scrollTop = Math.max(0, h.offsetTop - HEAD_OFFSET + (nav.secOff ?? 0)); }); return; }
    }
    if (max > 0) programScroll(() => { view.scrollTop = nav.ratio * max; });
  }

  function flash(el: HTMLElement) {
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1600);
  }

  /** 迟到解码防推挤（方案 §4.2 图片路）：attach 时尺寸未定的图（无宽高远程图等），load 后
   *  若整体已在视口上方，scrollTop 补位移——不补就把用户正在读的内容顶下去。 */
  function watchLateShift(img: HTMLImageElement) {
    if (img.complete) return;
    const pre = img.offsetHeight;
    const onDone = () => {
      img.removeEventListener("load", onDone); img.removeEventListener("error", onDone);
      const dy = img.offsetHeight - pre;
      if (dy > 0 && view && img.getBoundingClientRect().bottom <= view.getBoundingClientRect().top) {
        layoutEpoch++;
        programScroll(() => { view.scrollTop = Math.max(0, view.scrollTop + dy); });
      }
    };
    img.addEventListener("load", onDone); img.addEventListener("error", onDone);
  }

  /* ── 本地图片资源水合（FR-2.1）：相对/根绝对路径按文档位置解析 → asset: 协议 ── */
  const IMG_CACHE_MAX = 300;
  const imgCache = new Map<string, { url: string; path: string; w: number; h: number } | null>(); // null = 未找到（P2-3：尺寸随 url 一起缓存）
  /* P2-7：缓存上限 + LRU。长时间打开大量含图文档时，按「文档路径|src」累积的 URL/尺寸
   * 不能无界增长；命中即刷新插入序，超限淘汰最久未用。 */
  function imgCacheGet(key: string) {
    const v = imgCache.get(key);
    if (v !== undefined) { imgCache.delete(key); imgCache.set(key, v); }
    return v;
  }
  function imgCacheSet(key: string, val: { url: string; path: string; w: number; h: number } | null) {
    if (imgCache.has(key)) imgCache.delete(key);
    else if (imgCache.size >= IMG_CACHE_MAX) {
      const oldest = imgCache.keys().next().value;
      if (oldest !== undefined) imgCache.delete(oldest);
    }
    imgCache.set(key, val);
  }
  function markMissing(img: HTMLImageElement, src: string) {
    img.classList.add("img-missing");
    img.title = "本地资源未找到：" + src;
  }
  /** 远程/asset 图加载失败 → 可见占位态（不再空白）；缓存失败竞态用 complete 判定兜底 */
  function watchImg(img: HTMLImageElement, src: string) {
    if (src.startsWith("data:")) return;
    if (img.complete && img.naturalWidth === 0) { markMissing(img, src); return; }
    img.addEventListener("error", () => markMissing(img, src), { once: true });
  }

  /* 远程图片=自动加载（需求方 2026-11-16 定夺，占位点击方案废弃）：渲染层直接产出
   * <img src loading=lazy>；失败态由 hydrateImages 的 watchImg 统一挂 .img-missing。 */
  async function openExternal(url: string) {
    if (!url) return;
    if (s.isTauri) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
      } catch {
        s.toast("打开外链失败");
      }
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  async function hydrateImages(doc: DocFull, seq: number) {
    const locals: { img: HTMLImageElement; src: string; key: string }[] = [];
    // 整段扫描批进一次补偿：缓存命中图的尺寸写回是同步布局改动，批前批后各测一次可见锚（不逐图测，防布局抖动）
    compensateDom(() => {
    article.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (/^(https?:|data:|blob:|asset:)/i.test(src) || /^https?:\/\/asset\.localhost/i.test(src)) {
        watchImg(img, src);
        watchLateShift(img);
        return;
      }
      if (!s.isTauri) return; // 浏览器 mock 无本地文件系统，保留原样
      const key = doc.meta.path + "|" + src;
      const c = imgCacheGet(key);
      if (c !== undefined) {
        if (c) {
          if (c.w > 0 && c.h > 0) { img.width = c.w; img.height = c.h; }
          img.src = c.url;
          img.dataset.folioLocal = c.path; // FR-13.1 导出随行：src 已被 asset URL 顶掉，磁盘路径留痕于此
          watchLateShift(img);
        } else markMissing(img, src);
        return;
      }
      locals.push({ img, src, key });
    });
    });
    if (!locals.length) return;
    const uniq = [...new Set(locals.map((l) => l.src))];
    try {
      // P1-7：整篇文档一次 IPC 批量解析磁盘路径与尺寸（P2-3）；asset URL 转换是本地纯计算（P2-7 缓存）
      const info = await api.resolveImages(doc.meta.path, uniq);
      const urls = await api.toAssetSrcs(info.map((r) => (r ? r[0] : null)));
      if (seq !== renderSeq || !sameDoc(doc)) return; // 文档已切换/已重渲，旧结果不再应用
      const bySrc = new Map<string, { url: string; path: string; w: number; h: number } | null>(
        uniq.map((u, i) => [u, info[i] && urls[i]
          ? { url: urls[i]!, path: info[i]![0], w: info[i]![1], h: info[i]![2] }
          : null]),
      );
      compensateDom(() => {
      for (const l of locals) {
        const r = bySrc.get(l.src) ?? null;
        imgCacheSet(l.key, r ? { url: r.url, path: r.path, w: r.w, h: r.h } : null);
        if (r) {
          if (r.w > 0 && r.h > 0 && !l.img.getAttribute("width")) {
            l.img.width = r.w; l.img.height = r.h; // P2-3：先占位后加载，消除到达回流
          }
          l.img.src = r.url;
          l.img.title = r.path;
          l.img.dataset.folioLocal = r.path; // FR-13.1 导出随行：src 已被 asset URL 顶掉，磁盘路径留痕于此
          watchImg(l.img, l.src);
          watchLateShift(l.img);
        } else {
          markMissing(l.img, l.src);
        }
      }
      });
    } catch {
      for (const l of locals) {
        imgCacheSet(l.key, null);
        markMissing(l.img, l.src);
      }
    }
  }

  /* ── 滚动联动（FR-3.2）与位置源（FR-4.1/4.3） ── */
  function onScroll() {
    // 让路判定：程序滚动豁免窗内续窗（平滑滚动/补偿连发的 scroll 事件异步到达，窗口太窄会误判）；
    // 窗外的 scroll 事件才是用户滚动 → 作废终局重放（方案 §4.2；防"补偿滚动判成用户滚动→重放永不执行"）
    const t = Date.now();
    if (t <= scrollGuardUntil) scrollGuardUntil = t + 60;
    else lastNav = null;
    if (s.mode() === "edit") return;
    if (!s.current()) return;
    const max = view.scrollHeight - view.clientHeight;
    const pct = max > 0 ? Math.min(1, view.scrollTop / max) : 0;
    ui.setReadPct(pct);
    // 高亮与滚动位置同帧：同步算（原 rAF 会让高亮晚一帧；快速滚动时肉眼可见）
    updateActive();
    s.schedulePosition();
  }

  /* 标题表缓存（性能复检 2026-11-18 P2）：每次 scroll 不再 querySelectorAll + 逐项读
   * offsetTop。键与锚点表同源（renderSeq / layoutEpoch / typeSig），DOM 或排版一变即重建；
   * 当前节用二分找最后一个 top <= 阈值，2,000 标题下也是 O(log n)。 */
  let headCache: { key: string; tops: number[]; secs: number[] } | null = null;
  function headingTable(doc: DocFull | null) {
    const key = (doc?.meta.id ?? "none") + "|" + renderSeq + "|" + layoutEpoch + "|" + typeSig();
    if (headCache?.key === key) return headCache;
    const els = [...article.querySelectorAll<HTMLElement>(HSEC)];
    headCache = {
      key,
      tops: els.map((h) => h.offsetTop),
      secs: els.map((h) => Number(h.dataset.sec) || 0),
    };
    return headCache;
  }

  function updateActive() {
    const doc = s.current();
    if (doc) { const tl = topLineOf(doc); if (tl != null) lastTopLine = tl; }
    const t = headingTable(doc);
    if (!t.tops.length) { s.setActiveSec(null); return; }
    const st = view.scrollTop + ACTIVE_SEC_ZONE;   // 大纲判据专用常量，不参与任何交接（R3）
    let lo = 0, hi = t.tops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t.tops[mid] <= st) lo = mid + 1; else hi = mid;
    }
    let idx = Math.max(0, lo - 1);                 // 最后一个 top <= st；首个标题之前也取首项
    const max = view.scrollHeight - view.clientHeight;
    if (max > 4 && view.scrollTop >= max - 4) idx = t.tops.length - 1;  // 触底强制末节；短文档不触发（v2 N2）
    s.setActiveSec(t.secs[idx] || null);
  }

  /* 位置源：Reader 是唯一知道滚动真相的人。
   * v1.2：主坐标 = 章节内行偏移 secLineOff（布局无关，塌陷期采集也真实，R6 防污染）；
   * srcLine 供历史条目；ratio 是布局依赖值，落盘门在 store.flushPosition（未落定时沿用旧值）。 */
  function currentPosition() {
    const doc = s.current();
    if (!doc || s.mode() === "edit") return null;
    const max = view.scrollHeight - view.clientHeight;
    const ratio = max > 0 ? Math.min(1, view.scrollTop / max) : 0;
    const srcLine = topLineOf(doc);
    const offRes = srcLine != null
      ? lineOffFromLine(doc.outline, srcLine)
      : { sec: null as number | null, off: -1 };
    const sec = offRes.sec ?? s.activeSec();
    const h = sec != null ? article.querySelector<HTMLElement>(`[data-sec="${sec}"]`) : null;
    return {
      ratio,
      sec,
      secText: h?.textContent ?? null,
      secOff: h ? Math.max(0, view.scrollTop - (h.offsetTop - HEAD_OFFSET)) : 0,  // 与恢复式子镜像对称
      secLineOff: offRes.off,
      srcLine,
      scrollY: view.scrollTop,
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }

  /* ── 章节导航（Alt+↑↓ / Home）：原型语义移植，先回章首再跳上章 ── */
  function jumpSection(dir: number) {
    const cur = s.current();
    if (!cur) return;
    if (s.mode() === "edit") {
      // 编辑态翻章：作用于编辑器（大纲跟随由 EditorPane 的 viewport 同步保证）
      const ol = cur.outline;
      if (!ol.length) return;
      const secNow = s.activeSec() ?? ol[0].sec;
      let i = ol.findIndex((o) => o.sec === secNow);
      if (i < 0) i = 0;
      if (dir > 0) {
        if (i >= ol.length - 1) { s.toast("已是最后一章"); return; }
        s.requestAnchor(ol[i + 1].sec, true);
      } else {
        s.requestAnchor(ol[Math.max(0, i - 1)].sec, true);
      }
      return;
    }
    const hs = [...article.querySelectorAll<HTMLElement>(HSEC)];
    if (!hs.length) return;
    const sec = s.activeSec();
    let idx = hs.findIndex((h) => Number(h.dataset.sec) === sec);
    if (idx < 0) idx = 0;
    if (dir > 0) {
      if (idx >= hs.length - 1) { s.toast("已是最后一章"); return; }
      goHeading(hs[idx + 1]);
    } else {
      const cur = hs[idx];
      if (cur && view.scrollTop > cur.offsetTop + 40) goHeading(cur);
      else if (idx > 0) goHeading(hs[idx - 1]);
      else view.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  function goHeading(h: HTMLElement) {
    const sec = Number(h.dataset.sec);
    if (sec) s.requestAnchor(sec, true);
  }
  function toTop() { view.scrollTo({ top: 0, behavior: "smooth" }); }

  /* ── 正文交互：复制代码块 / 任务勾选 / 外链拦截 / 图片放大 ── */
  async function onArticleClick(e: MouseEvent) {
    const t = e.target as HTMLElement;

    // 可折叠 callout（[!NOTE]- / +）：点击标题切换
    const coHead = t.closest(".co-head");
    if (coHead) {
      const box = coHead.closest<HTMLElement>(".callout");
      if (box?.dataset.fold) {
        const folded = box.classList.toggle("folded");
        coHead.setAttribute("aria-expanded", String(!folded));
      }
      return;
    }

    const copy = t.closest(".cb-copy");
    if (copy) {
      const code = copy.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
      try { await navigator.clipboard.writeText(code); s.toast("已复制代码块 · " + code.length + " 字符"); }
      catch { s.toast("复制失败：剪贴板不可用"); }
      return;
    }

    const cbx = t.closest(".cbx");
    if (cbx) {
      const doc = s.current();
      if (!doc) return;
      const li = cbx.closest("li[data-task]");
      if (!li) return;
      const nth = taskOrdinalOf(article, li as HTMLElement);
      /* 手动保存模式（需求方 2026-11-18：「打勾不要马上落盘，程序不要擅自做客户认知以外的事」）：
       * 翻转只改内存 src（flipTaskInSrc 与 folio-core::toggle_task 同坐标系）并挂脏标记，
       * 页签橙点即反馈；落盘统一走「保存」/Ctrl+S。 */
      const flipped = flipTaskInSrc(doc.src, nth);
      if (flipped == null) { s.toast("没能在这个文件里找到这一项，勾选没有生效"); return; }
      /* P1-4：勾选只改当前 <li> 的一个状态位，不整篇 mdToHtml + innerHTML 重渲染。
       * DOM 先原地改好，再把新 DocFull 登记为 lastRendered——Reader 的渲染 effect 看到
       * doc === lastRendered 就直接跳过 render()；滚动复位仍由 applySaved 的 pixel 导航负责。 */
      const nowDone = !li.classList.contains("done");
      li.classList.toggle("done", nowDone);
      li.classList.toggle("task", !nowDone);
      const cbxEl = li.querySelector<HTMLElement>(".cbx");
      if (cbxEl) {
        cbxEl.classList.toggle("done", nowDone);
        cbxEl.setAttribute("aria-checked", String(nowDone));
      }
      const next: DocFull = { ...doc, src: flipped };
      lastRendered = next;
      curDoc = next;
      // 任务标记从 "[ ]"→"[x]" 净增 1 个非空白字符（反之 -1），.sub 字数同步无需重扫全文
      lastWordCount = Math.max(0, lastWordCount + (nowDone ? 1 : -1));
      updateSubStats(lastWordCount, next);
      const prevSec = s.activeSec();
      s.applySaved(next);
      s.setActiveSec(prevSec);   // applySaved→setDoc 会清空 activeSec；勾选不该让大纲高亮闪断
      return;
    }

    const img = t.closest("img");
    if (img) { ui.setImgSrc(img.getAttribute("src")); return; }

    const a = t.closest("a");
    if (a) {
      // SEC-03：正文内任何超链接点击都被应用接管，绝不让 WebView 自己导航（FR-2.1 安全边界）
      e.preventDefault();
      const href = (a.getAttribute("href") ?? "").trim();
      if (href.startsWith("#")) {
        // UI-05：文档内锚点——按 id 或标题文本定位并滚动（此前只 preventDefault，点了没反应）。
        // 2026-11-22 起先全库按 id 找（脚注 #fn-N/#fnref-N 等正文自带锚点），再回落 data-sec 标题。
        const want = decodeSafe(href.slice(1));
        let byId: HTMLElement | null = null;
        try { byId = article.querySelector<HTMLElement>(`[id="${want.replace(/["\\]/g, "\\$&")}"]`); } catch { /* 非法 id 字符：回落标题路径 */ }
        if (byId) { byId.scrollIntoView({ behavior: "smooth", block: "start" }); flash(byId); return; }
        const hs = [...article.querySelectorAll<HTMLElement>(HSEC)];
        const h = hs.find((x) => x.id === want) ?? hs.find((x) => (x.textContent ?? "").trim() === want);
        if (h) { h.scrollIntoView({ behavior: "smooth", block: "start" }); flash(h); }
        else s.toast("文档内没有对应标题" + (want ? "：" + clip(want) : ""));
        return;
      }
      const sm = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
      const scheme = sm ? sm[1].toLowerCase() : null;
      if (scheme === null) {
        const clean = decodeSafe(href.split(/[?#]/)[0]);
        if (/\.(md|markdown|txt)$/i.test(clean) && !clean.startsWith("/")) {
          const cur = s.current();
          const baseDir = cur ? cur.meta.path.replace(/[\\/][^\\/]*$/, "") : "";
          const resolved = joinDocPath(baseDir, clean);
          if (resolved) { void s.openPath(resolved); return; }
        }
        s.toast("暂不支持打开这种链接：" + clip(href));
        return;
      }
      if (scheme === "http" || scheme === "https" || scheme === "mailto") { void openExternal(href); return; }
      // data: / javascript: / file: / 任意未知 scheme —— 一律拦截（SEC-03 白名单口径）
      s.toast("出于安全考虑，这种链接不会打开：" + scheme);
    }
  }

  onMount(() => {
    ui.registerArticle(article);
    ui.registerSectionNav({ dir: jumpSection, toTop });
    s.providePositionSource(currentPosition);
    // 编辑⇄阅读同步桥（v1.2 一把尺）：视口顶的小数源码行号即交接值
    ui.registerViewBridge({
      topLine(): number | null {
        const doc = s.current();
        if (!doc || s.mode() === "edit") return null;
        return topLineOf(doc);
      },
    });
    registerAnchorCompensate(compensateDom);
    // 高度变化（排版/图片/字体）→ 锚点表失效重建；ResizeObserver 在 jsdom 缺席时静默（探针环境）
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => { layoutEpoch++; });
      ro.observe(article);
    }
    // 排印/栏宽变更原位还原（方案 §4.4）：两帧延迟等 App 的 typeVars 落 DOM；还原值用变更前沿在的 lastTopLine
    createEffect(on(() => typeSig(), (sig, prev) => {
      if (prev === undefined || sig === prev || s.mode() !== "read") return;
      layoutEpoch++;
      const doc = s.current();
      if (!doc) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (sameDoc(doc) && s.mode() === "read") scrollToLine(lastTopLine, doc);
      }));
    }));
    view.addEventListener("scroll", onScroll, { passive: true });
    article.addEventListener("click", onArticleClick);
    article.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).closest(".co-head")) {
        e.preventDefault();
        (e.target as HTMLElement).closest(".co-head")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    onCleanup(() => {
      view.removeEventListener("scroll", onScroll);
      article.removeEventListener("click", onArticleClick);
      ui.registerArticle(null);
      ui.registerSectionNav(null);
      ui.registerViewBridge(null);
      registerAnchorCompensate(null);
      ro?.disconnect();
    });
  });

  return (
    <div class="view" id="scroll-area" ref={view}>
      <div class="pgbar"><i style={{ width: (ui.readPct() * 100).toFixed(1) + "%" }} /></div>
      <article class="prose" ref={article}
        classList={{
          sans: !s.settings().serif,
          "density-compact": s.settings().tableDensity === "compact",
          "density-loose": s.settings().tableDensity === "loose",
        }} />
    </div>
  );
}
