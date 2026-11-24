/* 阅读区代码块着色断言（jsdom 直跑，无 CDP 环境依赖）：
 * 已注册语言出 token、别名归一化、未知语言保持素文本、幂等。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><body><div id="t"></div>`);
// @ts-expect-error browser globals for lib
globalThis.document = dom.window.document;
// @ts-expect-error browser globals for lib
globalThis.HTMLElement = dom.window.HTMLElement;

const { mdToHtml } = await import("../src/lib/md.ts");
const { highlightCodeBlocks } = await import("../src/lib/codehl.ts");

const src = [
  "```rust",
  "fn main() { let x = 1; // 注释",
  '  println!("hi"); }',
  "```",
  "",
  "```py",
  "# python 注释",
  "print('hi')",
  "```",
  "",
  "```SQL",
  "SELECT name FROM t WHERE x > 1;",
  "```",
  "",
  "```fortran",
  "未知语言保持素文本",
  "```",
].join("\n");

const host = dom.window.document.getElementById("t")!;
host.innerHTML = mdToHtml(src);

test("rust 关键字/注释/字符串出 token", async () => {
  await highlightCodeBlocks(host as any);
  const rust = host.querySelector("code.language-rust")!;
  assert.ok(rust.querySelector(".hljs-keyword"), "fn/let 应为关键字");
  assert.ok(rust.querySelector(".hljs-comment"), "// 注释应着色");
  assert.ok(rust.querySelector(".hljs-string"), "\"hi\" 应着色");
});

test("别名归一化：py / 大写 SQL 均命中注册语言", async () => {
  const py = host.querySelector("code.language-py")!;
  assert.ok(py.querySelector(".hljs-comment"), "# 注释");
  const sql = host.querySelector("code.language-sql")!;
  assert.ok(sql.querySelector(".hljs-keyword"), "SELECT 关键字（大写围栏标签）");
});

test("未知语言保持素文本，不乱猜", async () => {
  const f = host.querySelector("code.language-fortran")!;
  assert.equal(f.querySelectorAll("[class^='hljs-']").length, 0);
  assert.ok(f.textContent!.includes("未知语言保持素文本"));
});

test("幂等：二次调用不重复处理", async () => {
  const before = host.querySelector("code.language-rust")!.innerHTML;
  await highlightCodeBlocks(host as any);
  assert.equal(host.querySelector("code.language-rust")!.innerHTML, before);
});
