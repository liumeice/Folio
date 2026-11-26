/* 编辑历史下拉的数据层断言（Word 式撤销/重做，2026-11-26）：
 * 以 undoDepth 为锚的分组、合并输入、撤销指针、重做分支截断与 CM 修剪对齐。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { emptyJournal, historySnippet, reduceJournal, txTexts } from "../../src/lib/editorJournal.ts";

test("txTexts：一次事务里取插入/删除文本", () => {
  const state = EditorState.create({ doc: "abc" });
  const tr = state.update({ changes: { from: 1, to: 2, insert: "XYZ" } });
  assert.deepEqual(txTexts(tr), { added: "XYZ", removed: "b" });
});

test("日志：新步骤按 depth 记录；连续输入合并；命令单独成步", () => {
  let j = emptyJournal();
  j = reduceJournal(j, { undoDepth: 1, redoDepth: 0, added: "abc", removed: "" });
  assert.equal(j.steps.length, 1);
  assert.equal(j.steps[0].kind, "type");
  assert.equal(j.steps[0].depth, 1);
  assert.equal(j.depth, 1);

  // depth 不变 = CM 合并了连续输入：文本累加，不新增行
  j = reduceJournal(j, { undoDepth: 1, redoDepth: 0, added: "def", removed: "" });
  assert.equal(j.steps.length, 1);
  assert.equal(j.steps[0].added, "abcdef");

  // 命令事务（带 label）另起一步
  j = reduceJournal(j, { undoDepth: 2, redoDepth: 0, added: "| a |", removed: "", label: "插入表格" });
  assert.equal(j.steps.length, 2);
  assert.equal(j.steps[1].kind, "cmd");
  assert.equal(j.steps[1].added, "插入表格");
});

test("日志：撤销只回指针、保留重做分支；撤销后输入截断重做分支", () => {
  let j = emptyJournal();
  j = reduceJournal(j, { undoDepth: 1, redoDepth: 0, added: "a", removed: "" });
  j = reduceJournal(j, { undoDepth: 2, redoDepth: 0, added: "b", removed: "" });
  j = reduceJournal(j, { undoDepth: 1, redoDepth: 1, navigation: true });
  assert.equal(j.depth, 1);
  assert.equal(j.steps.length, 2, "步骤仍保留供重做列表使用");

  j = reduceJournal(j, { undoDepth: 2, redoDepth: 0, added: "X", removed: "" });
  assert.equal(j.steps.length, 2);
  assert.equal(j.steps[1].added, "X");
  assert.equal(j.steps[1].kind, "type");
});

test("日志：删除/替换识别；CM 修剪旧事件时同步裁掉日志头部", () => {
  let j = emptyJournal();
  j = reduceJournal(j, { undoDepth: 1, redoDepth: 0, added: "", removed: "abc" });
  assert.equal(j.steps[0].kind, "delete");
  j = reduceJournal(j, { undoDepth: 2, redoDepth: 0, added: "N", removed: "old" });
  assert.equal(j.steps[1].kind, "replace");

  // 总历史只剩 1 个事件（更老的被 CM minDepth 修剪）：日志只留最新一步并重排 depth
  const trimmed = reduceJournal({ steps: j.steps, depth: 2, redo: 0 }, { undoDepth: 1, redoDepth: 0, navigation: true });
  assert.equal(trimmed.steps.length, 1);
  assert.equal(trimmed.steps[0].depth, 1);
});

test("historySnippet：取首个非空行并截断", () => {
  assert.equal(historySnippet("\n\n  hello world  \nnext"), "hello world");
  assert.equal(historySnippet(""), "");
  assert.equal(historySnippet("x".repeat(40)).length, 25); // 24 字 + 省略号
});