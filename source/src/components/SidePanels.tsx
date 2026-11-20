import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { useStore, type SideView } from "../lib/store";
import * as ui from "../lib/ui";
import { pickAndOpen, pickFolderAndScan, confirmBox, renameFile, renameFolder } from "../lib/actions";
import { encLabel } from "../lib/encoding";
import { baseNameLen } from "../lib/filename";
import { api } from "../lib/api";
import type { DocMeta, RecentDoc, RecentReport } from "../lib/types";
import { allDirKeys, revealKeys } from "../lib/libtree";
import { countWords } from "../lib/wordcount";
import { buildLibTree, flattenAll, isDirOpen, leafName, rootOf, type DirNode, type TreeRow } from "../lib/libtree";
import { allOutlineFoldKeys, ancestorChain, buildOutlineTree, flattenOutline } from "../lib/oltree";

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
      s.toast(`重新扫描「${leafName(r)}」：新增 ${rep.inserted} 篇 · 更新 ${rep.updated} 篇 · `
        + `未变 ${rep.unchanged} 篇 · 移除 ${rep.removed} 篇`
        + (rep.skipped ? ` · ${rep.skipped} 篇读取失败，已跳过` : "")
        + (rep.truncated ? ` · 文件太多，还有 ${rep.truncated} 篇没有纳入` : ""));
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
      ? `另外 ${s.roots().length - 1} 个文件夹不受影响。` : "";
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
          <span class="act" id="lib-collapse" title="全部收起（只留最外层）"
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
                title={`关闭这个文件夹（${underCur()} 篇只保留在「最近打开」里 · 磁盘上的文件和阅读进度都不受影响）`}
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
        <span class="dot-ok" /><span>本地存储</span><span class="sp" />
        <span>{libDocs().length ? `共 ${libDocs().length} 篇` : "还没有打开的文件夹"}</span>
      </div>
    </>
  );
}

/** 库列表行。depth 只用于缩进（筛选态为 0），showPath 在平铺态补出所在目录。 */
/* 目录树「重命名」就地编辑框（《Folio-目录树文件重命名方案》§4.4 + 增强 2026-11-20）：
 * 文件默认选中主文件名（扩展名不选，打字换名不换型），文件夹整名选中；
 * Enter 提交、**点击别处失焦也提交**（需求方增强 3：不用必须回车），Esc 显式取消；
 * 校验失败/写盘被拒：顶部 toast 说明原因并保持在编辑态（不抢回焦点——用户可能已去别处，
 * 想改回来点一下该行即可，行在编辑态不响应打开）。
 * 两道闸门：settling=提交异步进行中（防 Enter 与紧随的 blur 双触发）；
 * escCancel=Esc 收起引发的卸载 blur 不当提交。 */
function RenameBox(props: { kind: "file" | "dir"; initial: string; onSubmit: (name: string) => Promise<boolean> }) {
  let el: HTMLInputElement | undefined;
  let settling = false;
  let escCancel = false;
  const commit = async () => {
    if (settling || escCancel) return;
    settling = true;
    const ok = await props.onSubmit(el?.value ?? "");
    if (ok) ui.setRenaming(null);
    else settling = false;   // 保持在编辑态，输入不丢
  };
  onMount(() => {
    if (!el) return;
    el.value = props.initial;
    el.focus();
    el.setSelectionRange(0, props.kind === "file" ? baseNameLen(props.initial) : props.initial.length);
  });
  return (
    <input
      ref={(node) => { el = node; }}
      class="rename-input"
      spellcheck={false}
      title="Enter 或点击别处确认 · Esc 取消"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void commit(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); escCancel = true; ui.setRenaming(null); }
        else e.stopPropagation();   // 方向键等输入框内动作不外洐给全局快捷键（UI-01 口径）
      }}
      onBlur={() => { void commit(); }}
    />
  );
}

