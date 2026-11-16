import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useStore, type SideView } from "../lib/store";
import * as ui from "../lib/ui";
import { pickAndOpen, pickFolderAndScan, confirmBox } from "../lib/actions";
import { api } from "../lib/api";
import type { DocMeta, RecentDoc } from "../lib/types";
import { allDirKeys, revealKeys } from "../lib/libtree";
import { buildLibTree, flattenAll, isDirOpen, leafName, rootOf, type DirNode, type TreeRow } from "../lib/libtree";

function dayLabel(mtime: number): string {
  const d = new Date(mtime * 1000);
  const now = new Date();
  // CON-12 修复：旧实现用 UTC 日序号（getTime/86400000），UTC+8 用户凌晨 0:00–7:59
  // 打开的文档会被分到「昨天」，而行内时刻却按本地显示——分组与标签自相矛盾。
  // 改为「本地零点差」数天数；Math.round 吸收夏令时 ±1h 抖动（本机时区无 DST 时零成本）。
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((midnight(now) - midnight(d)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 历史行的右侧标签：今天给时刻，昨天给「昨天」，更早给日期 */
function recentLabel(openedAt: number): string {
  const d = new Date(openedAt * 1000);
  const dl = dayLabel(openedAt);
  if (dl !== "今天") return dl;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Rail() {
  const s = useStore();
  const toggle = (v: Exclude<SideView, null>) => s.setSide(s.side() === v ? "outline" : v);
  return (
    <div class="rail">
      {/* 打开文件快捷钮（2026-11-16 增，需求方指定放文档库上方、图标与「文件→打开文档…」菜单项一致）：瞬时动作，不保持选中态 */}
      <button title="打开文档… (Ctrl+O)" onClick={() => void pickAndOpen(s)}>
        <svg class="ico ico-20"><use href="#i-open-file" /></svg>
      </button>
      <button title="文件夹" classList={{ on: s.side() === "library" }} onClick={() => toggle("library")}>
        <svg class="ico ico-20"><use href="#i-open-folder" /></svg>
      </button>
      <button title="最近打开" classList={{ on: s.side() === "recents" }} onClick={() => toggle("recents")}>
        <svg class="ico ico-20"><use href="#i-recent" /></svg>
      </button>
      <button title="大纲" classList={{ on: s.side() === "outline" }} onClick={() => s.setSide("outline")}>
        <svg class="ico ico-20"><use href="#i-outline" /></svg>
      </button>
      {/* 2026-11-16：rail 底部 ⚙ 与 ⊕ 搜索钮都已撤——搜索入口=标题栏钮 / Ctrl+F / 「文档」菜单 */}
    </div>
  );
}

export function LibraryPanel() {
  const s = useStore();
  const [q, setQ] = createSignal("");
  /** 展开状态在 ui 层（跨面板切换保留）；这里只是别名 */
  const dirState = ui.libExpand;
  const kw = createMemo(() => q().trim().toLowerCase());
  /** 文档库成员 = 「打开文件夹…」扫进来的条目；内置文档不算（它们只在「最近打开」出现） */
  const libDocs = createMemo(() => s.docs().filter((d) => d.inLibrary && !d.builtin));
  const filtered = createMemo(() => {
    const k = kw();
    const docs = [...libDocs()];
    return k ? docs.filter((d) => (d.fileName + " " + d.dir + " " + d.path).toLowerCase().includes(k)) : docs;
  });
  const pinnedList = createMemo(() => filtered().filter((d) => d.pinned));
  /** 正在读的文档所在目录链：默认展开，否则收起后当前文档在树里隐身 */
  const reveal = createMemo(() => revealKeys(s.current()?.meta.dir, s.roots()));
  /** 树本身（"全部展开/全部收起"与行序列共用）；筛选词非空时不画树 */
  const tree = createMemo(() => buildLibTree(s.roots(), filtered().filter((d) => !d.pinned)));
  /** 有筛选词→平铺命中（附路径提示）；没有→目录树 */
  const rows = createMemo<TreeRow[]>(() => {
    if (kw()) return filtered().filter((d) => !d.pinned).map((doc) => ({ kind: "file", doc, depth: 0 }));
    return flattenAll(tree(), dirState(), reveal());
  });
  function toggleDir(key: string, openNow: boolean) {
    ui.setLibExpand((prev) => new Map(prev).set(key, !openNow));
  }
  /** 批量展开/收起：整批写显式记录，不留"跟随默认"的暧昧 */
  function setAll(open: boolean) {
    ui.setLibExpand(new Map(allDirKeys(tree()).map((k) => [k, open])));
  }
  /** chip 代表"眼前这一个库"，所以刷新也只刷这一个 */
  async function rescanOne(r: string) {
    try {
      const rep = await api.scanFolder(r);
      s.toast(`重新扫描「${leafName(r)}」：新增 ${rep.inserted} · 更新 ${rep.updated} · `
        + `未变 ${rep.unchanged} · 移除 ${rep.removed}`
        + (rep.skipped ? ` · 读取失败跳过 ${rep.skipped}` : "")
        + (rep.truncated ? ` · 超上限未索引 ${rep.truncated}` : ""));
      void s.refreshDocs();
    } catch (e) {
      s.toast("重新扫描失败：" + String(e));   // UI-15：旧版裸 await，失败无声无息
    }
  }
  /** 当前库 = 正在读那篇文档所属的库根；没开文档（或文档不在任何库内）时退到第一个。
   *  多个库不靠"N 个"标签表达——树里每个库根本身就是一个顶层节点。 */
  const curRoot = createMemo(() => {
    const rs = s.roots();
    if (!rs.length) return null;
    const dir = s.current()?.meta.dir;
    return (dir ? rs.find((r) => rootOf(dir, [r]) !== null) : undefined) ?? rs[0];
  });
  const underCur = createMemo(() => {
    const r = curRoot();
    return r ? libDocs().filter((d) => rootOf(d.dir, [r]) !== null).length : 0;
  });
  async function closeLibrary() {
    const r = curRoot();
    if (!r) { await pickFolderAndScan(s); return; }   // 没有库时这个位置就是「打开文件夹…」
    const extra = s.roots().length > 1
      ? `另有 ${s.roots().length - 1} 个库不受影响。` : "";
    // 应用内询问框（§8.6）：白话文案 + 新旧信息分行；取消/Esc/遮罩 = 零副作用
    const ok = await ui.ask({
      icon: "i-x", title: "关闭文件夹", sub: "关闭当前打开的文件夹，不会删除电脑里任何文件。",
      rows: [["要关闭的文件夹", r], ["里面的文档", `${underCur()} 篇`]],
      note: "关闭后：这些文件都还在电脑里，一篇也不会少；读到哪儿了也记着，以后在「最近打开」列表里"
        + `还能找到并继续读。想再打开，选中同一个文件夹就行。${extra}`,
      ok: "关闭文件夹",
    });
    if (!ok) return;
    let n: number;
    try {
      n = await api.removeRoot(r);
    } catch (e) { s.toast("关闭文件夹失败：" + String(e)); return; }   // UI-15
    await s.refreshDocs();
    s.toast(n ? `已关闭文件夹「${leafName(r)}」— 文件未删除，可在「最近打开」里继续读（共 ${n} 篇）`
      : `已关闭文件夹「${leafName(r)}」`);
  }
  return (
    <>
      <div class="side-head">
        <div class="side-title">文件夹<span class="sp" />
          <span class="act" id="lib-expand" title="全部展开（含更深层目录）"
            onClick={() => setAll(true)}>
            <svg class="ico ico-12"><use href="#i-chev-d" /></svg>
          </span>
          <span class="act" id="lib-collapse" title="全部收起（只留库根与它的第一层）"
            onClick={() => setAll(false)}>
            <svg class="ico ico-12"><use href="#i-chev-u" /></svg>
          </span>
        </div>
        {/* chip = 当前这一个库：只显示路径，刷新与关闭都在框内；点路径打开库根管理器（多库切换/添加/关闭） */}
        <Show keyed when={curRoot()} fallback={
          <div class="root-chip none" title="点击选择一个文件夹打开"
            onClick={() => void pickFolderAndScan(s)}>
            <span class="ri"><svg class="ico ico-14"><use href="#i-folder" /></svg></span>
            <span class="rp ellip">未打开文件夹 · 点击选择…</span>
          </div>
        }>
          {(path: string) => (
            <div class="root-chip" id="lib-root-chip"
              title={path + "\n当前文件夹 · 点击选择另一个文件夹（同一时间只打开一个）"}
              onClick={() => void pickFolderAndScan(s)}>
              <span class="ri"><svg class="ico ico-14"><use href="#i-folder-open" /></svg></span>
              <span class="rp ellip">{path}</span>
              <span class="ract" id="lib-rescan" title="重新扫描这个文件夹"
                onClick={(e) => { e.stopPropagation(); void rescanOne(path); }}>
                <svg class="ico ico-12"><use href="#i-refresh" /></svg>
              </span>
              <span class="ract" id="lib-close"
                title={`关闭这个文件夹（${underCur()} 篇转为「仅最近打开」· 磁盘与进度不动）`}
                onClick={(e) => { e.stopPropagation(); void closeLibrary(); }}>
                <svg class="ico ico-12"><use href="#i-x" /></svg>
              </span>
            </div>
          )}
        </Show>
        <div class="searchf">
          <svg class="ico ico-14"><use href="#i-search" /></svg>
          <input id="lib-search" placeholder="筛选文档（名称或路径）…" spellcheck="false"
            style={{ flex: "1", "min-width": "0", "font-size": "12.5px", color: "var(--text)" }}
            value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
          <Show when={q()}>
            <span class="iconbtn" style={{ width: "22px", height: "22px" }} title="清除" onClick={() => setQ("")}>
              <svg class="ico ico-12"><use href="#i-x" /></svg>
            </span>
          </Show>
        </div>
      </div>
      <div class="side-body">
        <Show when={filtered().length === 0}>
          <div class="ol-empty">
            {kw()
              ? `无匹配文档：「${kw()}」`
              : <>
                  {s.roots().length ? "该文件夹下暂无 Markdown 文档" : "尚未打开文件夹"}<br />
                  <button class="btn primary" style={{ "margin-top": "6px" }}
                    onClick={() => void pickFolderAndScan(s)}>打开文件夹…</button><br />
                  <span style={{ "font-size": "11.5px" }}>
                    （单独打开的文档只进「最近打开」）
                  </span>
                </>}
          </div>
        </Show>
        <Show when={pinnedList().length > 0}>
          <div class="sec-h">置顶<span class="sp" /></div>
          <For each={pinnedList()}>{(d) => <LibItem d={d} showPath={!!kw()} />}</For>
        </Show>
        <For each={rows()}>
          {(row) => row.kind === "dir"
            ? <DirRow node={row.node} open={isDirOpen(row.node, dirState(), reveal())}
                onToggle={() => toggleDir(row.node.key, isDirOpen(row.node, dirState(), reveal()))} />
            : <LibItem d={row.doc} depth={row.depth} showPath={!!kw()} />}
        </For>
      </div>
      <div class="side-foot">
        <span class="dot-ok" /><span>SQLite · FTS5</span><span class="sp" />
        <span>{libDocs().length ? `共 ${libDocs().length} 篇` : "还没有打开的文件夹"}</span>
      </div>
    </>
  );
}

/** 库列表行。depth 只用于缩进（筛选态为 0），showPath 在平铺态补出所在目录。 */
function LibItem(props: { d: DocMeta; depth?: number; showPath?: boolean }) {
  const s = useStore();
  const on = () => s.current()?.meta.id === props.d.id;
  return (
    <div class="tf" classList={{ on: on() }} tabindex={0} title={props.d.path}
      style={{ "padding-left": 6 + (props.depth ?? 0) * 13 + "px" }}
      onClick={() => void s.openMeta(props.d)}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.setCtxMenu({ kind: "doc", from: "library", x: e.clientX, y: e.clientY, meta: props.d });
      }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void s.openMeta(props.d); } }}>
      <svg class="ico ico-14" style={{ color: on() ? "var(--accent)" : "var(--text-3)" }}><use href="#i-md" /></svg>
      <span class="nm">{props.d.fileName}</span>
      <Show when={props.showPath && props.d.dir}>
        <span class="src-dir ellip">{leafName(props.d.dir)}</span>
      </Show>
      <Show when={props.d.builtin}><span class="badge">内置</span></Show>
      <span class="mt">{dayLabel(props.d.mtime)}</span>
    </div>
  );
}

