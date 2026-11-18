/* textedit：源码格式化整篇替换的最小编辑区间（评审 P3-4 的纯函数覆盖） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commonEditRange } from "../src/lib/textedit.ts";

test("相同文本不产生编辑", () => {
  assert.equal(commonEditRange("abc", "abc"), null);
});

test("补标题空格只改中段（前缀/后缀保留，光标不漂）", () => {
  assert.deepEqual(commonEditRange("##标题", "## 标题"), { from: 2, to: 2, insert: " " });
});

test("压缩空行是删除编辑", () => {
  assert.deepEqual(commonEditRange("a\n\n\nb", "a\n\nb"), { from: 3, to: 4, insert: "" });
});

test("纯插入", () => {
  assert.deepEqual(commonEditRange("ab", "axb"), { from: 1, to: 1, insert: "x" });
});

test("代理对被切开时退回整篇替换", () => {
  const cur = "a😀b";
  const next = "a😁b";
  assert.deepEqual(commonEditRange(cur, next), { from: 0, to: cur.length, insert: next });
});

test("代理对之外的变化仍按最小中段", () => {
  const r = commonEditRange("😀 ##标题", "😀 ## 标题");
  assert.deepEqual(r, { from: 5, to: 5, insert: " " });
});