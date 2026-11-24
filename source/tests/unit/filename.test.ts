/* 文件名校验镜像测试（《Folio-目录树文件重命名方案》§3.1）：
 * 向量与 src-tauri/src/commands.rs::validate_file_name 的 #[test] 逐条对应——
 * 改一侧规则必须另一侧同步（同 md.test.ts 翻转镜像的纪律）。
 * P4a：返回值改为稳定 reason 码（FileReason），文案在 i18n 目录 filename.error.*。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseNameLen, leafNameOf, swapPathPrefix, validateDirName, validateFileName } from "../../src/lib/filename.ts";

test("目录名校验：同规但无扩展名限制（镜像 Rust validate_dir_name_vectors）", () => {
  assert.equal(validateDirName(" 备份 2024 "), null);
  assert.equal(validateDirName("笔记.2024"), null);          // 中段句点合法
  assert.equal(validateDirName("   "), "EMPTY");
  assert.equal(validateDirName("a:b"), "ILLEGAL_CHARS");
  assert.equal(validateDirName("尾点."), "BAD_END");
  assert.equal(validateDirName("目".repeat(256)), "TOO_LONG");
  assert.equal(validateDirName("noext"), null);              // 目录不查扩展名
});

test("路径前缀搬运：大小写不敏感、带边界、等于旧目录整体换", () => {
  assert.equal(swapPathPrefix("D:\\notes\\a.md", "D:\\notes", "D:\\新笔记"), "D:\\新笔记\\a.md");
  assert.equal(swapPathPrefix("d:\\NOTES\\子\\b.md", "D:\\notes", "D:\\新笔记"), "D:\\新笔记\\子\\b.md");
  assert.equal(swapPathPrefix("D:\\notes", "D:\\notes", "D:\\新笔记"), "D:\\新笔记");   // 根自身
  assert.equal(swapPathPrefix("D:\\notes2\\a.md", "D:\\notes", "D:\\新笔记"), null);      // 边界不许误伤
  assert.equal(leafNameOf("D:\\notes\\"), "notes");
  assert.equal(leafNameOf("notes"), "notes");
});

test("合法名与 trim（镜像 Rust validate_file_name_vectors）", () => {
  assert.equal(validateFileName(" 报告.md "), null);
  assert.equal(validateFileName("名 字.md"), null);        // 中间空格合法
  assert.equal(validateFileName("a.MD"), null);            // 扩展名大小写不敏感
  assert.equal(validateFileName("a.markdown"), null);
  assert.equal(validateFileName("a.txt"), null);
});

test("非法名逐码拦截（reason 码与 Rust Invalid(码) 一致）", () => {
  assert.equal(validateFileName("   "), "EMPTY");
  assert.equal(validateFileName("a/b.md"), "ILLEGAL_CHARS");
  assert.equal(validateFileName("a:b.md"), "ILLEGAL_CHARS");
  assert.equal(validateFileName("bad?.md"), "ILLEGAL_CHARS");
  assert.equal(validateFileName("a\\b.md"), "ILLEGAL_CHARS");
  assert.equal(validateFileName('a"b.md'), "ILLEGAL_CHARS");
  assert.equal(validateFileName("a<b.md"), "ILLEGAL_CHARS");
  assert.equal(validateFileName("a>b.md"), "ILLEGAL_CHARS");
  assert.equal(validateFileName("a|b.md"), "ILLEGAL_CHARS");
  assert.equal(validateFileName("a\nb.md"), "ILLEGAL_CHARS");   // 控制字符
  assert.equal(validateFileName("尾点."), "BAD_END");
  assert.equal(validateFileName("名字. "), "BAD_END"); // 尾随空格先 trim，剩句点仍非法
  assert.equal(validateFileName("noext"), "BAD_EXT");
  assert.equal(validateFileName("photo.PNG"), "BAD_EXT");
});

test("长度上限 255（与 Rust chars().count() 同口径按码点计）", () => {
  assert.equal(validateFileName("名".repeat(252) + ".md"), null);
  assert.equal(validateFileName("名".repeat(253) + ".md"), "TOO_LONG");
  // UTF-16 陷阱：emoji 按 1 个码点计，与 Rust chars() 对齐
  const emo = "😀".repeat(251) + ".md";
  assert.equal(validateFileName(emo), null, "251 个 emoji + .md = 254 码点，合法");
});

test("校验顺序：先非法字符后扩展名（同 Rust 短路序）", () => {
  assert.equal(validateFileName("a/b"), "ILLEGAL_CHARS");   // 两错叠加报前者
  assert.equal(validateFileName("尾点."), "BAD_END");          // 两错叠加：先结尾检查再扩展名
});

test("默认选区=主文件名（不含扩展名）", () => {
  assert.equal(baseNameLen("报告.md"), 2);
  assert.equal(baseNameLen("a.b.md"), 3);          // 只认最后一个点
  assert.equal(baseNameLen(".md"), 3);             // 无主名段 → 全选
  assert.equal(baseNameLen("笔记.markdown"), 2);
});
