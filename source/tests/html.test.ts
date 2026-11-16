/* 内嵌原始 HTML（需求 #3）：功能面（README 徽章块生效）+ 安全面（白名单净化逐条钉死）。
 * 运行：node --experimental-strip-types --test tests/html.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const js = new JSDOM("");
(globalThis as unknown as { DOMParser: unknown }).DOMParser = js.window.DOMParser;

const { mdToHtml } = await import("../src/lib/md.ts");

test("README 式徽章块原样生效：p/img/a/align 保留，块在空行处结束", () => {
  const h = mdToHtml('<p align="center">\n  <a href="https://getbootstrap.com/">\n    <img src="logo.svg" alt="B" width="200">\n  </a>\n</p>\n\n## 下一节');
  assert.ok(h.includes('<p align="center"'), "p 块未被转义：" + h);
  assert.ok(h.includes('<img src="logo.svg"') && h.includes('width="200"'), "img 属性齐全");
  assert.ok(h.includes('<a href="https://getbootstrap.com/"'), "链接保留");
  assert.ok(h.includes('data-sec="1"') && h.includes("下一节"), "空行后回到 markdown 解析");
  assert.ok(!h.includes("&lt;p"), "不再以字面文本显示 HTML");
});

test("安全：script/style/iframe/object 整枝删除（内容也消失）", () => {
  const h = mdToHtml("<script>alert(1)</script>\n\n<style>body{background:url(evil)}</style>\n\n<iframe src=\"https://evil/x\"></iframe><object data=\"y\"></object>");
  assert.ok(!h.includes("<script"), "script 标签消失");
  assert.ok(!h.includes("alert(1)"), "脚本内容也被带走");
  assert.ok(!h.includes("<style") && !h.includes("background:url"), "style 消失");
  assert.ok(!h.includes("<iframe") && !h.includes("<object"), "外联容器消失");
});

test("安全：on* 事件属性与 javascript: / 混淆 URL 一律剥掉", () => {
  const h = mdToHtml('<img src=x onerror=alert(1)>\n\n<a href="java\nscript:alert(2)">t</a>\n\n<a href="JaVaScRiPt:alert(3)">u</a>');
  assert.ok(!/onerror/i.test(h), "onerror 被剥：" + h);
  assert.ok(!/javascript/i.test(h.replace("&lt;", "")), "javascript: href 被剥（换行混淆也拦）：" + h);
  assert.ok(h.includes("<img") && h.includes("<a"), "标签本体保留、只杀危险属性");
});

test("安全：form/input/base/link/meta 禁用；未知标签拆壳保文字", () => {
  const h = mdToHtml("<form action=\"https://evil/c\"><input name=x></form>\n\n<base href=\"https://evil/\">\n\n<font color=red>保留我</font>");
  assert.ok(!h.includes("<form") && !h.includes("<input") && !h.includes("<base"), "表单/劫持面消失：" + h);
  assert.ok(h.includes("保留我") && !h.includes("<font"), "未知标签拆壳保内容");
});

test("无害标签保结构：details/summary/table/align 等", () => {
  const h = mdToHtml("<details><summary>展开</summary>内容</details>\n\n<table align=\"center\"><tr><td colspan=\"2\">格</td></tr></table>");
  assert.ok(h.includes("<details>") && h.includes("<summary>展开</summary>"), h);
  assert.ok(h.includes('colspan="2"') && h.includes('align="center"'), "常用属性在名单内");
});

test("坐标不变量：HTML 块内的 \"# \" 行仍占 data-sec（Rust 不认 html 围栏，C 必须=3）", () => {
  const h = mdToHtml("# A\n\n<div>\n# 潜伏标题\n</div>\n\n# C");
  assert.ok(h.includes('data-sec="1"'), "A=1");
  assert.ok(!h.includes('data-sec="2"'), "潜伏标题不产锚点元素");
  assert.ok(h.includes('data-sec="3"'), "C=3 与 Rust outline 对位：" + h);
  assert.ok(h.includes("# 潜伏标题"), "块内文本原样在净化输出里");
});

test("已知边界：段落中部的行内 HTML 仍按字面显示（仅块级起头才走内嵌）", () => {
  const h = mdToHtml("文本 <b>粗</b> 尾");
  assert.ok(h.includes("&lt;b&gt;"), "非块起头不内嵌（与 GitHub 差异已在报告披露）：" + h);
});

test("连续图片横向排列（需求补充）：纯图片段= imgrow；混文本段/单图不受牵连", () => {
  const row = mdToHtml('![a](x1.png)\n![b](x2.png "题")\n![](x3.png)');
  assert.ok(row.includes('<p class="imgrow">'), row);
  assert.equal((row.match(/<img/g) ?? []).length, 3, "三枚 img 同段");
  assert.ok(row.includes('title="题"'), "title 不丢");
  const mixed = mdToHtml("说明文字\n![a](x1.png)");
  assert.ok(!mixed.includes("imgrow"), "混文本仍普通段：" + mixed);
  const one = mdToHtml("![solo](big.png)");
  assert.ok(one.includes('<p class="imgrow">') && (one.match(/<img/g) ?? []).length === 1, "单图也走 imgrow（CSS :only-of-type 保旧宽度契约）");
});

test("README 徽章形态：套链图片 [![alt](shield)](link) 也算图片行，同段横排", () => {
  const row = mdToHtml('[![Build Status](https://img.shields.io/b/a.svg?x=1)](https://github.com/a)\n[![npm](https://img.shields.io/npm/v/b)](https://npmjs.com/b)\n[![Gem](https://img.shields.io/gem/v/c)](#anchor)');
  assert.ok(row.includes('<p class="imgrow">'), "三枚套链徽章=一行：" + row);
  assert.equal((row.match(/<img/g) ?? []).length, 3);
  assert.equal((row.match(/<a href=/g) ?? []).length, 3, "外层链接保留");
  const mixedText = mdToHtml("[文字链接](https://a.cn) 后面还有话");
  assert.ok(!mixedText.includes("imgrow"), "纯文字链接不算图片行：" + mixedText);
});

test("自动链接不被误判为 HTML 块", () => {
  const h = mdToHtml("<https://www.example.com/x>");
  assert.ok(h.includes('<a href="https://www.example.com/x"'), h);
  assert.ok(!h.includes("escape"), "");
});
