/* 跨语言文件名校验契约（TS 侧）。
 * 与 Rust `src-tauri/tests/filename_contract.rs` 共享同一份夹具：
 * 原因码与短路顺序必须一致；OK 时还要校验 trim 后的落盘名。 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateDirName, validateFileName, type FileReason } from "../../src/lib/filename.ts";

interface NameCase { id: string; input: string; expected: FileReason | "OK"; normalized?: string }
interface Suite { version: number; fileCases: NameCase[]; dirCases: NameCase[] }

const suite = JSON.parse(
  readFileSync(new URL("../fixtures/filename-contract.json", import.meta.url), "utf8"),
) as Suite;

describe("文件名跨语言契约（共享夹具）", () => {
  test("夹具 schema 版本与 ID 唯一", () => {
    assert.equal(suite.version, 1);
    const ids = [...suite.fileCases, ...suite.dirCases].map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  for (const c of suite.fileCases) {
    test(`${c.id} 文件：${JSON.stringify(c.input)} → ${c.expected}`, () => {
      assert.equal(validateFileName(c.input), c.expected === "OK" ? null : c.expected);
      if (c.expected === "OK") assert.equal(c.input.trim(), c.normalized, "OK 名以 trim 后形态落盘");
    });
  }

  for (const c of suite.dirCases) {
    test(`${c.id} 目录：${JSON.stringify(c.input)} → ${c.expected}`, () => {
      assert.equal(validateDirName(c.input), c.expected === "OK" ? null : c.expected);
      if (c.expected === "OK") assert.equal(c.input.trim(), c.normalized);
    });
  }
});