/* 文档库目录树（schema v3）的纯函数断言。
 * 运行：node --experimental-strip-types --test tests/libtree.test.ts
 * 覆盖：库根→层级、最长根匹配、分隔符边界、大小写归一、排序与计数、展开状态（默认+手动）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { allDirKeys, buildLibTree, flattenAll, isDirOpen, leafName, revealKeys, rootOf } from "../src/lib/libtree.ts";
import type { DocMeta } from "../src/lib/types.ts";

function doc(path: string, mtime = 0, over: Partial<DocMeta> = {}): DocMeta {
  const fileName = path.split(/[\\/]/).pop() as string;
  const dir = path.slice(0, path.length - fileName.length).replace(/[\\/]+$/, "");
  const h = [...path].reduce((a, c) => ((a * 31 + c.charCodeAt(0)) | 0), 0);
  return {
    id: over.id ?? Math.abs(h) % 100000,
    path, slug: fileName, title: fileName, dir, fileName,
    size: 1, mtime, wordCount: 0, headCount: 0, secCount: 0,
    inLibrary: true, pinned: false, builtin: false,
    ...over,
  };
}

/** 扁平行序列 → "D 名@深" / "F 名@深" 的可读串，整棵树一眼比对 */
function render(rows: ReturnType<typeof flattenAll>): string[] {
  return rows.map((r) => r.kind === "dir"
    ? `D ${r.node.name}@${r.node.depth}`
    : `F ${r.doc.fileName}@${r.depth}`);
}

const NO_OVERRIDES = new Map<string, boolean>();

test("库根与子目录层级：文件挂在自己的目录上，默认只露一层", () => {
  const tops = buildLibTree(["D:/docs"], [
    doc("D:/docs/top.md"),
    doc("D:/docs/chap1/a.md"),
    doc("D:/docs/chap1/b.md"),
    doc("D:/docs/chap2/sub/c.md"),
  ]);
  assert.equal(tops.length, 1, "躺在库根下的文件不许掉进兜底桶");
  assert.equal(tops[0].name, "docs");
  assert.equal(tops[0].count, 4, "计数含子目录");
  // 默认只展开库根：第一层子目录与根下文件可见，它们的子孙收着
  assert.deepEqual(render(flattenAll(tops, NO_OVERRIDES)), [
    "D docs@0", "D chap1@1", "D chap2@1", "F top.md@1",
  ]);
  // 用户点开 chap1 才露出它的文件（chap2 仍收起）
  assert.deepEqual(render(flattenAll(tops, new Map([["d:/docs/chap1", true]]))), [
    "D docs@0", "D chap1@1", "F a.md@2", "F b.md@2", "D chap2@1", "F top.md@1",
  ]);
});

test("展开默认：只展开库根本身，深层目录可以手动打开", () => {
  const tops = buildLibTree(["D:/d"], [doc("D:/d/a/b/deep.md")]);
  const a = tops[0].dirs[0];
  const b = a.dirs[0];
  assert.equal(isDirOpen(tops[0], NO_OVERRIDES), true, "库根（depth 0）默认展开");
  assert.equal(isDirOpen(a, NO_OVERRIDES), false, "第一层子目录默认收起 → 新打开目录只见一层");
  assert.equal(isDirOpen(b, NO_OVERRIDES), false, "更深层同样收起");
  // 手动打开深层：必须能展开（曾经用"仅收起集合"建模，深层永远打不开）
  assert.deepEqual(render(flattenAll(tops, new Map([[a.key, true], [b.key, true]]))),
    ["D d@0", "D a@1", "D b@2", "F deep.md@3"]);
  // 当前文档所在的祖先链默认可见，不必先点展开
  const reveal = revealKeys("D:/d/a/b", ["D:/d"]);
  assert.deepEqual([...reveal].sort(), [a.key, b.key, tops[0].key].sort(), "祖先链含库根与两级目录");
  assert.equal(isDirOpen(b, NO_OVERRIDES, reveal), true, "reveal 里的目录默认算展开");
  assert.equal(isDirOpen(b, new Map([[b.key, false]]), reveal), false, "用户显式收起优先于 reveal");
  assert.deepEqual([...revealKeys(undefined, ["D:/d"])], [], "没打开文档时 reveal 为空");
  assert.deepEqual([...revealKeys("E:/elsewhere/x", ["D:/d"])], [], "文档不在任何库根下时为空");
});

