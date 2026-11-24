/* 残留中文扫描（多语言设计 §7.1.2）：AST 扫描 source/src 下所有 ts / tsx 文件的字符串字面量、
 * JSX 文本与模板字符串；注释天然被排除。命中即退出码 1。
 * 白名单：源语言目录 catalog/zh-CN.ts、技术名词/语言名（简体中文、English）、测试夹具。
 * 运行：npm run check:i18n
 * 注：本文件首行注释禁止出现星号加斜杠的闭注释序列（曾因 glob 写法把注释提前截断）。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");
// 汉字：扩展 A + 基本区 + 兼容区；用显式码点，避免字面量被替换成相近字符后区间漂移
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/** 允许出现中文的路径（源语言目录）与文本（语言名/技术名词/测试断言） */
const FILE_ALLOW = [/[/\\]lib[/\\]i18n[/\\]catalog[/\\]zh-CN\.ts$/, /\.test\.tsx?$/];
const TEXT_ALLOW = [/^简体中文$/, /^English$/, /^正在打开文档…$/, /^开发版$|^正式版$/];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".bak")) {
      out.push(p);
    }
  }
  return out;
}

const hits = [];
for (const file of walk(SRC)) {
  if (FILE_ALLOW.some((re) => re.test(file))) continue;
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    let value = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) value = node.text;
    else if (ts.isJsxText(node)) value = node.text;
    if (value && CJK.test(value) && !TEXT_ALLOW.some((re) => re.test(value.trim()))) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ file: path.relative(root, file), line: line + 1, value: value.trim().slice(0, 80) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (hits.length) {
  console.error(`残留中文 ${hits.length} 处：`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.value}`);
  process.exit(1);
}
console.log("check-i18n: 未发现残留中文（白名单除外）");