/* 大纲树纯函数断言（大纲折叠方案 §1）。
 * 运行：node --experimental-strip-types --test tests/oltree.test.ts
 * 覆盖：level 跳跃建树、祖先链、默认只展开第一层、overrides/softOpen 优先级、全部折叠键。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allOutlineFoldKeys, ancestorChain, buildOutlineTree, flattenOutline, isOutlineOpen,
} from "../src/lib/oltree.ts";
import type { OutlineItem } from "../src/lib/types.ts";

const item = (sec: number, level: number, text = `h${sec}`): OutlineItem => ({ sec, level, text, line: sec * 10 });

const SAMPLE: OutlineItem[] = [
  item(1, 1, "A"),
  item(2, 2, "A1"),
  item(3, 3, "A1a"),
  item(4, 2, "A2"),
  item(5, 1, "B"),
  item(6, 2, "B1"),
];

const NO_OVERRIDES = new Map<number, boolean>();
const NO_SOFT = new Set<number>();

function shape(rows: ReturnType<typeof flattenOutline>): string[] {
  return rows.map((r) => `${r.node.item.text}@${r.depth}${r.hasKids ? (r.open ? "+" : "-") : ""}`);
}

test("建树：普通层级与多根", () => {
  const roots = buildOutlineTree(SAMPLE);
  assert.equal(roots.length, 2);
  assert.deepEqual(roots.map((n) => n.item.text), ["A", "B"]);
  assert.deepEqual(roots[0].children.map((n) => n.item.text), ["A1", "A2"]);
  assert.deepEqual(roots[0].children[0].children.map((n) => n.item.text), ["A1a"]);
});

test("建树：level 跳跃挂到最近更浅祖先，不造幻影节点", () => {
  const roots = buildOutlineTree([
    item(1, 1, "H1"),
    item(2, 3, "H1 直接跳到 H3"),
    item(3, 2, "H2 跟随 H1"),
  ]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].item.text, "H1");
  assert.deepEqual(roots[0].children.map((n) => n.item.text), ["H1 直接跳到 H3", "H2 跟随 H1"]);
  assert.equal(roots[0].children[0].children.length, 0, "跳跃不伪造中间层");
});

test("祖先链：深层、根、未命中", () => {
  const roots = buildOutlineTree(SAMPLE);
  assert.deepEqual(ancestorChain(roots, 3), [1, 2]);
  assert.deepEqual(ancestorChain(roots, 1), []);
  assert.equal(ancestorChain(roots, 99), null);
});

test("默认只展开第一层：根展开、二级以下收起", () => {
  const roots = buildOutlineTree(SAMPLE);
  const rows = flattenOutline(roots, NO_OVERRIDES, NO_SOFT);
  assert.deepEqual(shape(rows), ["A@0+", "A1@1-", "A2@1", "B@0+", "B1@1"]);
  assert.equal(rows.length, 5, "A1a 默认收起，不出现");
});

test("overrides 优先：显式收起根 / 显式展开二级", () => {
  const roots = buildOutlineTree(SAMPLE);
  const closedA = new Map<number, boolean>([[1, false]]);
  assert.deepEqual(shape(flattenOutline(roots, closedA, NO_SOFT)), ["A@0-", "B@0+", "B1@1"]);
  const openA1 = new Map<number, boolean>([[2, true]]);
  assert.deepEqual(shape(flattenOutline(roots, openA1, NO_SOFT)), ["A@0+", "A1@1+", "A1a@2", "A2@1", "B@0+", "B1@1"]);
});

test("softOpen 软展开；显式收起仍压过软展开", () => {
  const roots = buildOutlineTree(SAMPLE);
  const soft = new Set<number>([2]);
  assert.deepEqual(shape(flattenOutline(roots, NO_OVERRIDES, soft)), ["A@0+", "A1@1+", "A1a@2", "A2@1", "B@0+", "B1@1"]);
  const closed = new Map<number, boolean>([[2, false]]);
  assert.ok(!shape(flattenOutline(roots, closed, soft)).some((s) => s.startsWith("A1a")), "显式收起优先");
});

test("第一层判定与 depth 挂钩，不依赖 heading level", () => {
  assert.equal(isOutlineOpen(1, 0, NO_OVERRIDES), true);
  assert.equal(isOutlineOpen(2, 1, NO_OVERRIDES), false);
  assert.equal(isOutlineOpen(2, 1, NO_OVERRIDES, new Set([2])), true);
  assert.equal(isOutlineOpen(2, 1, new Map([[2, false]]), new Set([2])), false);
});

test("全部折叠键：只含有孩子的节点", () => {
  const roots = buildOutlineTree(SAMPLE);
  assert.deepEqual(allOutlineFoldKeys(roots).sort((a, b) => a - b), [1, 2, 5]);
});