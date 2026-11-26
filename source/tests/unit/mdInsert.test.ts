/* mdInsert：编辑窗右键插入模板的纯函数断言（方案 N-CTX-01 §3/§4） */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calloutOp, codeBlockOp, emojiOp, hrOp, imageOp, insertBlock, linkOp, listOp, prefixLinesOp, tableOp, wrapOp, yamlOp,
  type EditOp,
} from "../../src/lib/mdInsert.ts";

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

/* ── YAML 头（2026-11-26 原型口径）──────────────────────────── */

test("YAML 头：插到文档最前，光标进 name 字段，与正文隔一个空行", () => {
  const src = "# 标题\n\n正文";
  const op = yamlOp(src);
  assert.ok(op);
  assert.equal(apply(src, op), "---\nname: \ndescription: \n---\n\n# 标题\n\n正文");
  assert.deepEqual([op.selFrom, op.selTo], [10, 10]);
});

test("YAML 头：空文档不加尾随空行；开头已有 front matter 则拒绝", () => {
  const empty = yamlOp("");
  assert.ok(empty);
  assert.equal(apply("", empty), "---\nname: \ndescription: \n---");
  assert.equal(yamlOp("---\ntitle: x\n---\n正文"), null);
  assert.equal(yamlOp("---\nname: \ndescription: \n---\n\n正文"), null);
});

/* ── 标注块（2026-11-19 原型口径）────────────────────────────── */

test("标注块：单光标整块插入，光标停末行引用标记后", () => {
  const op = calloutOp("", 0, 0, "NOTE");
  assert.equal(apply("", op), "> [!NOTE]\n> ");
  assert.deepEqual([op.selFrom, op.selTo], [12, 12]);
});

test("标注块：非空行后整块插入并按 §3.1 补空行", () => {
  const src = "hello\nworld";
  const op = calloutOp(src, 2, 2, "NOTE");
  assert.equal(apply(src, op), "hello\n\n> [!NOTE]\n> \n\nworld");
  assert.equal(op.selFrom, 19);   // 5(hello\n) + 2(\n\n) + 12("> [!NOTE]\n> ")
});

test("标注块：选区各行转引用并加类型行，选区盖住正文", () => {
  const src = "para one\npara two";
  const op = calloutOp(src, 0, 17, "TIP");
  assert.equal(apply(src, op), "> [!TIP]\n> para one\n> para two");
  assert.deepEqual([op.selFrom, op.selTo], [9, 30]);
});

test("标注块：已有引用前缀不重复叠加；缩进保留（同引用前缀口径）", () => {
  const src = "> quoted\n  item";
  const op = calloutOp(src, 0, 15, "WARNING");
  assert.equal(apply(src, op), "> [!WARNING]\n> quoted\n  > item");
});

/* ── Emoji 行内插入（2026-11-19 原型口径）────────────────────── */

test("Emoji：光标处插短代码，光标停文本之后", () => {
  const op = emojiOp("ab", 1, 1, ":smile:");
  assert.equal(apply("ab", op), "a:smile:b");
  assert.deepEqual([op.selFrom, op.selTo], [8, 8]);
});

test("Emoji：代理对按 UTF-16 码元计位（与 CM6 位置同系），选区被替换", () => {
  const src = "x😀y";           // 😀 占码元 1–2
  const op = emojiOp(src, 1, 3, "🎉");
  assert.equal(apply(src, op), "x🎉y");
  assert.deepEqual([op.selFrom, op.selTo], [3, 3]);
});
test("行内包裹：bold / italic / code / strike 四种符号与选区回位", () => {
  assert.deepEqual(wrapOp("abc", 0, 3, "bold"), { from: 0, to: 3, insert: "**abc**", selFrom: 2, selTo: 5 });
  assert.deepEqual(wrapOp("abc", 0, 3, "italic"), { from: 0, to: 3, insert: "*abc*", selFrom: 1, selTo: 4 });
  assert.deepEqual(wrapOp("abc", 0, 3, "code"), { from: 0, to: 3, insert: "`abc`", selFrom: 1, selTo: 4 });
  assert.deepEqual(wrapOp("abc", 0, 3, "strike"), { from: 0, to: 3, insert: "~~abc~~", selFrom: 2, selTo: 5 });
});

test("有序列表续号：同缩进上一条编号 +1；被非列表行截断则从 1", () => {
  assert.equal(listOp("1. one\n\n", 7, 7, "ol").insert, "2. ");
  assert.equal(listOp("para\n", 5, 5, "ol").insert, "1. ");
  assert.equal(listOp("1. one\ntext\n\n", 13, 13, "ol").insert, "1. ", "中间非列表行截断");
});