test("allDirKeys 收全树键（供全部展开/全部收起整批写）", () => {
  const tops = buildLibTree(["D:/d"], [doc("D:/d/a/b/c/deep.md"), doc("D:/d/top.md")]);
  const keys = allDirKeys(tops);
  assert.equal(keys.length, 4, "d / a / b / c 四个目录");
  assert.ok(keys.includes("d:/d") && keys.includes("d:/d/a/b/c"), "含库根与最深一级");
  assert.deepEqual(allDirKeys([]), [], "空树返回空");
});

test("最长匹配：嵌套库根时以最具体的根为准", () => {
  const roots = ["D:/docs", "D:/docs/deep"];
  assert.equal(rootOf("D:/docs/deep/x", roots)?.key, "d:/docs/deep");
  assert.equal(rootOf("D:/docs/other", roots)?.key, "d:/docs");
  assert.equal(rootOf("D:/docs", roots)?.key, "d:/docs", "入参是目录：等于库根算命中");
  assert.equal(rootOf("D:", roots), null);
});

test("分隔符边界：docs2 不许被 docs 命中；无根可挂的落进兜底桶", () => {
  const tops = buildLibTree(["D:/docs"], [doc("D:/docs2/a.md")]);
  assert.equal(tops.length, 1);
  assert.equal(tops[0].name, "其他库条目");
  assert.equal(tops[0].files.length, 1);
});

test("Windows 反斜杠与大小写：能挂上，且显示名保留原始大小写", () => {
  const tops = buildLibTree(["D:\\Docs"], [doc("D:\\docs\\ChapOne\\a.md")]);
  assert.equal(tops[0].name, "Docs");
  assert.equal(tops[0].dirs[0].name, "ChapOne", "目录名从原始串切，不被小写化");
  assert.equal(tops[0].dirs[0].files[0].fileName, "a.md");
});

test("排序：目录与文件都是名称自然序升序（数字按数值，2 在 10 前；文件不再按 mtime）", () => {
  const tops = buildLibTree(["D:/d"], [
    // mtime 故意与文件名序相反：x10 最新、a 最早——排序必须只看名字
    doc("D:/d/x10.md", 30), doc("D:/d/x2.md", 10), doc("D:/d/a.md", 1), doc("D:/d/b.md", 5),
    doc("D:/d/ch10/a.md"), doc("D:/d/ch2/a.md"),
  ]);
  assert.deepEqual(tops[0].dirs.map((x) => x.name), ["ch2", "ch10"]);
  assert.deepEqual(tops[0].files.map((x) => x.fileName), ["a.md", "b.md", "x2.md", "x10.md"]);
});

test("多个库根 = 多个顶层节点，各自成树", () => {
  const tops = buildLibTree(["D:/books", "E:/notes"], [
    doc("D:/books/a.md"), doc("E:/notes/b.md"),
  ]);
  assert.deepEqual(tops.map((t) => t.name), ["books", "notes"]);
  assert.deepEqual(tops.map((t) => t.count), [1, 1]);
});

test("两个库末段同名时，顶层标签带上级目录区分（都是 docs 的那种常见撞名）", () => {
  const tops = buildLibTree(["D:/work/Folio/docs", "D:/work/CC-DOCS-MD/docs"], [
    doc("D:/work/Folio/docs/a.md"), doc("D:/work/CC-DOCS-MD/docs/b.md"),
  ]);
  assert.deepEqual(tops.map((t) => t.name), ["CC-DOCS-MD / docs", "Folio / docs"], "排序后仍各自可辨");
  // 不撞名时保持简洁，不硬塞上级目录
  const single = buildLibTree(["D:/work/Folio/docs"], [doc("D:/work/Folio/docs/a.md")]);
  assert.deepEqual(single.map((t) => t.name), ["docs"]);
});

test("leafName：末段目录名", () => {
  assert.equal(leafName("D:/a/b/c/"), "c");
  assert.equal(leafName("D:\\x\\y"), "y");
});
