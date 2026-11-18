/* 【已停用 2026-11-17】打开文件/打开文件夹/保存已替换回 Windows 原生系统对话框（tauri-plugin-dialog），
 * 本组件不再挂载（App.tsx），仅留存备查。以下为其原始说明：
 * 应用内文件/目录选择对话框（UI 规范 v1.1 §8.6）：
 * 仿 Windows 通用对话框版式（左树右表 + 地址栏 + 文件名/类型/按钮两行），皮肤全用 Folio 规范件；
 * 2026-11-16 起替代 tauri-plugin-dialog 的 open()——不再调起系统原生窗，读的是真实盘（folio-fs::list_dir）。
 * 浏览器回退层不走这里（actions.pickPaths 分流到遗留 input）。
 * 结果经 ui.finishPick 兑现 Promise：files 模式=路径数组（可多选），dir 模式=单个目录。 */
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { api, MY_PC } from "../lib/api";
import * as ui from "../lib/ui";
import { useStore } from "../lib/store";
import type { DirListing, FsEntry, FsFile } from "../lib/types";

const PK_FMTS: { t: string; exts: string[] | null }[] = [
  { t: "所有支持的文件 (*.md; *.markdown; *.txt)", exts: null },
  { t: "Markdown (*.md)", exts: ["md"] },
  { t: "文本文件 (*.txt)", exts: ["txt"] },
];

const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

function fmtDate(secs: number): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const now = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() === now.getFullYear() ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}

