/* 内嵌原始 HTML（需求 #3）：功能面（README 徽章块生效）+ 安全面（白名单净化逐条钉死）。
 * 运行：node --experimental-strip-types --test tests/unit/html.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const js = new JSDOM("");
(globalThis as unknown as { DOMParser: unknown }).DOMParser = js.window.DOMParser;

const { mdToHtml } = await import("../../src/lib/md.ts");

test("README 式徽章块原样生效：p/img/a/align 保留，块在空行处结束", () => {
  const h = mdToHtml('<p align="center">\n  <a href="https://getbootstrap.com/">\n    <img src="logo.svg" alt="B" width="200">\n  </a>\n</p>\n\n## 下一节');
  assert.ok(h.includes('<p align="center"'), "p 块未被转义：" + h);
  assert.ok(h.includes('<img src="logo.svg"') && h.includes('width="200"'), "img 属性齐全");
  assert.ok(h.includes('<a href="https://getbootstrap.com/"'), "链接保留");
  assert.ok(h.includes('data-sec="1"') && h.includes("下一节"), "空行后回到 markdown 解析");
  assert.ok(!h.includes("&lt;p"), "不再以字面文本显示 HTML");
});

test("安全：tagfilter 语义（第三档翻转）——行首独占的危险标签转义可见；块标签表内仍整枝删除", () => {
  const h = mdToHtml("<script>alert(1)</script>\n\n<style>body{background:url(evil)}</style>\n\n<iframe src=\"https://evil/x\"></iframe><object data=\"y\"></object>");
  assert.ok(!h.includes("<script"), "script 标签本体绝不注入");
  assert.ok(h.includes("&lt;script&gt;") && h.includes("alert(1)"), "转义可见、内容不静默丢（GFM tagfilter / audit 6.11-a）：" + h.slice(0, 120));
  assert.ok(!h.includes("<style") && h.includes("&lt;style&gt;"), "style 同理转义可见");
  assert.ok(!h.includes("<iframe") && !h.includes("<object"), "iframe/object 属类型 6 块标签表：整枝删除维持");
  const inj = mdToHtml("<div>\n<script>alert(2)</script>\n</div>");
  assert.ok(!inj.includes("alert(2)"), "块净化路径（DOMParser）删除分支不受影响");
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

test("第三档·HTML 块终止模式（CC 类型 1/2/3/5）：DOCTYPE 直出、注释跨空行、pre 吃到闭标签", () => {
  const dt = mdToHtml("<!DOCTYPE html>");
  assert.ok(dt.includes("<!DOCTYPE html>"), "DOCTYPE 声明原文保留：" + dt.slice(0, 80));
  const cmt = mdToHtml("<!--\n\ncomment\n-->");
  // 2026-11-23 口径：注释不产生可见输出（GFM 同口径；此前整块转义成可见文本属缺陷）
  assert.ok(!cmt.includes("comment") && !cmt.includes("<!--") && !cmt.includes("<p"), "注释块不可见（含跨空行）：" + cmt.slice(0, 80));
  const pre = mdToHtml("<pre>\nline1\n\nline2\n</pre>\n\n正文");
  assert.ok(pre.includes("<pre>") && pre.includes("line2") && pre.includes("正文"), "pre 类型1吃到 </pre>：");
  // 类型 6 未闭合 opener（第三档补强）：块仍止于空行，但裸片段直出保持开放——
  // 空行后的 Markdown 段与 closer 块拼进同一容器（GitHub 同款嵌套），不再被 rawblk 强制闭合
  const div = mdToHtml("<div>\na\n\nb\n</div>");
  assert.ok(div.includes('<div data-line-start="0"'), "div 裸出+行锚挂首标签：" + div);
  assert.ok(/<p[^>]*>b<\/p>/.test(div) && div.trimEnd().endsWith("</div>"), "b 成为 div 内的 Markdown 段：" + div);
});

test("第三档·details/summary 跨空行嵌套（audit 10.2）：opener/closer 裸片段跨块拼接，中间走 Markdown", () => {
  const h = mdToHtml("<details>\n<summary>点击展开</summary>\n\n**粗。**\n\n</details>\n\n尾");
  assert.ok(h.includes("<details") && h.includes("<summary>点击展开</summary>"), h.slice(0, 100));
  assert.ok(h.includes("<strong>粗。</strong>"), "中间内容按 Markdown 解析（粗体生效）");
  const di = h.indexOf("<details"), dk = h.indexOf("<strong>"), dj = h.indexOf("</details>");
  assert.ok(di >= 0 && di < dk && dk < dj, "粗体段位于 details 嵌套之内");
  assert.ok(h.includes("<p") && h.trimEnd().endsWith("尾</p>"), "尾段在容器外");
});

test("第三档·HTML 块起始白名单（真 DOM 侧结构断言）：类型 6/7 才开块，行首行内标签归段落", () => {
  const dt = mdToHtml("<details>\n<summary>x</summary>\n*不强调*\n</details>");
  assert.ok(dt.includes("<details>") && dt.includes("<summary>x</summary>") && !dt.includes("<em>不强调</em>"), dt.slice(0, 120));
  const sp = mdToHtml("<span>hi</span>\n**bold**");
  assert.ok(sp.includes("<p") && sp.includes("<span>hi</span>") && sp.includes("<strong>bold</strong>"), "audit 4.6-c 场景：" + sp.slice(0, 120));
  const div = mdToHtml("<div>\n*hi*\n</div>");
  assert.ok(div.includes("<div>") && !div.includes("<em>hi</em>"), "div 块语义维持");
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

test("行内 HTML 已放行（GFM 6.10，2026-11-21 P0）：ALLOW 标签渲染、未知/危险标签转义", () => {
  const h = mdToHtml("文本 <b>粗</b>、<kbd>K</kbd>、<blink>x</blink>、<script>y</script> 尾");
  assert.ok(h.includes("<b>粗</b>") && h.includes("<kbd>K</kbd>"), "白名单标签渲染：" + h);
  assert.ok(h.includes("&lt;blink&gt;x&lt;/blink&gt;"), "未知标签转义为可见文本");
  assert.ok(h.includes("&lt;script&gt;") && !h.includes("<script>y</script>"), "危险标签转义（不执行也不静默丢）");
  const x = mdToHtml('<a href="javascript:alert(1)" onclick="bad()">t</a> 与 <img src=x onerror=alert(2)>');
  assert.ok(!x.includes("javascript:") && !x.includes("onclick") && !x.includes("onerror"), "行内属性净化：scheme/on* 全剥");
  assert.ok(x.includes("<a>t</a>"), "a 保结构去危险属性");
});

test("连续图片横向排列（需求补充）：纯图片段= imgrow；混文本段/单图不受牵连", () => {
  const row = mdToHtml('![a](x1.png)\n![b](x2.png "题")\n![](x3.png)');
  assert.ok(row.includes('<p class="imgrow" data-line-start'), row);
  assert.equal((row.match(/<img/g) ?? []).length, 3, "三枚 img 同段");
  assert.ok(row.includes('title="题"'), "title 不丢");
  const mixed = mdToHtml("说明文字\n![a](x1.png)");
  assert.ok(!mixed.includes("imgrow"), "混文本仍普通段：" + mixed);
  const one = mdToHtml("![solo](big.png)");
  assert.ok(one.includes('<p class="imgrow" data-line-start') && (one.match(/<img/g) ?? []).length === 1, "单图也走 imgrow（CSS :only-of-type 保旧宽度契约）");
});

test("README 徽章形态：套链图片 [![alt](shield)](link) 也算图片行，同段横排", () => {
  const row = mdToHtml('[![Build Status](https://img.shields.io/b/a.svg?x=1)](https://github.com/a)\n[![npm](https://img.shields.io/npm/v/b)](https://npmjs.com/b)\n[![Gem](https://img.shields.io/gem/v/c)](#anchor)');
  assert.ok(row.includes('<p class="imgrow" data-line-start'), "三枚套链徽章=一行：" + row);
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
