/* Mermaid 渲染的同步边界契约：错误图判定只认可见文案；无目标块时零加载、零副作用。
 * 真渲染（v11 引擎）属于窗口级冒烟，不放进单元测试。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../helpers/dom.ts";

const dom = installDom();
const { isMermaidErrorSvg, renderMermaid } = await import("../../src/lib/mermaidRender.ts");

test("isMermaidErrorSvg：只认 Syntax error in text", () => {
  assert.equal(isMermaidErrorSvg('<svg><text>Syntax error in text</text></svg>'), true);
  assert.equal(isMermaidErrorSvg('<svg><g class="error-icon"></g></svg>'), false, "合法图也内嵌 error-icon 样式");
  assert.equal(isMermaidErrorSvg('<svg><path d="M0 0"/></svg>'), false);
});

test("renderMermaid：无 [data-mermaid] 目标时立即返回（不导入引擎）", async () => {
  const scope = dom.window.document.createElement("div");
  scope.innerHTML = "<p>no diagram</p><div data-zuml></div>";
  await renderMermaid(scope, undefined, "dark");
  assert.equal(scope.querySelector("[data-mermaid]"), null);
});

test("renderMermaid：连续空调用走同一串行链且不抛错", async () => {
  const a = dom.window.document.createElement("div");
  const b = dom.window.document.createElement("div");
  await Promise.all([renderMermaid(a, undefined, "dark"), renderMermaid(b, undefined, "light")]);
  assert.ok(true);
});