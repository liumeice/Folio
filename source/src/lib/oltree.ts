/* 大纲树纯函数：平铺 OutlineItem → 树 → 可见扁平行。
 * 与 libtree.ts 同风格、可单测；展开语义复刻目录树的 isDirOpen：
 *   overrides（用户显式）→ softOpen（阅读中软展开的祖先链）→ 默认只展开第一层。
 * sec 是按文档顺序编号的瞬时键：切文档 / 大纲重建后由调用方清空展开状态。 */
import type { OutlineItem } from "./types";

export interface OlNode {
  item: OutlineItem;
  children: OlNode[];
}

export interface OlRow {
  node: OlNode;
  /** 树深度（根 = 0），缩进与字号按它分档 */
  depth: number;
  hasKids: boolean;
  open: boolean;
}

/** 栈式建树：level 跳跃（h1→h4）挂到最近的更浅祖先，不造幻影节点 */
export function buildOutlineTree(outline: OutlineItem[]): OlNode[] {
  const roots: OlNode[] = [];
  const stack: OlNode[] = [];
  for (const item of outline) {
    const node: OlNode = { item, children: [] };
    while (stack.length && stack[stack.length - 1].item.level >= item.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

/** 某 sec 的祖先链（自根向下，不含自身）；找不到返回 null，根节点返回 [] */
export function ancestorChain(nodes: OlNode[], sec: number): number[] | null {
  const dfs = (list: OlNode[], path: number[]): number[] | null => {
    for (const n of list) {
      if (n.item.sec === sec) return path;
      const hit = dfs(n.children, [...path, n.item.sec]);
      if (hit) return hit;
    }
    return null;
  };
  return dfs(nodes, []);
}

/** 展开判定：用户显式优先；否则第一层默认展开，其余看是否被软展开过 */
export function isOutlineOpen(
  sec: number,
  depth: number,
  overrides: ReadonlyMap<number, boolean>,
  softOpen?: ReadonlySet<number>,
): boolean {
  const forced = overrides.get(sec);
  if (forced !== undefined) return forced;
  return depth <= 0 || (softOpen?.has(sec) ?? false);
}

/** 树 → 可见扁平行：收起的节点只出行本身，不带孩子 */
export function flattenOutline(
  nodes: OlNode[],
  overrides: ReadonlyMap<number, boolean>,
  softOpen?: ReadonlySet<number>,
  depth = 0,
  out: OlRow[] = [],
): OlRow[] {
  for (const n of nodes) {
    const hasKids = n.children.length > 0;
    const open = hasKids && isOutlineOpen(n.item.sec, depth, overrides, softOpen);
    out.push({ node: n, depth, hasKids, open });
    if (open) flattenOutline(n.children, overrides, softOpen, depth + 1, out);
  }
  return out;
}

/** 所有可折叠节点（有孩子的）的 sec，供「全部展开 / 全部收起」整批写 overrides */
export function allOutlineFoldKeys(nodes: OlNode[], out: number[] = []): number[] {
  for (const n of nodes) {
    if (n.children.length) {
      out.push(n.item.sec);
      allOutlineFoldKeys(n.children, out);
    }
  }
  return out;
}