export default function PickDialog() {
  const s = useStore();
  const req = () => ui.pickReq();
  const dirMode = () => req()?.mode === "dir";
  const saveMode = () => req()?.mode === "save";

  const [node, setNode] = createSignal<string>(MY_PC);
  const [listing, setListing] = createSignal<DirListing | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [back, setBack] = createSignal<string[]>([]);
  const [fwd, setFwd] = createSignal<string[]>([]);
  const [selFiles, setSelFiles] = createSignal<FsFile[]>([]);
  const [selDir, setSelDir] = createSignal<FsEntry | null>(null);
  const [fname, setFname] = createSignal("");
  const [q, setQ] = createSignal("");
  const [fmt, setFmt] = createSignal(0);
  const [fmtMenu, setFmtMenu] = createSignal(false);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set([MY_PC]));
  const [cache, setCache] = createSignal<Record<string, DirListing>>({});
  let seq = 0;
  const [treeW, setTreeW] = createSignal(176);
  let pkDrag: { x: number; w: number } | null = null;

  async function ensure(path: string): Promise<DirListing | null> {
    const hit = cache()[path];
    if (hit) return hit;
    try {
      const l = await api.listDir(path);
      setCache((c) => ({ ...c, [path]: l }));
      return l;
    } catch { return null; }
  }

  /** 不查盘的纯字符串上级链（Windows 形态；用于预载 + 展开，不依赖已缓存的 listing） */
  function parentChain(p: string): string[] {
    const out: string[] = [];
    let cur: string | null = p;
    while (cur && cur !== MY_PC) {
      out.push(cur);
      if (/^[a-zA-Z]:\\?$/.test(cur)) break;            // 盘符根：上一层就是此电脑
      const t: string = cur.replace(/[\\/]+$/, "");
      const i: number = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
      cur = i >= 2 ? t.slice(0, i) + "\\" : MY_PC;
    }
    if (out[out.length - 1] !== MY_PC) out.push(MY_PC);
    return out;
  }

  async function goto(path: string, push = true) {
    const my = ++seq;
    if (push && path !== node()) { setBack((b) => [...b, node()]); setFwd([]); }
    setNode(path); setSelFiles([]); setSelDir(null); setQ(""); setErr(null);
    const chain = parentChain(path);
    await Promise.all(chain.map((c) => ensure(c)));     // 祖先链预载：快速访问直达深层时左树也能定位
    if (my !== seq) return;   // 更新的导航已接管
    const l0 = cache()[path] ?? null;
    setListing(l0);
    if (!l0) setErr("无法读取该文件夹");
    setExpanded((e) => { const n = new Set(e); for (const c of chain) n.add(c); return n; });
    setFname(dirMode() ? (path === MY_PC ? "" : path) : saveMode() ? fname() : "");   // 保存模式：名字跨导航保留
  }

  /** 仅在「每次打开对话框」时重置。
   *  教训（2026-11-16 bug）：原先直接在 effect 里调 goto()——goto 读写 node/expanded 等信号，
   *  会把它们登记为本 effect 的依赖，于是「点击行 → goto → 信号变 → effect 重跑 → 重置回此电脑」，
   *  用户看到的就是「一点文件夹就回到初始状态」。解法：只追踪 req() 的取值变化（prev 守卫），
   *  副作用经 queueMicrotask 脱钩到依赖图之外。 */
  let prevReq: unknown = null;
  createEffect(() => {
    const r = req();
    if (r === prevReq) return;
    const fresh = r != null;
    prevReq = r;
    if (fresh) queueMicrotask(async () => {
      setFmt(0); setFmtMenu(false); setBack([]); setFwd([]);
      setExpanded(new Set([MY_PC]));
      const start = r!.mode === "save" && r!.dir ? r!.dir : MY_PC;
      await goto(start, false);
      if (r!.mode === "save") setFname(r!.name || "未命名文档.md");
    });
  });

  const quick = createMemo(() => {
    const out: FsEntry[] = [];
    const seen = new Set<string>();
    const add = (path: string) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      out.push({ name: base(path), path });
    };
    for (const r of s.roots()) add(r);
    for (const rc of s.recents()) { if (out.length >= 6) break; add(rc.meta.dir); }
    return out;
  });

  const rowsDirs = createMemo<FsEntry[]>(() => {
    const l = listing(); if (!l) return [];
    const k = q().trim().toLowerCase();
    return l.dirs.filter((d) => !k || d.name.toLowerCase().includes(k));
  });
  const rowsFiles = createMemo<FsFile[]>(() => {
    const l = listing(); if (!l) return [];
    const k = q().trim().toLowerCase();
    const exts = PK_FMTS[fmt()].exts;
    return l.files.filter((f) => (exts ? exts.includes((f.name.split(".").pop() ?? "").toLowerCase()) : f.supported)
      && (!k || f.name.toLowerCase().includes(k)));
  });

  const canOk = createMemo(() => {
    if (err()) return false;
    if (saveMode()) return !!fname().trim() && node() !== MY_PC;   // 保存：名字必填，且不能停在「此电脑」
    if (dirMode()) return !!selDir() || node() !== MY_PC;
    return selFiles().length > 0 || !!fname().trim();
  });

  function pickFile(f: FsFile, ctrl: boolean) {
    const cur = selFiles();
    setSelFiles(ctrl
      ? (cur.some((x) => x.path === f.path) ? cur.filter((x) => x.path !== f.path) : [...cur, f])
      : [f]);
    const sel = selFiles();
    setFname(sel.length > 1 ? sel.map((x) => `"${x.name}"`).join(" ") : (sel[0]?.name ?? ""));
  }
  /** 2026-11-16 需求统一：目录模式「单击文件夹=进入展开」（不再依赖双击选中关闭）；
   *  文件模式沿用 Windows：单击进目录、单击文件选中、Ctrl 多选、双击即开。 */
  function onRow(kind: "dir" | "file", obj: FsEntry | FsFile, e: MouseEvent) {
    if (kind === "dir") {
      void goto((obj as FsEntry).path);
    }
    else if (saveMode()) setFname((obj as FsFile).name);   // 保存模式：点已有文件=把名字填进输入框（同 Windows）
    else if (!dirMode()) pickFile(obj as FsFile, e.ctrlKey || e.metaKey);
  }
  /** 双击/Enter（§8.6）：目录一律=进入展开（两种模式同语义）；文件=选中并打开。
   *  目录模式「以此目录开库」只走「选择文件夹」按钮——曾把双击目录写成 confirm()，
   *  导致对话框直接关闭（2026-11-16 bug 修正）。 */
  function onRowActivate(kind: "dir" | "file", obj: FsEntry | FsFile) {
    if (kind === "dir") { void goto((obj as FsEntry).path); return; }
    if (saveMode()) { setFname((obj as FsFile).name); void confirm(); return; }
    if (!dirMode()) { pickFile(obj as FsFile, false); void confirm(); }
  }

  function goBack() {
    const b = back(); if (!b.length) return;
    setFwd([node(), ...fwd()]);
    setBack(b.slice(0, -1));
    void goto(b[b.length - 1], false);
  }
  function goFwd() {
    const f = fwd(); if (!f.length) return;
    setBack([...back(), node()]);
    setFwd(f.slice(1));
    void goto(f[0], false);
  }
  function goUp() {
    const p = listing()?.parent;
    if (p) void goto(p);
  }
  function toggleExpand(p: string) {
    const e = new Set(expanded());
    if (e.has(p)) e.delete(p);
    else { e.add(p); void ensure(p); }
    setExpanded(e);
  }

  async function confirm() {
    if (saveMode()) {
      const nd = node();
      let name = fname().trim().replace(/^"|"$/g, "");
      if (!name || nd === MY_PC) return;
      if (!/\.(md|markdown|txt)$/i.test(name)) name += ".md";     // 没写扩展名按 Markdown 补全（同 Windows 保存类型语义）
      const dir = nd.replace(/[\\/]+$/, "");
      const full = dir + "\\" + name;
      const clash = !!listing()?.files.some((f) => f.name.toLowerCase() === name.toLowerCase());
      const done = () => ui.finishPick({ path: full, name });
      if (clash) {
        const ok = await ui.ask({
          icon: "i-info", title: "确认覆盖", sub: `「${name}」在这个文件夹里已经存在。`,
          rows: [["保存位置", full]],
          note: "保存会用当前编辑内容覆盖原文件，覆盖后原内容无法找回。点「取消」返回继续填写。",
          ok: "覆盖保存",
        });
        if (ok) done();
        return;
      }
      done(); return;
    }
    if (dirMode()) {
      const t = fname().trim();
      const target = t && /^[a-zA-Z]:|[\\/]/.test(t) ? t : (selDir()?.path ?? node());
      if (target === MY_PC) return;
      ui.finishPick([target.replace(/[\\/]+$/, "") || target]);
      return;
    }
    const sel = selFiles();
    if (sel.length) { ui.finishPick(sel.map((f) => f.path)); return; }
    const t = fname().trim();
    if (!t) return;
    const l = listing();
    const hit = l?.files.find((f) => f.name.toLowerCase() === t.toLowerCase())
      ?? l?.files.find((f) => f.name.toLowerCase() === t.toLowerCase() + ".md");
    if (hit) ui.finishPick([hit.path]);
    else s.toast(`找不到 “${t}”。请检查文件名拼写，然后重试。`);
  }

  const crumbs = createMemo(() => {
    const out: { name: string; path: string }[] = [{ name: "此电脑", path: MY_PC }];
    const p = node();
    if (p === MY_PC || !p) return out;
    const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
    let acc = "";
    parts.forEach((seg, i) => {
      acc = i === 0 ? seg + "\\" : acc + seg + "\\";
      out.push({ name: seg, path: acc });
    });
    return out;
  });

  const TreeL = (props: { path: string; name: string; depth: number }) => {
    const isOpen = () => expanded().has(props.path);
    const kids = () => cache()[props.path]?.dirs ?? [];
    return (
      <>
        <div class="tf dir" classList={{ on: node() === props.path }} tabindex={-1}
          style={{ "padding-left": 4 + props.depth * 12 + "px" }}
          title={props.path === MY_PC ? "此电脑" : props.path}
          onClick={() => void goto(props.path)}>
          <span class="pk-tg" onClick={(e) => { e.stopPropagation(); toggleExpand(props.path); }}>
            <Show when={kids().length || !cache()[props.path]} fallback={<span class="pk-tg-pad" />}>
              <svg class="ico ico-12"><use href={isOpen() ? "#i-chev-d" : "#i-chev-r"} /></svg>
            </Show>
          </span>
          <svg class="ico ico-14 chev"><use href="#i-folder" /></svg>
          <span class="nm">{props.name}</span>
        </div>
        <Show when={isOpen()}>
          <For each={kids()}>{(k) => <TreeL path={k.path} name={k.name} depth={props.depth + 1} />}</For>
        </Show>
      </>
    );
  };

  return (
    <Show when={req()} keyed>{(r) => (
      <div class="overlay mid open" id="pick-overlay"
        onMouseDown={(e) => { if (e.target === e.currentTarget) ui.finishPick(null); }}>
        <div class="modal" style={{ width: "780px", "max-width": "94vw" }}>
          <div class="modal-h">
            <span class="mi2"><svg class="ico ico-18"><use href="#i-folder-open" /></svg></span>
            <div style={{ "min-width": "0" }}>
              <div class="mt">{r.mode === "files" ? "打开" : r.mode === "save" ? "保存文档" : "选择文件夹"}</div>
              <div class="md2">{r.mode === "files"
                ? "选中或双击文件即打开 · 按住 Ctrl 可多选"
                : r.mode === "save"
                  ? "选一个文件夹并填写文件名 · 同名会先问是否覆盖"
                  : "选中装着文档的文件夹并打开 · 切换或关闭现有文件夹前都会先跟你确认"}</div>
            </div>
            <span class="sp" />
            <span class="x" onClick={() => ui.finishPick(null)}><svg class="ico ico-14"><use href="#i-x" /></svg></span>
          </div>
          <div class="modal-b pk-b">
            <div class="pk-bar">
              <span class="pk-nav" classList={{ off: !back().length }} title="后退" onClick={goBack}>
                <svg class="ico ico-12"><use href="#i-arrow-left" /></svg></span>
              <span class="pk-nav" classList={{ off: !fwd().length }} title="前进" onClick={goFwd}>
                <svg class="ico ico-12"><use href="#i-arrow-right" /></svg></span>
              <span class="pk-nav" classList={{ off: !listing()?.parent }} title="上移到…" onClick={goUp}>
                <svg class="ico ico-12"><use href="#i-arrow-up" /></svg></span>
              <div class="pk-path">
                <For each={crumbs()}>{(c, i) => <>
                  <Show when={i() > 0}><i>›</i></Show>
                  <b onClick={() => void goto(c.path)}>{c.name}</b>
                </>}</For>
              </div>
              <div class="searchf pk-search">
                <input placeholder={"搜索 " + (node() === MY_PC ? "此电脑" : base(node())) + "…"}
                  value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
              </div>
            </div>
            <div class="pk-grid">
              <div class="pk-side" style={{ width: treeW() + "px" }}>
                <div class="pk-grp">快速访问</div>
                <For each={quick()}>{(d) => (
                  <div class="tf dir" tabindex={-1} title={d.path}
                    style={{ "padding-left": "16px" }} onClick={() => void goto(d.path)}>
                    <span class="pk-tg-pad" />
                    <svg class="ico ico-14 chev"><use href="#i-folder" /></svg>
                    <span class="nm">{d.name}</span>
                  </div>
                )}</For>
                <div class="pk-grp">此电脑</div>
                <TreeL path={MY_PC} name="此电脑" depth={0} />
              </div>
              {/* 左右宽度分隔条（120–420px，2026-11-16）：运行时保持，本次会话内所有对话框共用 */}
              <span class="pk-split" title="拖动调节左右宽度"
                onPointerDown={(e) => { pkDrag = { x: e.clientX, w: treeW() }; e.currentTarget.setPointerCapture(e.pointerId); }}
                onPointerMove={(e) => { if (pkDrag) setTreeW(Math.min(420, Math.max(120, pkDrag.w + e.clientX - pkDrag.x))); }}
                onPointerUp={() => { pkDrag = null; }} />
              <div class="pk-main">
                <div class="pk-th"><span class="c1">名称</span><span class="c2">修改日期</span></div>
                <div class="pk-list">
                  <Show when={err()} fallback={<>
                    <For each={rowsDirs()}>{(d) => (
                      <div class="tf dir" classList={{ on: dirMode() && selDir()?.path === d.path }}
                        data-k="dir" data-key={d.path}
                        tabindex={0} title={d.path}
                        onClick={(e) => onRow("dir", d, e)}
                        onDblClick={() => onRowActivate("dir", d)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowActivate("dir", d); } }}>
                        <svg class="ico ico-14 chev"><use href="#i-folder" /></svg>
                        <span class="nm">{d.name}</span><span class="mt"></span>
                      </div>
                    )}</For>
                    <For each={rowsFiles()}>{(f) => (
                      <div class="tf" classList={{ on: selFiles().some((x) => x.path === f.path), "pk-off": dirMode() }}
                        data-k="file" data-key={f.path}
                        tabindex={0} title={f.path}
                        onClick={(e) => onRow("file", f, e)}
                        onDblClick={() => onRowActivate("file", f)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowActivate("file", f); } }}>
                        <svg class="ico ico-14"><use href={f.supported ? "#i-md" : "#i-file-text"} /></svg>
                        <span class="nm">{f.name}</span><span class="mt">{fmtDate(f.mtime)}</span>
                      </div>
                    )}</For>
                    <Show when={!rowsDirs().length && !rowsFiles().length}>
                      <div class="ol-empty">{q() ? `没有找到与 “${q()}” 匹配的文件` : "空文件夹"}</div>
                    </Show>
                  </>}>
                    <div class="ol-empty">无法读取该文件夹<br />{err()}</div>
                  </Show>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-f pk-f">
            <label class="pk-label" for="pk-name">文件名(<u>N</u>)：</label>
            <input id="pk-name" class="pk-fname" value={fname()} spellcheck={false} autocomplete="off"
              onInput={(e) => setFname(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void confirm(); } }} />
            <div class="pk-r2">
              <Show when={!dirMode() && !saveMode()}>
                {/* 下拉钮与菜单是同层兄弟（div 嵌 button 不合法）；菜单经 .pk-r2 相对定位悬在钮上方 */}
                <button type="button" class="pk-fmt" title="文件类型" aria-haspopup="true"
                  onClick={(e) => { e.stopPropagation(); setFmtMenu(!fmtMenu()); }}>
                  <span>{PK_FMTS[fmt()].t}</span>
                  <svg class="ico ico-12"><use href="#i-chev-d" /></svg>
                </button>
                <span class="pk-fmtmenu" classList={{ open: fmtMenu() }}>
                  <For each={PK_FMTS}>{(o, i) => (
                    <div class="mi" onClick={() => { setFmt(i()); setFmtMenu(false); }}>
                      <span class="ck" style={{ visibility: fmt() === i() ? "visible" : "hidden" }} />
                      <span class="t">{o.t}</span>
                    </div>
                  )}</For>
                </span>
              </Show>
              <span class="sp" />
              <span class="mfb">
                <button class="btn" onClick={() => ui.finishPick(null)}>取消</button>
                <button class="btn primary" disabled={!canOk()} onClick={() => void confirm()}>
                  {dirMode() ? "选择文件夹" : saveMode() ? "保存(S)" : "打开(O)"}
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>
    )}</Show>
  );
}
