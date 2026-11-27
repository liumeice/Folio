/* 编辑窗列表 Tab 重排（2026-11-27 编辑窗口优化）：
 * Tab 缩进后有序标记按容器重排，阅读区才能从 2.1. 起显示子序号。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { indentBlockLines, renumberOrderedBlock, splitListLine } from "../../src/lib/listNumbers.ts";

const renumber = (src: string, touched: number[], outdent = false) => {
  const lines = src.split("\n");
  const set = new Set(touched);
  return renumberOrderedBlock(indentBlockLines(lines, set, "\t", outdent), set).join("\n");
};

test("splitListLine：有序/无序/任务项与缩进", () => {
  assert.deepEqual(
    splitListLine("   12) hello"),
    { indent: "   ", marker: "12)", ordered: true, num: 12, delim: ")", gap: " ", text: "hello" },
  );
  assert.equal(splitListLine("- [ ] task")?.ordered, false);
  assert.equal(splitListLine("plain text"), null);
});

test("Tab：3. 移到 2. 下方 → 子列表从 1. 开始（阅读区 2.1.），同级顺延", () => {
  assert.equal(renumber("1. one\n2. two\n3. three\n4. four", [2]),
    "1. one\n2. two\n\t1. three\n3. four");
});

test("Tab：追加到已有子列表末尾 → 沿该组首号顺延，不重置为 1", () => {
  assert.equal(renumber("2. two\n   1. a\n   2. b\n3. three", [3]),
    "2. two\n   1. a\n   2. b\n\t3. three");
});

test("Tab：多行一起缩进 → 子列表 1、2", () => {
  assert.equal(renumber("1. one\n2. two\n3. three\n4. four", [2, 3]),
    "1. one\n2. two\n\t1. three\n\t2. four");
});

test("不同父项下的子列表各自从 1 开始；未动的列表数字不变", () => {
  const src = "1. a\n   1. a1\n2. b\n   1. b1";
  assert.equal(renumber(src, []), src);
});

test("Shift-Tab：子项回到顶层后按顶层组顺延", () => {
  assert.equal(renumber("1. one\n2. two\n\t1. a\n\t2. b", [3], true),
    "1. one\n2. two\n\t1. a\n3. b");
});

test("无序列表只缩进，不改标记；空行不制造空白缩进", () => {
  assert.equal(renumber("- a\n\n- b", [2]), "- a\n\n\t- b");
});