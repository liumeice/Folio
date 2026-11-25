/* GFM emoji 短代码的纯文本叶子契约：替换、别名、未知保留、大小写边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/* 命名口径（2026-11-25）：键名必须是 GitHub gemoji / Slack / Discord 认得的短代码；
 * 初版手写的自造名（cherry、fox、panda、puzzle、piano、megaphone 等）会让 Folio 能渲染、
 * Typora/GitHub 却是原文，已全部换成平台标准名。 */
test("短代码命名：平台标准名在场，自造名不回流", () => {
  for (const k of ["mega", "cherries", "fox_face", "panda_face", "jigsaw", "musical_keyboard"])
    assert.ok(EMOJI[k], `缺少平台标准短代码 ${k}`);
  for (const k of ["megaphone", "cherry", "puzzle", "piano", "subway", "target", "gear2", "chess_king", "prohibited", "bulb2", "rocket2", "wrench2", "keyboard_question", "star_circle"])
    assert.equal(EMOJI[k], undefined, `自造短代码 ${k} 不应存在`);
});

/* 编辑窗右键菜单是短代码的"生产端"：菜单能插入的每个 code/alt 都必须在 EMOJI 表里，
 * 且映射值与菜单展示的字符一致（2026-11-25 修复：菜单 57 项里 15 项缺席，阅读窗原样显示）。 */
test("EMOJI 表覆盖编辑窗 Emoji 面板全部 code 与 alt，且字符一致", () => {
  const src = readFileSync(new URL("../../src/components/Overlays.tsx", import.meta.url), "utf8");
  const items = [...src.matchAll(/\{ char: "([^"]+)", code: "(:[^"]+:)"(?:, alt: "(:[^"]+:)")?/g)];
  assert.ok(items.length >= 50, `面板条目数异常：${items.length}`);
  for (const [, char, code, alt] of items) {
    assert.equal(EMOJI[code.slice(1, -1)], char, `菜单短代码 ${code} 缺失或与展示字符不一致`);
    if (alt) assert.equal(EMOJI[alt.slice(1, -1)], char, `菜单别名 ${alt} 缺失或与 ${code} 不一致`);
  }
});