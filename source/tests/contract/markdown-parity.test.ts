/* 跨语言 Markdown 契约（TS 侧）。
 * 与 Rust `crates/folio-core/tests/markdown_contract.rs` 读同一份
 * `tests/fixtures/markdown-contract.json`：标题坐标、字数、任务翻转必须逐字段一致。
 * 改规则时先改夹具并双跑，不得只改一侧期望值。 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { headingsOfSrc, flipTaskInSrc } from "../../src/lib/md.ts";
import { countWords } from "../../src/lib/wordcount.ts";

interface HeadingCase { sec: number; level: number; text: string; line: number }
interface TaskCase { nth: number; expected: string }
interface Case {
  id: string;
  description: string;
  src: string;
  wordCount: number;
  headCount: number;
  secCount: number;
  headings: HeadingCase[];
  tasks: TaskCase[];
}
interface Suite { version: number; cases: Case[] }

const suite = JSON.parse(
  readFileSync(new URL("../fixtures/markdown-contract.json", import.meta.url), "utf8"),
) as Suite;

describe("Markdown 跨语言契约（共享夹具）", () => {
  test("夹具 schema 版本与数量", () => {
    assert.equal(suite.version, 1);
    assert.ok(suite.cases.length >= 10, "契约样例不得退化成个位数");
    assert.equal(new Set(suite.cases.map((c) => c.id)).size, suite.cases.length, "ID 唯一");
  });

  for (const c of suite.cases) {
    test(`${c.id} ${c.description}`, () => {
      const hs = headingsOfSrc(c.src).map((h) => ({ sec: h.sec, level: h.level, text: h.text, line: h.line }));
      assert.deepEqual(hs, c.headings, "标题坐标（sec/level/text/line）");
      assert.equal(hs.length, c.headCount, "headCount");
      assert.equal(hs.filter((h) => h.level >= 2).length, c.secCount, "secCount");
      assert.equal(countWords(c.src), c.wordCount, "wordCount");
      for (const t of c.tasks) {
        assert.equal(flipTaskInSrc(c.src, t.nth), t.expected, `task #${t.nth}`);
      }
      assert.equal(flipTaskInSrc(c.src, c.tasks.length), null, "任务序号越界返回 null");
    });
  }
});