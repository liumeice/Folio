/* 文档库目录树（schema v3 语义）——纯函数层，供 SidePanels 渲染与单测共用。
 *
 * 库只装「打开文件夹…」扫进来的东西，所以树的形状 = 已登记库根 + 磁盘上的目录层级。
 * 不变量：in_library ⇒ 位于某个已登记库根之下（db 侧由 scan 入库、remove_root 出库共同维护）。
 * 万一出现例外（升级前的旧数据），落到末尾「其他库条目」兜底，绝不把文件变没。
 *
 * 路径比对一律归一（小写 + 反斜杠转斜杠 + 去尾分隔符），但显示名从原始串切，
 * 否则 Windows 上的英文目录会被压成小写。与 folio-db::schema::path_under 同口径。 */

import type { DocMeta } from "./types";

export interface DirNode {
  /** 归一后的绝对目录路径：展开状态与列表 key 都用它 */
  key: string;
  /** 显示名（保留原始大小写） */
  name: string;
  /** 相对库根的层深，库根本人 = 0 */
  depth: number;
  dirs: DirNode[];
  files: DocMeta[];
  /** 含子目录的文档总数 */
  count: number;
}

/** 侧栏渲染用的扁平行序列（树先摊平，避免递归组件） */
export type TreeRow =
  | { kind: "dir"; node: DirNode }
  | { kind: "file"; doc: DocMeta; depth: number };

export const normSlashes = (p: string) => p.replace(/\\/g, "/");
export const normKey = (p: string) => normSlashes(p).toLowerCase().replace(/\/+$/, "");
export const trimSep = (p: string) => p.replace(/[\\/]+$/, "");

/** 末段目录名（归一后切分，用于显示） */
export const leafName = (p: string) => {
  const segs = normSlashes(trimSep(p)).split("/");
  return segs[segs.length - 1] || p;
};

/** 文件所在目录属于哪个库根（嵌套库根时以最具体者为准）。
 *  key=归一比对用，raw=原始串（切相对路径用，保大小写）。
 *  注意入参是**目录**（DocMeta.dir），直接躺在库根下的文件其 dir === 根，算命中——
 *  Rust 侧 library_membership 拿的是文件路径，那里「相等」不该命中，两侧别抄错。 */
export function rootOf(dir: string, roots: string[]): { key: string; raw: string } | null {
  const f = normKey(dir);
  let best: { key: string; raw: string } | null = null;
  for (const r of roots) {
    const k = normKey(r);
    if (!k) continue;
    const hit = f === k || (f.startsWith(k) && f.charAt(k.length) === "/");
    if (hit && (!best || k.length > best.key.length)) best = { key: k, raw: trimSep(r) };
  }
  return best;
}

const mkDir = (key: string, name: string, depth: number): DirNode =>
  ({ key, name, depth, dirs: [], files: [], count: 0 });

/** 目录=名称自然序（中文拼音、数字按数值）；文件=文件名自然序升序（2026-11-16 需求：不再按 mtime 倒序） */
const byName = (a: DirNode, b: DirNode) =>
  a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
const byFileName = (a: DocMeta, b: DocMeta) =>
  a.fileName.localeCompare(b.fileName, "zh-Hans-CN", { numeric: true, sensitivity: "base" });

/** 后序整理：先排序子节点，再汇总「含子目录的文档数」 */
function prepTree(n: DirNode): void {
  n.dirs.sort(byName);
  n.files.sort(byFileName);
  for (const c of n.dirs) prepTree(c);
  n.count = n.files.length + n.dirs.reduce((s, c) => s + c.count, 0);
}

/** 库根列表 + 库成员 → 目录树（每个库根一个顶层节点）。
 *  多个库根末段同名（两个不同的 …\docs 很常见）时，顶层标签带上级目录以免歧义。 */