function LibItem(props: { d: DocMeta; depth?: number; showPath?: boolean }) {
  const s = useStore();
  const on = () => s.current()?.meta.id === props.d.id;
  const editing = () => {
    const r = ui.renaming();
    return !!r && r.kind === "file" && r.path === props.d.path;
  };
  return (
    <div class="tf" classList={{ on: on() }} tabindex={0} title={props.d.path}
      style={{ "padding-left": 6 + (props.depth ?? 0) * 13 + "px" }}
      onClick={() => { if (!editing()) void s.openMeta(props.d); }}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.setCtxMenu({ kind: "doc", from: "library", x: e.clientX, y: e.clientY, meta: props.d });
      }}
      onKeyDown={(e) => {
        if (editing()) return;   // 重命名编辑态里方向键/回车归输入框（Esc 由 RenameBox 就地处理）
        if (e.key === "F2") {    // 增强 2：行聚焦态 F2 = 就地重命名（资源管理器口径）
          e.preventDefault(); e.stopPropagation();
          ui.setRenaming({ kind: "file", path: props.d.path });
          return;
        }
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void s.openMeta(props.d); }
      }}>
      <svg class="ico ico-14" style={{ color: on() ? "var(--accent)" : "var(--text-3)" }}><use href="#i-md" /></svg>
      <Show when={editing()} fallback={<span class="nm">{props.d.fileName}</span>}>
        <RenameBox kind="file" initial={props.d.fileName} onSubmit={(n) => renameFile(s, props.d, n)} />
      </Show>
      <Show when={props.showPath && props.d.dir}>
        <span class="src-dir ellip">{leafName(props.d.dir)}</span>
      </Show>
      <Show when={props.d.builtin}><span class="badge">内置</span></Show>
      <span class="mt">{dayLabel(props.d.mtime)}</span>
    </div>
  );
}

