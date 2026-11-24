/* Markdown 解析的边缘分支（从 md.test.ts 的大回归面中独立出来）：
 * 列表项内缩进代码、实体 alt、跨行引用定义、列表打断段落规则、脚注续行、
 * 表格内未闭合反引号、任务序号 DOM 查询。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../helpers/dom.ts";

const dom = installDom();
const { mdToHtml, taskOrdinalOf } = await import("../../src/lib/md.ts");

test("列表项内再深 4 列的段落 → 项内缩进代码块", () => {
  const h = mdToHtml("- item\n\n      code line\n");
  assert.ok(h.includes('<div class="codeblock"'), h);
  assert.ok(h.includes("code line"), h);
  assert.ok(h.includes("data-line-start=\"2\""), "代码块锚到源行号");
});

test("图片 alt 的实体只透传不二次转义", () => {
  const h = mdToHtml("![AT&amp;T](/u)\n");
  assert.ok(h.includes('alt="AT&amp;T"'), h);
  assert.ok(!h.includes("&amp;amp;"), "不得二次转义：" + h);
});

test("参考式链接定义可跨行（目标在下一行）", () => {
  const h = mdToHtml('[ref]:\n  https://example.com "t"\n\nsee [ref]\n');
  assert.ok(h.includes('href="https://example.com"'), h);
  assert.ok(h.includes('title="t"'), h);
  assert.ok(!h.includes("[ref]:"), "定义行被消费");
});

test("有序列表从 3 开始不能打断段落（CommonMark 5.2）", () => {
  const h = mdToHtml("para\n3. item\n");
  assert.ok(!h.includes("<ol"), h);
  assert.ok(h.includes("3. item"), "原文保留为段落文本：" + h);
});

test("脚注定义的 ≥2 列缩进续行并入脚注正文", () => {
  const h = mdToHtml("text[^1]\n\n[^1]: first\n    second\n");
  assert.ok(h.includes("first"), h);
  assert.ok(h.includes("second"), h);
  assert.ok(h.includes('class="footnotes"'), h);
});

test("表格单元格里的未闭合反引号按字面保留，不误开 code span", () => {
  const h = mdToHtml("| a | b |\n| - | - |\n| `x | y |\n");
  assert.ok(h.includes("<td>`x</td>"), h);
  assert.ok(!h.includes("<code>"), h);
});

test("taskOrdinalOf：按 [data-task] 文档序返回 0 起序号", () => {
  const doc = dom.window.document;
  const art = doc.createElement("article");
  art.innerHTML = '<span data-task="1"></span><li data-task="2">a</li><li data-task="3">b</li>';
  const lis = art.querySelectorAll("li");
  assert.equal(taskOrdinalOf(art, lis[0]), 1, "隐藏占位计入序号");
  assert.equal(taskOrdinalOf(art, lis[1]), 2);
});