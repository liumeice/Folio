/* 阅读视图：渲染 + 滚动联动 + 位置源注册 + 导航执行 + 任务勾选/外链/图片。
 * 语义全部对齐 PRD：FR-2（渲染）、FR-3（大纲联动/判据）、FR-4（恢复）、FR-5（历史）、FR-7.6（勾选）。 */
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import * as ui from "../lib/ui";
import { mdToHtml, taskOrdinalOf } from "../lib/md";
import { typesetMathIn } from "../lib/mathjax";
import { renderMermaid } from "../lib/mermaidRender";
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

  /* ── 渲染（同文档对象不重刷：编辑⇄阅读互切只需要 nav，不需要重渲染） ── */
  let lastRendered: DocFull | null | undefined;
  let renderSeq = 0; // 防异步图片/高亮落到更新的渲染结果上
  createEffect(() => {
    const doc = s.current();
    const nav = s.navRequest();
    if (!doc) {
      if (lastRendered !== null) {
        article.innerHTML = EMPTY_HTML;
        ui.setReadPct(0);
        s.setActiveSec(null);
        lastRendered = null;
      }
      return;
    }
    if (doc !== lastRendered) {
      render(doc);
      lastRendered = doc;
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

  function render(doc: DocFull) {
    ui.clearHits();           // 旧命中标记随 DOM 消亡，浮动条状态同步清零
    const seq = ++renderSeq;
    article.innerHTML = mdToHtml(doc.src);
    const h1 = article.querySelector("h1");
    if (h1) {
      h1.insertAdjacentHTML("afterend",
        '<div class="sub"><svg class="ico"><use href="#i-file-text"/></svg><span>' +
        doc.meta.wordCount.toLocaleString() + " 字</span><span>·</span><span>约 " +
        Math.max(1, Math.round(doc.meta.wordCount / 400)) + " 分钟</span><span>·</span><span>" +
        doc.meta.secCount + " 个小节</span><span>·</span><span>更新于 " + fmtDate(doc.meta.mtime) +
        "</span></div>");
    }
    // P0-3 让路首屏：文字（含 .sub）已进 DOM，图片水合与代码着色挪到下一帧；
    // codehl 模块本身也是动态的（P0-2），highlight.js 不进入口包。
    requestAnimationFrame(() => {
      if (seq !== renderSeq) return;
      const run = () => {
        if (seq !== renderSeq) return;
        void hydrateImages(doc);
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
  }, { defer: true }));

  /* 公式/图表排版链（MathJax + Mermaid 集成 §3.1）：innerHTML 之后才准排版。
   * 顺序：math 在前、mermaid await math ——mermaid 内部要调 MathJax（math mode 标签），
   * 且同容器二次 innerHTML 会抹掉首次排版产物（易错点 #9/#10）。
   * 三道守卫：renderSeq（重渲丢弃）、el.isConnected（模块内，切文档静默中止）、visibilityState
   * （隐藏页 mermaid 测量文本尺寸需要布局，恢复可见再排——易错点 #4）。 */
  async function typesetDoc(doc: DocFull, seq: number) {
    await whenVisible();
    if (seq !== renderSeq) return;
    await typesetMathIn(article);
    if (seq !== renderSeq || s.current() !== doc) return; // 或 article.contains(el)：容器已换即停
    await renderMermaid(article);
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

  function nextHeading(h: HTMLElement): HTMLElement | null {
    let n: Element | null = h.nextElementSibling;
    while (n && !/^H[1-6]$/.test(n.tagName)) n = n.nextElementSibling;
    return n as HTMLElement | null;
  }

  function applyNav(nav: ReturnType<typeof s.navRequest>, doc: DocFull) {
    if (!nav) return;
    if (nav.kind === "top") { view.scrollTop = 0; return; }
    if (nav.kind === "secFrac") {
      // 编辑→阅读交接：章节 + 章节内比例 → 渲染像素（与 lineForSecFrac 同一坐标系）
      if (nav.sec == null) {
        const max0 = view.scrollHeight - view.clientHeight;
        if (max0 > 0) view.scrollTop = nav.frac * max0;
        return;
      }
      const h = headingBy(nav.sec, doc.outline.find((o) => o.sec === nav.sec)?.text ?? null);
      if (h) {
        const nx = nextHeading(h);
        view.scrollTop = nx
          ? Math.max(0, h.offsetTop + nav.frac * (nx.offsetTop - h.offsetTop))
          : Math.max(0, h.offsetTop - 70);
      }
      return;
    }
    if (nav.kind === "anchor") {
      const h = headingBy(nav.sec, doc.outline.find((o) => o.sec === nav.sec)?.text ?? null);
      if (h) { h.scrollIntoView({ behavior: "smooth", block: "start" }); flash(h); }
      return;
    }
    // restore：prefer=position → ratio 绝对优先；否则锚点+偏移优先、ratio 兜底（FR-4.1 / FR-5.2）
    const max = view.scrollHeight - view.clientHeight;
    if (nav.prefer !== "position") {
      const h = headingBy(nav.sec, nav.secText);
      if (h) { view.scrollTop = Math.max(0, h.offsetTop - 70 + (nav.secOff ?? 0)); return; }
    }
    if (max > 0) view.scrollTop = nav.ratio * max;
  }

  function flash(el: HTMLElement) {
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1600);
  }

  /* ── 本地图片资源水合（FR-2.1）：相对/根绝对路径按文档位置解析 → asset: 协议 ── */
  const imgCache = new Map<string, { url: string; w: number; h: number } | null>(); // null = 未找到（P2-3：尺寸随 url 一起缓存）
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

  async function hydrateImages(doc: DocFull) {
    const locals: { img: HTMLImageElement; src: string; key: string }[] = [];
    article.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (/^(https?:|data:|blob:|asset:)/i.test(src) || /^https?:\/\/asset\.localhost/i.test(src)) {
        watchImg(img, src);
        return;
      }
      if (!s.isTauri) return; // 浏览器 mock 无本地文件系统，保留原样
      const key = doc.meta.path + "|" + src;
      const c = imgCache.get(key);
      if (c !== undefined) {
        if (c) {
          if (c.w > 0 && c.h > 0) { img.width = c.w; img.height = c.h; }
          img.src = c.url;
        } else markMissing(img, src);
        return;
      }
      locals.push({ img, src, key });
    });
    if (!locals.length) return;
    const uniq = [...new Set(locals.map((l) => l.src))];
    try {
      // P1-7：整篇文档一次 IPC 批量解析磁盘路径与尺寸（P2-3）；asset URL 转换是本地纯计算（P2-7 缓存）
      const info = await api.resolveImages(doc.meta.path, uniq);
      const urls = await api.toAssetSrcs(info.map((r) => (r ? r[0] : null)));
      if (s.current() !== doc) return; // 文档已切换，旧结果不再应用
      const bySrc = new Map<string, { url: string; path: string; w: number; h: number } | null>(
        uniq.map((u, i) => [u, info[i] && urls[i]
          ? { url: urls[i]!, path: info[i]![0], w: info[i]![1], h: info[i]![2] }
          : null]),
      );
      for (const l of locals) {
        const r = bySrc.get(l.src) ?? null;
        imgCache.set(l.key, r ? { url: r.url, w: r.w, h: r.h } : null);
        if (r) {
          if (r.w > 0 && r.h > 0 && !l.img.getAttribute("width")) {
            l.img.width = r.w; l.img.height = r.h; // P2-3：先占位后加载，消除到达回流
          }
          l.img.src = r.url;
          l.img.title = r.path;
          watchImg(l.img, l.src);
        } else {
          markMissing(l.img, l.src);
        }
      }
    } catch {
      for (const l of locals) {
        imgCache.set(l.key, null);
        markMissing(l.img, l.src);
      }
    }
  }

  /* ── 滚动联动（FR-3.2）与位置源（FR-4.1/4.3） ── */
  let raf = 0;
  function onScroll() {
    if (s.mode() === "edit") return;
    if (!s.current()) return;
    const max = view.scrollHeight - view.clientHeight;
    const pct = max > 0 ? Math.min(1, view.scrollTop / max) : 0;
    ui.setReadPct(pct);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; updateActive(); });
    s.schedulePosition();
  }

  function updateActive() {
    const hs = [...article.querySelectorAll<HTMLElement>(HSEC)];
    if (!hs.length) { s.setActiveSec(null); return; }
    const st = view.scrollTop + 80;
    let active: HTMLElement = hs[0];
    for (const h of hs) if (h.offsetTop <= st) active = h;
    const max = view.scrollHeight - view.clientHeight;
    if (max > 4 && view.scrollTop >= max - 4) active = hs[hs.length - 1];  // 触底强制末节；短文档不触发（v2 N2）
    s.setActiveSec(Number(active.dataset.sec) || null);
  }

  /* 位置源：Reader 是唯一知道滚动真相的人 */
  function currentPosition() {
    if (!s.current() || s.mode() === "edit") return null;
    const max = view.scrollHeight - view.clientHeight;
    const ratio = max > 0 ? Math.min(1, view.scrollTop / max) : 0;
    const sec = s.activeSec();
    const h = sec != null ? article.querySelector<HTMLElement>(`[data-sec="${sec}"]`) : null;
    return {
      ratio,
      sec,
      secText: h?.textContent ?? null,
      secOff: h ? Math.max(0, view.scrollTop - h.offsetTop) : 0,
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
      try {
        const next = await api.toggleTask(doc.meta.path, nth);
        s.applySaved(next);
        s.toast("已更新任务清单（写回源文件）");
      } catch (err) {
        s.toast("勾选写回失败：" + String(err));
      }
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
        // UI-05：文档内锚点——按 id 或标题文本定位并滚动（此前只 preventDefault，点了没反应）
        const want = decodeSafe(href.slice(1));
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
        s.toast("不支持的相对链接：" + clip(href));
        return;
      }
      if (scheme === "http" || scheme === "https" || scheme === "mailto") { void openExternal(href); return; }
      // data: / javascript: / file: / 任意未知 scheme —— 一律拦截（SEC-03 白名单口径）
      s.toast("已拦截不安全链接协议：" + scheme);
    }
  }

  onMount(() => {
    ui.registerArticle(article);
    ui.registerSectionNav({ dir: jumpSection, toTop });
    s.providePositionSource(currentPosition);
    // 编辑⇄阅读同步桥：阅读侧"章节+比例"读取（与 updateActive 同判据）
    ui.registerViewBridge({
      secFrac(): ui.SecFrac | null {
        if (!s.current() || s.mode() === "edit") return null;
        const hs = [...article.querySelectorAll<HTMLElement>(HSEC)];
        if (!hs.length) {
          // 无标题文档：退化为全文比例（sec=null 时两端按全文几何映射）
          const max0 = view.scrollHeight - view.clientHeight;
          return { sec: null, frac: max0 > 0 ? Math.min(1, view.scrollTop / max0) : 0 };
        }
        const st = view.scrollTop + 80;
        let idx = 0;
        hs.forEach((h, i) => { if (h.offsetTop <= st) idx = i; });
        const max = view.scrollHeight - view.clientHeight;
        if (max > 4 && view.scrollTop >= max - 4) idx = hs.length - 1;
        const h = hs[idx];
        const nx = hs[idx + 1] as HTMLElement | undefined;
        return {
          sec: Number(h.dataset.sec) || null,
          frac: nx ? Math.min(1, Math.max(0, (view.scrollTop - (h.offsetTop - 70)) / (nx.offsetTop - h.offsetTop))) : 0,
        };
      },
    });
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