/** 目录行：点击展开/收起，右侧是含子目录的总数；右键/F2 走文件夹重命名（增强 1，2026-11-20） */
function DirRow(props: { node: DirNode; open: boolean; onToggle: () => void }) {
  const s = useStore();
  const editing = () => {
    const r = ui.renaming();
    return !!r && r.kind === "dir" && r.path === props.node.key;
  };
  return (
    <div class={"tf dir" + (props.node.depth === 0 ? " root" : "")}
      style={{ "padding-left": 6 + props.node.depth * 13 + "px" }}
      title={props.node.key} tabindex={0}
      onClick={() => { if (!editing()) props.onToggle(); }}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.setCtxMenu({ kind: "dir", x: e.clientX, y: e.clientY, path: props.node.key });
      }}
      onKeyDown={(e) => {
        if (editing()) return;
        if (e.key === "F2") {
          e.preventDefault(); e.stopPropagation();
          ui.setRenaming({ kind: "dir", path: props.node.key });
          return;
        }
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onToggle(); }
      }}>
      <svg class="ico ico-14 chev"><use href={props.open ? "#i-folder-open" : "#i-folder"} /></svg>
      <Show when={editing()} fallback={<span class="nm">{props.node.name}</span>}>
        <RenameBox kind="dir" initial={props.node.name} onSubmit={(n) => renameFolder(s, props.node.key, n)} />
      </Show>
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
      "清空「最近打开」列表？\n只是清掉打开记录，文件夹里的文档一篇都不会少。\n"
      + "不在任何文件夹里的文件，阅读进度和搜索记录也会一起清掉；磁盘上的文件不动。",
      "清空最近打开");
    if (!ok) return;
    // UI-15：清空失败必须有声——旧版裸 await，命令排队/异常时静默无反应，看起来像"没清掉"
    let rep: RecentReport;
    try { rep = await api.clearRecents(); }
    catch (e) { s.toast("清空最近打开失败：" + String(e)); return; }
    await s.refreshDocs();
    s.toast(rep.pruned
      ? `已清空打开历史（${rep.cleared} 条；其中 ${rep.pruned} 个文件的阅读进度也一并清除了）`
      : `已清空打开历史（${rep.cleared} 条）`);
  }
  return (
    <>
      <div class="side-head">
        <div class="side-title">最近打开<span class="sp" />
          <span id="rec-clear" class="sec-act" title="清空打开记录（文件夹和磁盘上的文件都不受影响）" onClick={() => void clearAll()}>
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
      s.toast(purged ? "已从历史移除（这个文件不在任何文件夹里，阅读进度也一并清除了）" : "已从历史移除");
    } catch (err) {
      s.toast("移除失败：" + String(err));   // UI-15：失败必须有声
    }
  }
  return (
    <div class="tf rec" classList={{ on: on() }} tabindex={0} title={d().path}
      onClick={() => void s.openMeta(d())}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.setCtxMenu({ kind: "doc", from: "recents", x: e.clientX, y: e.clientY, meta: d() });
      }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void s.openMeta(d()); } }}>
      <svg class="ico ico-14" style={{ color: on() ? "var(--accent)" : "var(--text-3)" }}><use href="#i-md" /></svg>
      <span class="nm">{d().fileName}</span>
      {/* 需求方 2026-11-17：历史行不显示上级文件夹小字；时间右移贴住关闭按钮留位 */}
      <Show when={d().inLibrary}><span class="badge">文件夹</span></Show>
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
  const tree = createMemo(() => buildOutlineTree(s.current()?.outline ?? []));
  const rows = createMemo(() => flattenOutline(tree(), ui.olExpand(), ui.olSoftOpen()));
  const foldKeys = createMemo(() => allOutlineFoldKeys(tree()));

  /* 当前节落在收起的子树里时，高亮显示在最近可见的上级条目上
   * （否则当前行不渲染，用户看不到焦点在哪）。主动跳转会硬展开目标分支，
   * 此时最近可见祖先就是目标本身；被动滚动只切换高亮，不展开。 */
  const shownActive = createMemo(() => {
    const sec = s.activeSec();
    if (sec == null) return null;
    const visible = new Set(rows().map((r) => r.node.item.sec));
    if (visible.has(sec)) return sec;
    const chain = ancestorChain(tree(), sec);
    if (!chain) return null;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (visible.has(chain[i])) return chain[i];
    }
    return null;
  });

  /* 主动跳转的一次性定位（2026-11-18 需求修正）：把目标行直接滚入大纲视口。
   * 被动滚动只切换 active 高亮，不滚面板、不展开分支——避免滚动时逐项跟随/来回滚。
   * 硬展开由 store.revealOutline 在跳转时完成；这里等行渲染后量几何。 */
  createEffect(() => {
    const req = ui.olScrollTo();
    if (!req) return;
    const sec = req.sec;
    ui.setOlScrollTo(null);   // 一次性消费：面板重挂载时不重放旧跳转
    requestAnimationFrame(() => {
      const row = body?.querySelector<HTMLElement>(`.ol-row[data-ol-sec="${sec}"]`);
      if (!row) return;
      // 只有焦点本来就在大纲里时才把键盘焦点移到目标条目；阅读区触发跳转不抢焦点
      const fromOutline = !!(document.activeElement as HTMLElement | null)?.closest?.(".out-body");
      const box = body.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const pad = 12;
      if (r.top < box.top + pad) body.scrollTop -= box.top + pad - r.top;
      else if (r.bottom > box.bottom - pad) body.scrollTop += r.bottom - (box.bottom - pad);
      if (fromOutline) row.querySelector<HTMLElement>(".ol-text")?.focus({ preventScroll: true });
    });
  });

  function focusText(sec: number) {
    body?.querySelector<HTMLElement>(`.ol-row[data-ol-sec="${sec}"] .ol-text`)?.focus();
  }

  function toggle(sec: number, open: boolean) {
    ui.setOutlineOpen(sec, !open);
    queueMicrotask(() => focusText(sec));   // 重排后 DOM 可能重建，焦点留在原行
  }

  /* FR-12：↑↓ 移动，← 收起 / 回父级，→ 展开 / 进首个子项，Enter/Space 跳转 */
  function onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (!el.closest(".ol-text")) return;
    const row = el.closest<HTMLElement>(".ol-row");
    if (!row) return;
    // 只吞自己消费的键：Home / Enter 在全局还有「回顶部」「命中下一处」语义，
    // 大纲内的同名键必须先截住，否则会串台（Ctrl+S 等其余键照常冒泡）。
    // Solid 的 keydown 走 document 委托，stopPropagation 挡不住同节点上的全局监听，
    // 必须用 stopImmediatePropagation（CLAUDE.md「Solid 事件委托」同款坑）。
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", " ", "Home", "End"].includes(e.key)) return;
    e.stopImmediatePropagation();
    const sec = Number(row.dataset.olSec);
    const all = [...body.querySelectorAll<HTMLElement>(".ol-row")];
    const idx = all.indexOf(row);
    const expanded = row.getAttribute("aria-expanded");
    const focusAt = (n: number) => all[n]?.querySelector<HTMLElement>(".ol-text")?.focus();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusAt(Math.min(idx + 1, all.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(Math.max(idx - 1, 0));
        break;
      case "ArrowRight":
        e.preventDefault();
        if (expanded === "false") toggle(sec, false);
        else focusAt(idx + 1);              // 已展开 → 进第一个子项
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (expanded === "true") toggle(sec, true);
        else {
          const parent = ancestorChain(tree(), sec)?.at(-1);
          if (parent != null) focusText(parent);
        }
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        s.requestAnchor(sec, true);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(all.length - 1);
        break;
    }
  }

  return (
    <>
      <div class="out-head">大纲<span class="sp" />
        <span style={{ "font-family": "var(--font-mono)", "font-size": "10.5px" }}>
          {s.current()?.outline.length ?? 0} 条
        </span>
        <button class="head-btn" title="全部展开" aria-label="全部展开"
          onClick={() => ui.setAllOutlineOpen(foldKeys(), true)}>
          <svg class="ico"><use href="#i-ol-expand" /></svg>
        </button>
        <button class="head-btn" title="全部收起" aria-label="全部收起"
          onClick={() => ui.setAllOutlineOpen(foldKeys(), false)}>
          <svg class="ico"><use href="#i-ol-collapse" /></svg>
        </button>
      </div>
      <div class="out-body" ref={body} role="tree" aria-label="文档大纲" onKeyDown={onKey}>
        <Show when={s.current()?.outline.length} fallback={
          <div class="ol-empty">打开文档后<br />自动生成大纲</div>
        }>
          <For each={rows()}>{(r) => {
            const it = r.node.item;
            const active = () => shownActive() === it.sec;
            return (
              <div class="ol-row" classList={{ on: active(), d2: r.depth === 2, d3: r.depth >= 3 }}
                data-ol-sec={it.sec} data-line={it.line}
                role="treeitem" aria-level={r.depth + 1} aria-selected={active()}
                aria-expanded={r.hasKids ? r.open : undefined}
                style={{ "padding-left": `${4 + r.depth * 18}px` }}>
                <Show when={r.hasKids} fallback={<span class="ol-chev-sp" />}>
                  <button type="button" class="ol-chev" classList={{ open: r.open }} tabIndex={-1}
                    title={r.open ? "收起" : "展开"} aria-label={r.open ? "收起" : "展开"}
                    onClick={(e) => { e.stopPropagation(); toggle(it.sec, r.open); }}>
                    <svg class="ico"><use href="#i-chev-r" /></svg>
                  </button>
                </Show>
                <button type="button" class="ol-text" title={"h" + it.level + " · " + it.text}
                  onClick={() => s.requestAnchor(it.sec, true)}>
                  {it.text}
                </button>
              </div>
            );
          }}</For>
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
  // 分隔符跟随路径风格：Windows 登记路径是反斜杠，硬编码 "/" 会拼出
  // `d:\a\b/ 文件名` 这种正斜杠混排（需求方 2026-11-17 指正）；mock 的 demo/ 路径仍用 "/"。
  const crumb = () => {
    const c = s.current();
    const dir = c?.meta.dir ?? "";
    const sep = dir.includes("\\") ? "\\" : "/";
    return { dir: dir || "文件夹", sep, name: c?.meta.fileName ?? "未打开文档" };
  };
  return (
    <div class="crumb-bar">
      <span class="path ellip">
        <svg class="ico"><use href="#i-folder" /></svg>
        <span>{crumb().dir}</span>
        <i>{crumb().sep}</i>
        <b>{crumb().name}</b>
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
      {/* 正文口径字数（公式/图表源码不计，2026-11-17 需求定夺）：从 src 现算，不走 DB 旧口径 */}
      <span class="si">{s.current() ? countWords(s.current()!.src).toLocaleString() + " 字" : "— 字"}</span>
      <span class="si">{s.current()?.meta.secCount ?? "—"} 节</span>
      <span class="si" id="stat-enc" onClick={() => ui.setPropsOpen(true)} title="查看文档信息">{encLabel(s.current()?.encoding)}</span>
      {/* 百分比定宽槽：位数变化不抖动（样式见 app.css .pct-slot） */}
      <span class="si">阅读 <span class="pct-slot">{Math.round(ui.readPct() * 100)}%</span></span>
      <span class="si acc" id="stat-link-btn" title="点击复制当前文档链接"
        onClick={() => {
          const c = s.current();
          if (!c) { s.toast("未打开文档"); return; }
          navigator.clipboard?.writeText(link())
            .then(() => ui.showCopied("已复制文档链接", link()))
            .catch(() => s.toast("剪贴板不可用"));
        }}>
        <code>{link()}</code>
      </span>
    </footer>
  );
}
