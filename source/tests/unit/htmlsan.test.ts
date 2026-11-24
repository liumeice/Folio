/* htmlsan 的单元契约：行内单标签净化、URL scheme 白名单、无 DOM 保守回退、
 * 块级树清洗（未知标签拆壳、危险子树整枝删除、SVG 子树黑名单）。
 * 与 tests/unit/html.test.ts、svg.test.ts 的功能面用例互补，这里直测净化器本身。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../helpers/dom.ts";

installDom();
const { sanitizeInlineTag, sanitizeHtml, isAllowedTag } = await import("../../src/lib/htmlsan.ts");

test("isAllowedTag：ASCII 大小写不敏感；svg/math 不在通用白名单", () => {
  assert.equal(isAllowedTag("KBD"), true);
  assert.equal(isAllowedTag("strong"), true);
  assert.equal(isAllowedTag("svg"), false);
  assert.equal(isAllowedTag("math"), false);
  assert.equal(isAllowedTag("custom-tag"), false);
});

test("sanitizeInlineTag：白名单标签归一化大小写、丢弃 XHTML 自闭合斜杠", () => {
  assert.equal(sanitizeInlineTag("<KBD CLASS=\"x\">"), '<kbd class="x">');
  assert.equal(sanitizeInlineTag("</KBD>"), "</kbd>");
  assert.equal(sanitizeInlineTag("<br/>"), "<br>");
  assert.equal(sanitizeInlineTag("<div class=x id=y>"), '<div class="x" id="y">');
});

test("sanitizeInlineTag：未知/危险标签与半截标签返回 null（调用方转义可见）", () => {
  assert.equal(sanitizeInlineTag("<script>"), null);
  assert.equal(sanitizeInlineTag("<svg>"), null);
  assert.equal(sanitizeInlineTag("<unknown>"), null);
  assert.equal(sanitizeInlineTag("<a href=\"x\""), null);
  assert.equal(sanitizeInlineTag("plain text"), null);
});

test("sanitizeInlineTag：属性白名单 + on*/style 剥除 + URL scheme 复核", () => {
  assert.equal(sanitizeInlineTag('<span onclick="x" style="color:red">'), "<span>");
  assert.equal(sanitizeInlineTag('<a href="javascript:alert(1)">'), "<a>");
  assert.equal(sanitizeInlineTag('<a href="java script:x">'), "<a>");
  assert.equal(sanitizeInlineTag('<a href="mailto:x@y.z">'), '<a href="mailto:x@y.z">');
  assert.equal(sanitizeInlineTag('<a href="#frag">'), '<a href="#frag">');
  assert.equal(sanitizeInlineTag('<img src="data:image/png;base64,xx">'), '<img src="data:image/png;base64,xx">');
  assert.equal(sanitizeInlineTag('<img src="data:text/html,x">'), "<img>");
  assert.equal(sanitizeInlineTag('<img src="//cdn.example/x.png">'), '<img src="//cdn.example/x.png">');
});

test("sanitizeHtml 无 DOM：整体转义，绝不裸注入", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.DOMParser;
  delete g.DOMParser;
  try {
    assert.equal(
      sanitizeHtml('<b title="x">a&b</b>'),
      "&lt;b title=&quot;x&quot;&gt;a&amp;b&lt;/b&gt;",
    );
  } finally {
    g.DOMParser = saved;
  }
});

test("sanitizeHtml 块级：未知标签拆壳保文本、危险子树整枝删除", () => {
  const out = sanitizeHtml('<b onclick=x>ok</b><unknown>u</unknown><script>bad</script>');
  assert.equal(out, "<b>ok</b>u");
});

test("sanitizeHtml 块级：SVG 保留几何/style，删 script 与事件属性，危险 href 剥除", () => {
  const out = sanitizeHtml(
    '<svg><circle style="fill:red" onload="x"/>' +
    '<image href="javascript:alert(1)" xlink:href="http://ok.example/a.png"/>' +
    '<script>bad</script></svg>',
  );
  assert.ok(out.includes('<circle style="fill:red">'), out);
  assert.ok(!out.includes("onload"), out);
  assert.ok(!out.includes("javascript"), out);
  assert.ok(out.includes("http://ok.example/a.png"), out);
  assert.ok(!out.includes("<script"), out);
});

test("sanitizeHtml 块级：换行混淆的 javascript: href 仍被剥掉", () => {
  assert.equal(sanitizeHtml('<a href="java\nscript:alert(1)">x</a>'), "<a>x</a>");
});