/** 目录行：点击展开/收起，右侧是含子目录的总数 */
function DirRow(props: { node: DirNode; open: boolean; onToggle: () => void }) {
  return (
    <div class={"tf dir" + (props.node.depth === 0 ? " root" : "")}
      style={{ "padding-left": 6 + props.node.depth * 13 + "px" }}
      title={props.node.key} tabindex={0}
      onClick={props.onToggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onToggle(); } }}>
      <svg class="ico ico-14 chev"><use href={props.open ? "#i-folder-open" : "#i-folder"} /></svg>
      <span class="nm">{props.node.name}</span>
      <span class="mt">{props.node.count}</span>
    </div>
  );
}

/* ══════════════ 最近打开（v3：独立面板 = 打开历史，与库无关）══════════════ */

export function RecentsPanel() {
  const s = useStore();
  const [q, setQ] = createSignal("");
  const kw = createMemo(() => q().trim().toLowerCase());
  const items = createMemo(() => {
    const k = kw();
    const list = s.recents();
    return k
      ? list.filter((r) => (r.meta.fileName + " " + r.meta.dir + " " + r.meta.path).toLowerCase().includes(k))
      : list;
  });
  /** 按「今天 / 昨天 / MM-DD」分组；列表已按时间倒序，所以相邻同组直接并档 */
  const groups = createMemo(() => {
    const out: { label: string; items: RecentDoc[] }[] = [];
    for (const r of items()) {
      const label = dayLabel(r.openedAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(r);
      else out.push({ label, items: [r] });
    }
    return out;
  });
  async function clearAll() {
    const ok = await confirmBox(
      "清空「最近打开」列表？\n只删打开历史：文件夹里的文档与内置文档完全不受影响。\n仅「打开过但从未加入文件夹」的条目会连带回收登记（阅读进度与索引一并清除，磁盘文件不动）。",
      "清空最近打开");
    if (!ok) return;
    const rep = await api.clearRecents();
    await s.refreshDocs();
    s.toast(rep.pruned
      ? `已清空打开历史（${rep.cleared} 条 · 回收 ${rep.pruned} 条登记）`
      : `已清空打开历史（${rep.cleared} 条）`);
  }
  return (
    <>
      <div class="side-head">
        <div class="side-title">最近打开<span class="sp" />
          <span id="rec-clear" class="sec-act" title="清空打开历史（不动库 · 不动磁盘）" onClick={() => void clearAll()}>
            <svg class="ico ico-12"><use href="#i-trash" /></svg>
          </span>
          <span id="rec-add" title="打开文档… (Ctrl+O)" style={{ cursor: "pointer", display: "inline-grid" }}
            onClick={() => void pickAndOpen(s)}>
            <svg class="ico ico-14" style={{ color: "var(--text-3)" }}><use href="#i-plus" /></svg>
          </span>
        </div>
        <div class="searchf">
          <svg class="ico ico-14"><use href="#i-search" /></svg>
          <input id="rec-search" placeholder="筛选历史（名称或路径）…" spellcheck="false"
            style={{ flex: "1", "min-width": "0", "font-size": "12.5px", color: "var(--text)" }}
            value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
          <Show when={q()}>
            <span class="iconbtn" style={{ width: "22px", height: "22px" }} title="清除" onClick={() => setQ("")}>
              <svg class="ico ico-12"><use href="#i-x" /></svg>
            </span>
          </Show>
        </div>
      </div>
      <div class="side-body">
        <Show when={items().length === 0}>
          <div class="ol-empty">还没有打开记录<br />Ctrl+O 打开文档，或把 .md 拖进窗口</div>
        </Show>
        <For each={groups()}>{(g) => (
          <>
            <div class="sec-h">{g.label}<span class="sp" /></div>
            <For each={g.items}>{(r) => <RecentItem r={r} />}</For>
          </>
        )}</For>
      </div>
      <div class="side-foot">
        <span>打开历史 · 不限量保留</span><span class="sp" /><span>{s.recents().length} 条</span>
      </div>
    </>
  );
}

function RecentItem(props: { r: RecentDoc }) {
  const s = useStore();
  const d = () => props.r.meta;
  const on = () => s.current()?.meta.id === d().id;
  async function remove(e: MouseEvent) {
    e.stopPropagation();
    try {
      const purged = await api.removeRecent(d().id);
      await s.refreshDocs();
      s.toast(purged ? "已从历史移除（该文档不在任何文件夹，登记一并回收）" : "已从历史移除");
    } catch (err) {
      s.toast("移除失败：" + String(err));   // UI-15：失败必须有声
    }
  }
  return (
    <div class="tf" classList={{ on: on() }} tabindex={0} title={d().path}
      onClick={() => void s.openMeta(d())}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.setCtxMenu({ kind: "doc", from: "recents", x: e.clientX, y: e.clientY, meta: d() });
      }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void s.openMeta(d()); } }}>
      <svg class="ico ico-14" style={{ color: on() ? "var(--accent)" : "var(--text-3)" }}><use href="#i-md" /></svg>
      <span class="nm">{d().fileName}</span>
      <Show when={d().dir}><span class="src-dir ellip">{leafName(d().dir)}</span></Show>
      <Show when={d().inLibrary}><span class="badge">库</span></Show>
      <Show when={d().builtin}><span class="badge">内置</span></Show>
      <span class="mt">{recentLabel(props.r.openedAt)}</span>
      <span class="iconbtn row-x" title="从最近打开移除" onClick={(e) => void remove(e)}>
        <svg class="ico ico-12"><use href="#i-x" /></svg>
      </span>
    </div>
  );
}

