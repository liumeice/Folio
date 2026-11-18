/* 命令面板（FR-6）：输入即搜（防抖 200ms，首字符立即）、文档→§ 分组、
 * 标题命中=分组头即结果行、Enter/F3 循环、跳转先退出编辑（v1 P0-3）。 */
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import * as ui from "../lib/ui";
import { renderSnippet, escapeHtml } from "../lib/md";
import type { SearchHit } from "../lib/types";

const [query, setQuery] = createSignal("");
const [hits, setHits] = createSignal<SearchHit[]>([]);
const [sel, setSel] = createSignal(0);
const IDLE_STATUS = "范围：当前文档 · 芯片可切换全部已登记（FTS5 trigram）";
const [status, setStatus] = createSignal(IDLE_STATUS);
let inputEl!: HTMLInputElement;
let debTimer: number | undefined;
/** 请求序号守卫（P2-5）：快速输入时旧查询晚到不得覆盖新结果 */
let querySeq = 0;

export default function SearchPalette() {
  const s = useStore();
  createEffect(() => {
    if (ui.searchOpen()) requestAnimationFrame(() => { inputEl.focus(); inputEl.select(); });
  });

  function runQuery(text: string) {
    const seq = ++querySeq;
    if (!text.trim()) { setHits([]); setStatus(IDLE_STATUS); return; }
    const scope = ui.searchScope();
    // 当前文档：只有「眼前正文 ≠ 磁盘」时才随请求传 src（编辑缓冲 / 未保存打勾）。
    // 干净阅读态不传——Rust 读盘走 OS 缓存，省下一次整篇 IPC 序列化（大文档收益明显）。
    const src = scope === "current" && (s.mode() === "edit" || s.dirty())
      ? (s.mode() === "edit" ? (ui.getEditorBridge()?.docText() ?? s.draftSrc()) : (s.current()?.src ?? null))
      : null;
    void (async () => {
      const t0 = performance.now();
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
        const ms = (performance.now() - t0).toFixed(1);
        const total = r.reduce((a, h) => a + h.count, 0);
        // UI-11：状态文案不许说谎——当前文档是现算不是 FTS；命中数达 limit 时明示截断
        const engine = scope === "library" ? "FTS5 全部已登记" : "当前文档";
        const capped = r.length >= 200 ? " · 已达 200 条展示上限" : "";
        setStatus(`${total} 处匹配 · ${ms} ms（${engine}${capped}）`);
      } catch (e) {
        if (seq !== querySeq) return;
        setStatus("检索失败：" + String(e));
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
      if (s.dirty()) await s.save("跳转阅读：已自动保存当前编辑");
      else s.toggleEdit();
    }
    ui.setSearchOpen(false);
    ui.clearHits();
    const q = query().trim();
    if (s.current()?.meta.id === h.docId) {
      ui.highlightAll(q);
      ui.showHitNav(ui.firstMarkOfSection(h.secAnchor, h.sec));
      s.pushHist({ docId: h.docId, path: h.docPath, sec: h.secAnchor, secText: h.sec || null, top: null, ratio: null });
    } else {
      ui.setPendingHighlight(q, { sec: h.secAnchor, text: h.sec || null });
      await s.openPath(h.docPath);
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
        out.push({ type: "sec", text: h.sec || "文档开头", hitIdx: h.isHeading ? i : -1 });
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
          <input id="search-input" ref={inputEl} spellcheck="false" placeholder={ui.searchScope() === "library" ? "搜索全部已登记…" : "搜索当前文档…"}
            value={query()} onInput={(e) => onInput(e.currentTarget.value)} onKeyDown={onKey} />
          <button
            style={{ "font-size": "11px", color: "var(--text-3)", border: "1px solid var(--line)", "border-radius": "6px", padding: "3px 7px", cursor: "pointer" }}
            title="切换检索范围：当前文档 ⇄ 全部已登记（库 + 最近打开）" onClick={() => {
              ui.setSearchScope(ui.searchScope() === "library" ? "current" : "library");
              if (query()) runQuery(query()); else setStatus(IDLE_STATUS);
            }}>FTS5 · {ui.searchScope() === "library" ? "全部" : "当前"}</button>
        </div>
        <div class="pal-list" id="search-results">
          <Show when={!query().trim() && !hits().length}>
            <div class="sr-empty">范围：{ui.searchScope() === "library" ? "全部已登记（含仅最近打开的文件；FTS5 trigram，中文 2 字词 LIKE 兜底）" : "仅当前文档"}<br />输入关键词开始搜索</div>
          </Show>
          <Show when={query().trim() && !hits().length}>
            <div class="sr-empty">没有找到与 “{escapeHtml(query().trim())}” 匹配的内容</div>
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
                <div class="hf"><span class="hcount">{r.count} 处</span></div>
              </Show>
              <div class="hx" innerHTML={renderSnippet(r.text)} />
            </div>
          )}</For>
        </div>
        <div class="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 跳转</span>
          <span><kbd>F3</kbd> 命中循环</span>
          <span><kbd>Esc</kbd> 关闭</span>
          <span class="sp" />
          <span>{status()}</span>
        </div>
      </div>
    </div>
  );
}
