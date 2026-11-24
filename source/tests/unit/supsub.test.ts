/* Pandoc 上下标扩展（2026-11-24 需求）：^…^ → <sup>、~…~ → <sub>；
 * 双标记 ~~ 仍是删除线，代码内不生效，含空白不成立。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToHtml } from "../../src/lib/md.ts";

test("上标：E=mc^2^ → <sup>2</sup>", () => {
  const h = mdToHtml("E=mc^2^");
  assert.ok(h.includes("<sup>2</sup>"), h);
  assert.ok(!h.includes("^2^"), "不应残留字面量");
});

test("下标：H~2~O → H<sub>2</sub>O", () => {
  const h = mdToHtml("水的化学式为 H~2~O。");
  assert.ok(h.includes("H<sub>2</sub>O"), h);
  assert.ok(!h.includes("~2~"), "不应残留字面量");
});

test("删除线不受影响：~~del~~ 仍是 <del>", () => {
  const h = mdToHtml("~~del~~ and ~~two~~");
  assert.ok(h.includes("<del>del</del>"), h);
  assert.ok(!h.includes("<sub>"), h);
});

test("空白/未闭合/代码内不生效", () => {
  assert.ok(mdToHtml("a ^ b").includes("a ^ b"));
  assert.ok(mdToHtml("x~y").includes("x~y"));
  const code = mdToHtml("`H~2~O`");
  assert.ok(code.includes("<code>H~2~O</code>"), code);
});

test("高亮：==文字== → <mark>", () => {
  const h = mdToHtml("这是 ==非常重要的文字== 结尾");
  assert.ok(h.includes("<mark>非常重要的文字</mark>"), h);
  assert.ok(!h.includes("=="), "不应残留字面量");
});

test("高亮边界：比较写法/代码内不生效", () => {
  assert.ok(mdToHtml("a == b").includes("a == b"));
  const code = mdToHtml("`==x==`");
  assert.ok(code.includes("<code>==x==</code>"), code);
});