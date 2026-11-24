// FR-13.2 导出 PDF 文件名净化（纯函数）。跑法：node --experimental-strip-types --test tests/unit/pdfname.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfExportName } from "../../src/lib/pdfname.ts";

test("常规文档名：换后缀为 .pdf", () => {
  assert.equal(pdfExportName("readme.md"), "readme.pdf");
  assert.equal(pdfExportName("Folio 使用指南.markdown"), "Folio 使用指南.pdf");
  assert.equal(pdfExportName("notes.txt"), "notes.pdf");
});

test("无后缀 / 未知后缀：直接追加 .pdf", () => {
  assert.equal(pdfExportName("笔记"), "笔记.pdf");
  assert.equal(pdfExportName("data.md.bak"), "data.md.bak.pdf");
});

test("Windows 非法字符替换为「·」", () => {
  assert.equal(pdfExportName('a<b>c:d"e|f?g*h/i\\j.md'), "a·b·c·d·e·f·g·h·i·j.pdf");
});

test("控制字符剔除", () => {
  assert.equal(pdfExportName("ab\x01\x02cd.md"), "abcd.pdf");
});

test("结尾的点与空格会被 Windows 静默剥离 → 提前去掉", () => {
  assert.equal(pdfExportName("test...md"), "test.pdf");   // .md 被剥后剩 "test..."
  assert.equal(pdfExportName("trail  .md"), "trail.pdf");
});

test("全部非法 → 兜底未命名文档", () => {
  assert.equal(pdfExportName(":::.md"), "未命名文档.pdf");
});

test("DOS 保留名加下划线前缀（大小写通吃）", () => {
  assert.equal(pdfExportName("CON.md"), "_CON.pdf");
  assert.equal(pdfExportName("nul.txt"), "_nul.pdf");
  assert.equal(pdfExportName("COM1.md"), "_COM1.pdf");
  assert.equal(pdfExportName("console.md"), "console.pdf"); // 前缀相似但不是保留名，不动
});