export function OutlinePanel() {
  const s = useStore();
  let body!: HTMLDivElement;
  createEffect(() => {
    const sec = s.activeSec();
    if (sec == null) return;
    requestAnimationFrame(() => {
      body?.querySelector(`[data-ol-sec="${sec}"]`)?.scrollIntoView({ block: "nearest" });
    });
  });
  return (
    <>
      <div class="out-head">大纲<span class="sp" />
        <span style={{ "font-family": "var(--font-mono)", "font-size": "10.5px" }}>
          {s.current()?.outline.length ?? 0} 条
        </span>
      </div>
      <div class="out-body" ref={body}>
        <Show when={s.current()?.outline.length} fallback={
          <div class="ol-empty">打开文档后<br />自动生成大纲</div>
        }>
          <For each={s.current()!.outline}>{(o) => (
            <button class={"ol" + (o.level > 1 ? " l" + o.level : "")} classList={{ on: s.activeSec() === o.sec }}
              data-ol-sec={o.sec} data-line={o.line} title={"h" + o.level + " · " + o.text}
              onClick={() => s.requestAnchor(o.sec, true)}>
              <span class="ot">{o.text}</span>
            </button>
          )}</For>
        </Show>
      </div>
    </>
  );
}

export function PaneBar() {
  const s = useStore();
  return (
    <div class="pane-bar">
      <button class="tbtn" disabled={s.histIdx() <= 0} title="后退 (Alt+←)" onClick={() => void s.back()}>
        <svg class="ico ico-14"><use href="#i-arrow-left" /></svg>
      </button>
      <button class="tbtn" disabled={s.histIdx() >= s.histLen() - 1} title="前进 (Alt+→)" onClick={() => void s.forward()}>
        <svg class="ico ico-14"><use href="#i-arrow-right" /></svg>
      </button>
      <span class="divv" />
      <button class="tbtn" title="上一章 (Alt+↑)" onClick={() => ui.navSection(-1)}>
        <svg class="ico ico-14"><use href="#i-chev-u" /></svg>
      </button>
      <button class="tbtn" title="下一章 (Alt+↓)" onClick={() => ui.navSection(1)}>
        <svg class="ico ico-14"><use href="#i-chev-d" /></svg>
      </button>
    </div>
  );
}

