/* 文档主语言判定单测（多语言设计 §4.6.6）：中文 / 英文 / 中英混排 / 纯代码 / 空文档。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectContentLang, stripNonProse } from "../../src/lib/i18n/detect.ts";

test("中文文档 → zh-CN", () => {
  assert.equal(detectContentLang("# 欢迎\n\n这是一篇中文文档，用来测试语言判定逻辑是否工作。"), "zh-CN");
});

test("英文文档 → en-US", () => {
  assert.equal(detectContentLang("# Welcome\n\nThis is an English document used to test the language detection logic."), "en-US");
});

test("中英混排：中文为主 → zh-CN；英文为主 → en-US", () => {
  assert.equal(detectContentLang("这是中文为主的一段话，其中夹杂 English 单词与术语 FTS5。"), "zh-CN");
  assert.equal(detectContentLang("This English paragraph contains a few 中文 words like 文档 and 设置."), "en-US");
});

test("代码/公式/URL 被剔除：纯代码文档 → null", () => {
  const src = "# demo\n\n```rust\nfn main() { println!(\"hello\"); }\n```\n\n$$ E = mc^2 $$\n\nhttps://example.com/a/b\n";
  assert.equal(detectContentLang(src), null);
  assert.ok(stripNonProse(src).includes("# demo"));   // 标题文字保留（标题属于正文语言）
});

test("空文档/纯符号 → null（调用方不加 lang）", () => {
  assert.equal(detectContentLang(""), null);
  assert.equal(detectContentLang("123 456 789 !!! ---"), null);
});