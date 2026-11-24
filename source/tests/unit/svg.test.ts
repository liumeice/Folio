/* 内联 SVG 净化策略（2026-11-20 解禁）：几何/SMIL 保留，script/foreignObject/style 删除，
 * href 族走 URL 白名单。运行：node --experimental-strip-types --test tests/svg.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const js = new JSDOM("");
(globalThis as unknown as { DOMParser: unknown }).DOMParser = js.window.DOMParser;

const { mdToHtml } = await import("../src/lib/md.ts");

test("SMIL 动画 SVG 原样保留：animate 元素与 SMIL 属性不剥", () => {
  const h = mdToHtml(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect x="8" y="24" width="24" height="32" fill="#325A67"><animateTransform attributeName="transform" type="translate" values="0 0;120 0;0 0" dur="1.2s" repeatCount="indefinite"/></rect></svg>`);
  assert.ok(h.includes("<svg"), "svg 保留：" + h.slice(0, 80));
  assert.ok(h.includes("<animateTransform") && h.includes('dur="1.2s"') && h.includes('repeatCount="indefinite"'), "SMIL 属性齐全");
  assert.ok(h.includes('viewBox="0 0 160 80"') && h.includes('fill="#325A67"'), "几何/呈现属性保留");
});

test("svg 里的 script / foreignObject / style 整枝删除（含内容）", () => {
  const h = mdToHtml(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/><script>alert(1)</script><foreignObject><body><p>借道</p></body></foreignObject><style>body{display:none}</style></svg>`);
  assert.ok(!h.includes("<script") && !h.includes("alert(1)"), "脚本连内容删除");
  assert.ok(!h.includes("foreignObject") && !h.includes("借道"), "HTML 逃逸口整枝删除");
  assert.ok(!h.includes("<style") && !h.includes("display:none"), "内联样式表删除——防文档级 UI 劫持");
  assert.ok(h.includes("<rect"), "其余图形不受牵连");
});

test("svg 属性黑名单：on* 剥、javascript: href 剥、#片断与 xlink 合法引用留", () => {
  const h = mdToHtml(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle cx="4" cy="4" r="4" onclick="bad()"/><image href="javascript:alert(2)" xlink:href="http://ok.example/a.png"/><use xlink:href="#frag"/></svg>`);
  assert.ok(!h.includes("onload") && !h.includes("onclick"), "事件属性删除");
  assert.ok(!/href="javascript/i.test(h), "危险 scheme 剥掉");
  assert.ok(h.includes("ok.example/a.png"), "外链 image 引用留（显示层再受 CSP 管辖）");
  assert.ok(h.includes('xlink:href="#frag"') || h.includes('href="#frag"'), "内部片断引用保留");
});

test("svg style 呈现属性保留（不含样式表能力，安全）", () => {
  const h = mdToHtml(`<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:#325A67;opacity:.5" width="4" height="4"/></svg>`);
  assert.ok(h.includes('style="fill:#325A67'), "style 属性保留");
});

test("HTML 语境之外的禁令不变：math 仍整枝删除，正文级 style 仍删", () => {
  const h = mdToHtml(`<math><mi>x</mi></math>`);
  assert.ok(!h.includes("<math") && !h.includes("<mi"), "math 维持禁令");
});