export function buildLibTree(roots: string[], libDocs: DocMeta[]): DirNode[] {
  const tops = new Map<string, DirNode>();
  const rawByKey = new Map<string, string>();
  const loose = mkDir("*", "其他库条目", 0);
  for (const d of libDocs) {
    const r = rootOf(d.dir, roots);
    if (!r) { loose.files.push(d); continue; }
    const hadRoot = tops.get(r.key);
    let node: DirNode = hadRoot ?? mkDir(r.key, leafName(r.raw), 0);
    if (!hadRoot) { tops.set(r.key, node); rawByKey.set(r.key, r.raw); }
    // 相对路径用原始串切，显示名才不丢大小写
    const rel = normSlashes(d.dir.slice(r.raw.length)).replace(/^\/+/, "");
    for (const seg of rel ? rel.split("/") : []) {
      const key = node.key + "/" + seg.toLowerCase();
      const had: DirNode | undefined = node.dirs.find((x) => x.key === key);
      const child: DirNode = had ?? mkDir(key, seg, node.depth + 1);
      if (!had) node.dirs.push(child);
      node = child;
    }
    node.files.push(d);
  }
  const arr = [...tops.values()];
  if (loose.files.length) arr.push(loose);
  // 顶层标签去歧义：末段同名就补一级父目录（D:\a\Folio\docs 与 D:\a\CC-DOCS-MD\docs 都叫 docs）
  const tally = new Map<string, number>();
  for (const n of arr) tally.set(n.name, (tally.get(n.name) ?? 0) + 1);
  for (const n of arr) {
    if ((tally.get(n.name) ?? 0) < 2) continue;
    const raw = rawByKey.get(n.key);
    if (!raw) continue;
    const segs = normSlashes(trimSep(raw)).split("/");
    if (segs.length >= 2) n.name = `${segs[segs.length - 2]} / ${segs[segs.length - 1]}`;
  }
  for (const n of arr) prepTree(n);
  arr.sort(byName);
  return arr;
}

/** 展开状态：用户点过的（overrides 里有记录，含"全部展开/全部收起"整批写入）以记录为准；
 *  没点过的默认**只展开库根本身**（depth 0）——刚打开一个目录时看到的是它的第一层子目录列表，
 *  而不是层层铺开的深树。reveal 里的键（当前文档所在的祖先链）在没有显式记录时也算展开，
 *  免得正在读的文档被收起的目录藏起来。 */
export const isDirOpen = (
  n: DirNode, overrides: ReadonlyMap<string, boolean>, reveal?: ReadonlySet<string>,
) => overrides.get(n.key) ?? (n.depth <= 0 || (reveal?.has(n.key) ?? false));

/** 当前文档的祖先目录键链（含它自己所在目录），用于自动 reveal */
export function revealKeys(dirPath: string | null | undefined, roots: string[]): Set<string> {
  const out = new Set<string>();
  if (!dirPath) return out;
  const r = rootOf(dirPath, roots);
  if (!r) return out;
  out.add(r.key);
  let acc = r.key;
  const rel = normSlashes(dirPath.slice(r.raw.length)).replace(/^\/+/, "");
  for (const seg of rel ? rel.split("/") : []) {
    acc = acc + "/" + seg.toLowerCase();
    out.add(acc);
  }
  return out;
}

/** 树里所有目录键（"全部展开/全部收起"整批写 overrides 用） */
export function allDirKeys(nodes: DirNode[], out: string[] = []): string[] {
  for (const n of nodes) { out.push(n.key); allDirKeys(n.dirs, out); }
  return out;
}

/** 树 → 扁平行序列：收起的目录只出行本身，不带孩子 */
export function flattenTree(
  node: DirNode, overrides: ReadonlyMap<string, boolean>,
  out: TreeRow[] = [], reveal?: ReadonlySet<string>,
): TreeRow[] {
  out.push({ kind: "dir", node });
  if (!isDirOpen(node, overrides, reveal)) return out;
  for (const c of node.dirs) flattenTree(c, overrides, out, reveal);
  for (const f of node.files) out.push({ kind: "file", doc: f, depth: node.depth + 1 });
  return out;
}

export function flattenAll(
  tops: DirNode[], overrides: ReadonlyMap<string, boolean>, reveal?: ReadonlySet<string>,
): TreeRow[] {
  const out: TreeRow[] = [];
  for (const t of tops) flattenTree(t, overrides, out, reveal);
  return out;
}
