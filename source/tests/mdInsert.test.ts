/* mdInsert：编辑窗右键插入模板的纯函数断言（方案 N-CTX-01 §3/§4） */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codeBlockOp, hrOp, imageOp, insertBlock, linkOp, listOp, prefixLinesOp, tableOp, wrapOp,
  type EditOp,
} from "../src/lib/mdInsert.ts";

const apply = (src: string, op: EditOp) => src.slice(0, op.from) + op.insert + src.slice(op.to);

test("表格 3×3：表头 + 分隔行 + 2 数据行，光标进第一格", () => {
  const op = tableOp("", 0, 0, 3, 3);
  assert.equal(apply("", op),
    "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |");
  assert.deepEqual([op.selFrom, op.selTo], [2, 2]);
});

test("块级模板：普通行后插入，前后各补空行", () => {
  const src = "hello\nworld";
  const op = insertBlock(src, 2, 2, "---", 3);
  assert.equal(apply(src, op), "hello\n\n---\n\nworld");
  assert.equal(op.selFrom, 10);
});

test("块级模板：空行原位替换，后续正文前补空行", () => {
  const src = "a\n\nb";
  const op = insertBlock(src, 2, 2, "---", 3);
  assert.equal(apply(src, op), "a\n---\n\nb");
});

test("块级模板：文档首不加前导空行", () => {
  const src = "\ntext";
  const op = insertBlock(src, 0, 0, "---", 3);
  assert.equal(apply(src, op), "---\n\ntext");
});

test("块级模板：文档尾不补尾随空行", () => {
  const src = "a\n";
  const op = insertBlock(src, 2, 2, "---", 3);
  assert.equal(apply(src, op), "a\n---");
});

test("包裹：符号不计入选区，原文保持选中", () => {
  const src = "hello world";
  const op = wrapOp(src, 0, 5, "bold");
  assert.equal(apply(src, op), "**hello** world");
  assert.deepEqual([op.selFrom, op.selTo], [2, 7]);
});

test("链接包裹：光标进 url；新建链接选中「文本」占位", () => {
  const wrapped = wrapOp("hello", 0, 5, "link");
  assert.equal(apply("hello", wrapped), "[hello](url)");
  assert.deepEqual([wrapped.selFrom, wrapped.selTo], [8, 8]);
  const made = linkOp("", 0, 0);
  assert.equal(apply("", made), "[文本](url)");
  assert.deepEqual([made.selFrom, made.selTo], [1, 3]);
});

test("图片：选中「描述」占位", () => {
  const op = imageOp("", 0, 0);
  assert.equal(apply("", op), "![描述](images/文件名.png)");
  assert.deepEqual([op.selFrom, op.selTo], [2, 4]);
});

test("标题：替换原有级别前缀；选区逐行", () => {
  const one = prefixLinesOp("# old\nbody", 3, 3, "heading", 2);
  assert.equal(apply("# old\nbody", one), "## old\nbody");
  assert.equal(one.selFrom, 3);

  const two = prefixLinesOp("# a\nb", 0, 5, "heading", 2);
  assert.equal(apply("# a\nb", two), "## a\n## b");
});

test("引用：不重复叠加，普通行加前缀", () => {
  const q = prefixLinesOp("> old", 0, 5, "quote");
  assert.equal(apply("> old", q), "> old");
  const n = prefixLinesOp("old", 0, 3, "quote");
  assert.equal(apply("old", n), "> old");
});

test("列表：同类追加、有序续号、沿用缩进", () => {
  const ul = listOp("- a\n", 3, 3, "ul");
  assert.equal(apply("- a\n", ul), "- a\n- \n", "原文件末尾换行保留");

  const ol = listOp("1. a\n", 4, 4, "ol");
  assert.equal(apply("1. a\n", ol), "1. a\n2. \n");

  const ind = listOp("  - a", 5, 5, "ul");
  assert.equal(apply("  - a", ind), "  - a\n  - ");
});

test("列表：普通行转换、空行插入、异类换标记", () => {
  const normal = listOp("hello", 2, 2, "ul");
  assert.equal(apply("hello", normal), "- hello");
  assert.equal(normal.selFrom, 2, "光标停在标记之后");

  const blank = listOp("", 0, 0, "task");
  assert.equal(apply("", blank), "- [ ] ");

  const conv = listOp("- a", 3, 3, "ol");
  assert.equal(apply("- a", conv), "1. a");
});

test("列表：选区逐行转换；有序递增", () => {
  const ul = listOp("a\nb", 0, 3, "ul");
  assert.equal(apply("a\nb", ul), "- a\n- b");
  const ol = listOp("a\nb", 0, 3, "ol");
  assert.equal(apply("a\nb", ol), "1. a\n2. b");
});

test("代码块：无选区光标进围栏内；有选区包裹并保持选中", () => {
  const empty = codeBlockOp("", 0, 0, "ts");
  assert.equal(apply("", empty), "```ts\n\n```");
  assert.equal(empty.selFrom, 6);

  const wrapped = codeBlockOp("x", 0, 1, "py");
  assert.equal(apply("x", wrapped), "```py\nx\n```");
  assert.deepEqual([wrapped.selFrom, wrapped.selTo], [6, 7]);
});

test("分隔线：独占一行，光标在行尾", () => {
  const op = hrOp("", 0, 0);
  assert.equal(apply("", op), "---");
  assert.equal(op.selFrom, 3);
});