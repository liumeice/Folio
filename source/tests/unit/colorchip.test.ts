/* 阅读窗色值色块断言（规范 §4.5 方案 D）：识别口径、误伤豁免、文本节点完整性、幂等。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><body><div id="t"><article class="prose"></article></div>`);
// @ts-expect-error browser globals for lib
globalThis.document = dom.window.document;
// @ts-expect-error browser globals for lib
globalThis.HTMLElement = dom.window.HTMLElement;
// @ts-expect-error browser globals for lib
globalThis.NodeFilter = dom.window.NodeFilter;

const { applyColorChips, colorToken } = await import("../src/lib/colorchip.ts");

const article = dom.window.document.querySelector("article.prose")!;
function reset(html: string) { article.innerHTML = html; applyColorChips(article as any); }
const chips = () => [...article.querySelectorAll(".cchip")];
const tokens = () => chips().map((c) => c.textContent);

test("识别口径：hex 3/4/6/8 位与函数记法全部出块", () => {
  reset(`<p>a #fff b #2DD4BF1F c #Fb923C d rgba(4,8,16,.62) e rgb(13,148,136) f hsl(174,62%,50%) g</p>`);
  assert.deepEqual(tokens(), ["#fff", "#2DD4BF1F", "#Fb923C", "rgba(4,8,16,.62)", "rgb(13,148,136)", "hsl(174,62%,50%)"]);
  const first = chips()[0] as Element;
  assert.equal(first.querySelector("i")!.getAttribute("style"), "background:#fff");
});

test("非法与无井号一律不碰", () => {
  reset(`<p>#12345 #1234567 080D18 rgba(999,0,0,2) rgb(1,2) hsl(1,2,3,4,5)</p>`);
  assert.equal(chips().length, 0);
  reset(`<p>#080D 合法短写</p>`);
  assert.deepEqual(tokens(), ["#080D"]);
});

test("标识符误伤豁免：div#123、issue#abc 不出块；正常标点后可出", () => {
  reset(`<p>div#123 x#fff -#000 但（#080D18）与“#2DD4BF”要出</p>`);
  assert.deepEqual(tokens(), ["#080D18", "#2DD4BF"]);
});

test("范围：表格与行内代码出块；围栏 pre 与链接文字不出", () => {
  reset(`<table><tr><td>#080D18</td></tr></table>
    <p><code>rgba(4,8,16,.62)</code> 与 <a href="#x">#0C1424</a> 与</p>
    <pre><code>#E7EEF9</code></pre>`);
  assert.deepEqual(tokens(), ["#080D18", "rgba(4,8,16,.62)"]);
});

test("token 保持单一文本节点：搜索高亮按整 token 命中", () => {
  reset(`<p>色值 #2DD4BF 青绿</p>`);
  const chip = chips()[0];
  assert.equal(chip!.childNodes.length, 2); // <i> + 文本
  assert.equal(chip!.lastChild!.nodeType, 3);
  assert.equal(chip!.lastChild!.textContent, "#2DD4BF");
});

test("幂等：重复 apply 不嵌套不重复", () => {
  reset(`<p>#080D18</p>`);
  applyColorChips(article as any);
  applyColorChips(article as any);
  assert.equal(chips().length, 1);
  assert.equal(article.querySelectorAll(".cchip .cchip").length, 0);
});

test("colorToken 校验单元：合法返回原文、非法返回 null", () => {
  assert.equal(colorToken("#AbCdef"), "#AbCdef");
  assert.equal(colorToken("rgba(4, 8, 16, 62%)"), "rgba(4, 8, 16, 62%)");
  assert.equal(colorToken("hsl(174 62% 50%)"), null); // 空格分隔新语法不在口径内
  assert.equal(colorToken("#12345"), null);
  assert.equal(colorToken("rgb(300,0,0)"), null);
});
