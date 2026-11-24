/* 首启默认设置跨语言契约（TS 侧）。
 * 夹具 `tests/fixtures/settings-default.json` 同时被 Rust `settings_contract.rs` 校验：
 * 新增字段必须同时出现在两侧实现与夹具里。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS } from "../../src/lib/defaults.ts";

const golden = JSON.parse(
  readFileSync(new URL("../fixtures/settings-default.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

test("DEFAULT_SETTINGS 与共享夹具逐字段一致", () => {
  assert.deepEqual(DEFAULT_SETTINGS, golden);
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), Object.keys(golden).sort());
});