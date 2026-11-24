/* 编码标签显示文案（与 folio-fs 的 decode_bytes 标签口径一致）。
 * 运行：node --experimental-strip-types --test tests/encoding.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encLabel } from "../src/lib/encoding.ts";

test("编码标签 → 显示名（镜像 Rust 标签集）", () => {
  assert.equal(encLabel("utf-8"), "UTF-8");
  assert.equal(encLabel("gbk"), "GBK");
  assert.equal(encLabel("gb18030"), "GB18030");
  assert.equal(encLabel("utf-16le"), "UTF-16 LE");
  assert.equal(encLabel("utf-16be"), "UTF-16 BE");
  assert.equal(encLabel(undefined), "UTF-8", "缺省按 utf-8");
  assert.equal(encLabel(""), "UTF-8", "空串按 utf-8");
});

test("未知标签大写兜底，绝不吞成空白", () => {
  assert.equal(encLabel("big5"), "BIG5");
});
