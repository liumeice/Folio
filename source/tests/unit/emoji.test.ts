/* GFM emoji 短代码的纯文本叶子契约：替换、别名、未知保留、大小写边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMOJI, applyEmojis } from "../../src/lib/emoji.ts";

test("EMOJI 表：键为无冒号短代码，值非空", () => {
  const keys = Object.keys(EMOJI);
  assert.ok(keys.length >= 200, `常用集不得缩水：${keys.length}`);
  for (const k of keys) {
    assert.match(k, /^[a-z0-9_+-]+$/, `非法短代码键：${k}`);
    assert.ok(EMOJI[k].length > 0, `空映射：${k}`);
  }
});

test("applyEmojis：点名符号、别名与连续短代码", () => {
  assert.equal(applyEmojis(":rocket:"), "🚀");
  assert.equal(applyEmojis(":tada::fire:"), "🎉🔥");
  assert.equal(applyEmojis(":+1: / :thumbsup:"), "👍 / 👍");
  assert.equal(applyEmojis(":e-mail:"), "📧");
});

test("applyEmojis：未知短代码原样保留", () => {
  assert.equal(applyEmojis(":not_a_real_emoji:"), ":not_a_real_emoji:");
  assert.equal(applyEmojis("版本 :1.2.3:"), "版本 :1.2.3:");
});

test("applyEmojis：大小写敏感（与目录键一致）", () => {
  assert.equal(applyEmojis(":ROCKET:"), ":ROCKET:");
});

test("applyEmojis：已转义文本中的短代码仍可替换", () => {
  assert.equal(applyEmojis("&lt;:rocket:&gt;"), "&lt;🚀&gt;");
});