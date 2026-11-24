/* 启动恢复判定回归（bug 2026-11-22：WebView 刷新=整页重载被当冷启动，
 * 「恢复上次文档=关」的用户刷新后落空态、当前文档"消失"）。
 * 组件级无法在 node 测试里伪造导航类型，故判定抽成纯函数按码表逐条钉桩；
 * 泄漏闸（contextmenu / Ctrl+R / F5）与真机 reload 恢复走 CDP 真窗口复检清单。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRestoreOnBoot } from "../src/lib/boot.ts";

test("冷启动：尊重开关（关=空态快启，需求方 2026-11-18 口径不变）", () => {
  assert.equal(shouldRestoreOnBoot(true, "navigate"), true);
  assert.equal(shouldRestoreOnBoot(undefined, "navigate"), true, "缺省=恢复开");
  assert.equal(shouldRestoreOnBoot(false, "navigate"), false);
});

test("会话内重启（reload）：无视开关必须回到当前文档", () => {
  assert.equal(shouldRestoreOnBoot(false, "reload"), true, "bug 复现场景");
  assert.equal(shouldRestoreOnBoot(true, "reload"), true);
  assert.equal(shouldRestoreOnBoot(undefined, "reload"), true);
});

test("豁免面不扩大：导航类型缺失/其它值一律按冷启动", () => {
  assert.equal(shouldRestoreOnBoot(false, undefined), false, "取不到导航类型（mock/旧内核）");
  assert.equal(shouldRestoreOnBoot(false, "back_forward"), false);
  assert.equal(shouldRestoreOnBoot(false, "prerender"), false);
});
