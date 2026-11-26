/* mdStructural：编辑区结构装饰的纯逻辑断言（YAML front matter 行范围，2026-11-26） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Text } from "@codemirror/state";
import { frontMatterLastLine } from "../../src/lib/mdStructural.ts";

const doc = (...lines: string[]) => Text.of(lines);

test("front matter：首行 --- 且 body 像 YAML，返回收口行号", () => {
  assert.equal(frontMatterLastLine(doc("---", "name: ", "description: ", "---", "", "正文")), 4);
  assert.equal(frontMatterLastLine(doc("---", "title: x", "...", "正文")), 3);
});

test("front matter：不成立时返回 0（交给 CommonMark 原本的 hr / Setext 口径）", () => {
  assert.equal(frontMatterLastLine(doc("正文", "---", "---")), 0);          // 不在首行
  assert.equal(frontMatterLastLine(doc("---", "普通段落", "---", "正文")), 0); // body 不像 YAML
  assert.equal(frontMatterLastLine(doc("---", "---", "正文")), 0);           // 空 body
  assert.equal(frontMatterLastLine(doc("---", "name: x")), 0);              // 未收口
  assert.equal(frontMatterLastLine(doc("")), 0);
});