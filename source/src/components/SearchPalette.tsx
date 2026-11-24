/* 命令面板（FR-6）：输入即搜（防抖 200ms，首字符立即）、文档→§ 分组、
 * 标题命中=分组头即结果行、Enter/F3 循环、跳转先退出编辑（v1 P0-3）。 */
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import * as ui from "../lib/ui";
import { renderSnippet, escapeHtml } from "../lib/md";
import type { SearchHit } from "../lib/types";
import { t, tp, locale } from "../lib/i18n";
import { formatNumber } from "../lib/i18n/format";

const [query, setQuery] = createSignal("");
const [hits, setHits] = createSignal<SearchHit[]>([]);
const [sel, setSel] = createSignal(0);
const idleStatus = () => t("sr.scope.idle");
const [status, setStatus] = createSignal(idleStatus());
let inputEl!: HTMLInputElement;
let debTimer: number | undefined;
/** 请求序号守卫（P2-5）：快速输入时旧查询晚到不得覆盖新结果 */
let querySeq = 0;

export default function SearchPalette() {
  const s = useStore();
  createEffect(() => {
    if (ui.searchOpen()) requestAnimationFrame(() => { inputEl.focus(); inputEl.select(); });
  });
  // 语言切换后结果状态回到 idle，不残留旧语言字符串（多语言设计 §2.4-3）
  createEffect(() => { locale(); setStatus(idleStatus()); });

  function runQuery(text: string) {
    const seq = ++querySeq;
    if (!text.trim()) { setHits([]); setStatus(idleStatus()); return; }
    const scope = ui.searchScope();
    // 当前文档：只有「眼前正文 ≠ 磁盘」时才随请求传 src（编辑缓冲 / 未保存打勾）。
    // 干净阅读态不传——Rust 读盘走 OS 缓存，省下一次整篇 IPC 序列化（大文档收益明显）。
    const src = scope === "current" && (s.mode() === "edit" || s.dirty())
      ? (s.mode() === "edit" ? (ui.getEditorBridge()?.docText() ?? s.draftSrc()) : (s.displayDoc()?.src ?? null))
      : null;
    void (async () => {
      try {
        const r = await api.search({
          text,
          scope,
          docId: scope === "current" ? (s.current()?.meta.id ?? 0) : null,
          limit: 200,
          src,
        });
        if (seq !== querySeq) return;   // 旧请求：结果作废，不覆盖新查询
        setHits(r);
        setSel(0);
        const total = r.reduce((a, h) => a + h.count, 0);
        // UI-11：状态文案不许说谎——当前文档是现算不是 FTS；命中数达 limit 时明示截断
        const engine = scope === "library" ? t("sr.scope.all") : t("sr.scope.current");
        const capped = r.length >= 200 ? t("sr.status.capped") : "";
        setStatus(tp("sr.status.matches", total, { count: formatNumber(total), scope: engine, capped }));
      } catch (e) {
        if (seq !== querySeq) return;
        setStatus(t("sr.searchFailed") + String(e));
      }
    })();
  }

  // FR-6.1：清空/首个字符立即查询，后续 200ms 防抖（防击键风暴稀释 P95）
  let hadNonEmpty = false;
  function onInput(v: string) {
    setQuery(v);
    window.clearTimeout(debTimer);
    if (!v.trim()) { hadNonEmpty = false; runQuery(v); return; }
    if (!hadNonEmpty) { hadNonEmpty = true; runQuery(v); return; }
    debTimer = window.setTimeout(() => runQuery(v), 200);
  }
  createEffect(() => { if (!ui.searchOpen()) { hadNonEmpty = false; window.clearTimeout(debTimer); } });
  onCleanup(() => window.clearTimeout(debTimer));

  async function jump(i: number) {
    const h = hits()[i];
    if (!h) return;
    if (s.mode() === "edit") {
      if (s.dirty()) await s.save(t("sr.toast.savedBeforeJump"));
      else s.toggleEdit();
    }
    ui.setSearchOpen(false);
    ui.clearHits();
    const q = query().trim();
    if (s.current()?.meta.id === h.docId) {
      ui.highlightAll(q);
      ui.showHitNav(ui.firstMarkOfSection(h.secAnchor, h.sec));
      s.revealOutline(h.secAnchor);   // 搜索命中=主动跳转：硬展开目标章节的祖先链
      s.pushHist({ docId: h.docId, path: h.docPath, sec: h.secAnchor, secText: h.sec || null, top: null, ratio: null });
    } else {
      ui.setPendingHighlight(q, { sec: h.secAnchor, text: h.sec || null });
      await s.openPath(h.docPath);
      s.revealOutline(h.secAnchor);
    }
  }

  function onKey(ev: KeyboardEvent) {
    // UI-03：只吞自己消费的键。此前对**所有**按键 stopPropagation，
    // 搜索框里的 Ctrl+S/Ctrl+F 到不了全局处理，可能漏给浏览器默认行为（弹"保存网页"）。
    const handled = ev.key === "Escape" || ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Enter";
    if (!handled) return;
    ev.stopPropagation();
    if (ev.key === "Escape") { ui.setSearchOpen(false); ui.clearHits(); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); setSel((sel() + 1) % Math.max(1, hits().length)); scrollSel(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setSel((sel() - 1 + hits().length) % Math.max(1, hits().length)); scrollSel(); }
    else if (ev.key === "Enter") { ev.preventDefault(); void jump(sel()); }
  }
  function scrollSel() {
    requestAnimationFrame(() => {
      document.querySelector("#search-results .sel")?.scrollIntoView({ block: "nearest" });
    });
  }

  // 分组渲染：文档头（library scope 且跨文档时）→ § 头 → 片段；标题命中的 § 头自身即结果行（FR-6.2）
  type Row = { type: "doc" | "sec" | "body"; text: string; hitIdx: number; count?: number };
  const [rows, setRows] = createSignal<Row[]>([]);
  createEffect(() => {
    const list = hits();
    const out: Row[] = [];
    let lastDoc = "", lastSec: string | null = null, i = 0;
    for (const h of list) {
      if (ui.searchScope() === "library" && h.docPath !== lastDoc) {
        lastDoc = h.docPath; lastSec = null;
        out.push({ type: "doc", text: h.docTitle, hitIdx: -1 });
      }
      if (h.sec !== lastSec) {
        lastSec = h.sec;
        out.push({ type: "sec", text: h.sec || t("sr.startOfDoc"), hitIdx: h.isHeading ? i : -1 });
      }
      if (!h.isHeading) out.push({ type: "body", text: h.snippet, hitIdx: i, count: h.count });
      i++;
    }
    setRows(out);
  });

  function secHtml(text: string): string {
    const q = query().trim();
    if (!q) return escapeHtml(text);
    const tl = text.toLowerCase(), ql = q.toLowerCase();
    let out = "", pos = 0, idx = tl.indexOf(ql);
    while (idx >= 0) {
      out += escapeHtml(text.slice(pos, idx)) + "<em>" + escapeHtml(text.slice(idx, idx + q.length)) + "</em>";
      pos = idx + q.length; idx = tl.indexOf(ql, pos);
    }
    return out + escapeHtml(text.slice(pos));
  }

  return (
    <div class={"overlay" + (ui.searchOpen() ? " open" : "")} id="search-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) { ui.setSearchOpen(false); ui.clearHits(); } }}>
      <div class="pal">
        <div class="pal-in">
          <svg class="ico"><use href="#i-search" /></svg>
          <input id="search-input" ref={inputEl} spellcheck="false" placeholder={ui.searchScope() === "library" ? t("sr.placeholder.all") : t("sr.placeholder.current")}
            value={query()} onInput={(e) => onInput(e.currentTarget.value)} onKeyDown={onKey} />
          <button
            style={{ "font-size": "11px", color: "var(--text-3)", border: "1px solid var(--line)", "border-radius": "6px", padding: "3px 7px", cursor: "pointer" }}
            title={t("sr.switchScopeTitle")} onClick={() => {
              ui.setSearchScope(ui.searchScope() === "library" ? "current" : "library");
              if (query()) runQuery(query()); else setStatus(idleStatus());
            }}>{ui.searchScope() === "library" ? t("sr.scope.all") : t("sr.scope.current")}</button>
        </div>
        <div class="pal-list" id="search-results">
          <Show when={!query().trim() && !hits().length}>
            <div class="sr-empty">{t("sr.empty.scope", { scope: ui.searchScope() === "library" ? t("sr.empty.scopeAll") : t("sr.empty.scopeCurrent") })}<br />{t("sr.empty.hint")}</div>
          </Show>
          <Show when={query().trim() && !hits().length}>
            <div class="sr-empty">{t("sr.noResults", { query: escapeHtml(query().trim()) })}</div>
          </Show>
          <For each={rows()}>{(r) => r.type === "doc" ? (
            <div class="hgrp"><svg class="ico ico-12"><use href="#i-file-text" /></svg><span>{r.text}</span></div>
          ) : r.type === "sec" ? (
            <div classList={{ hgrp: true, hit: r.hitIdx >= 0, sel: r.hitIdx >= 0 && r.hitIdx === sel() }}
              onClick={() => r.hitIdx >= 0 && void jump(r.hitIdx)}
              innerHTML={"<svg class=\"ico ico-12\"><use href=\"#i-heading\"/></svg><span>" + secHtml(r.text) + "</span>"} />
          ) : (
            <div class="hit" classList={{ sel: r.hitIdx === sel() }} onClick={() => void jump(r.hitIdx)}>
              <Show when={r.count && r.count > 1}>
                <div class="hf"><span class="hcount">{tp("sr.count", r.count ?? 0, { count: formatNumber(r.count ?? 0) })}</span></div>
              </Show>
              <div class="hx" innerHTML={renderSnippet(r.text)} />
            </div>
          )}</For>
        </div>
        <div class="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t("sr.footer.select")}</span>
          <span><kbd>Enter</kbd> {t("sr.footer.go")}</span>
          <span><kbd>F3</kbd> {t("sr.footer.cycle")}</span>
          <span><kbd>Esc</kbd> {t("sr.footer.close")}</span>
          <span class="sp" />
          <span>{status()}</span>
        </div>
      </div>
    </div>
  );
}