export function CrumbBar() {
  const s = useStore();
  return (
    <div class="crumb-bar">
      <span class="path ellip">
        <svg class="ico"><use href="#i-folder" /></svg>
        <span>{s.current()?.meta.dir ?? "文件夹"}</span>
        <i>/</i>
        <b>{s.current()?.meta.fileName ?? "未打开文档"}</b>
      </span>
    </div>
  );
}

export function StatusBar() {
  const s = useStore();
  const secText = createMemo(() => {
    const sec = s.activeSec();
    const o = sec != null ? s.current()?.outline[sec - 1] : undefined;
    return o ? "§ " + o.text : "§ —";
  });
  function link() {
    // 可读原文（§10.9 v1.1）：中文 slug 不做 percent 编码；消费端 parse_folio 解码是恒等
    const c = s.current();
    return c ? "folio://open?doc=" + c.meta.slug : "—";
  }
  return (
    <footer class="status">
      <span class="si ellip" title="文档信息">
        <svg class="ico ico-14"><use href="#i-md" /></svg>
        <b>{s.current()?.meta.fileName ?? "—"}</b>
      </span>
      {/* 2026-11-16 两轮顺序调整：①当前章节紧跟文件名；②统计与编码右移、贴在「阅读%」左侧 */}
      <span class="si" id="stat-sec"><span class="ellip">{secText()}</span></span>
      <span class="sp" />
      <span class="si">{s.current()?.meta.wordCount.toLocaleString() ?? "—"} 字</span>
      <span class="si">{s.current()?.meta.secCount ?? "—"} 节</span>
      <span class="si" id="stat-enc" onClick={() => ui.setPropsOpen(true)} title="查看文档信息">UTF-8</span>
      {/* 百分比定宽槽：位数变化不抖动（样式见 app.css .pct-slot） */}
      <span class="si">阅读 <span class="pct-slot">{Math.round(ui.readPct() * 100)}%</span></span>
      <span class="si acc" id="stat-link-btn" title="点击复制当前文档深度链接"
        onClick={() => {
          const c = s.current();
          if (!c) { s.toast("未打开文档"); return; }
          navigator.clipboard?.writeText(link())
            .then(() => ui.showCopied("已复制深度链接", link()))
            .catch(() => s.toast("剪贴板不可用"));
        }}>
        <code>{link()}</code>
      </span>
    </footer>
  );
}
