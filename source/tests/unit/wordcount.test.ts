/* 字数口径回归（2026-11-17 需求定夺：公式/图表源码不计）。
 * fixture 与期望值同 crates/folio-core/src/markdown.rs::stats_skips_math_and_diagram_blocks 钉死——
 * 改一边必须同步另一边（跨语言契约）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords } from "../../src/lib/wordcount.ts";

const FIXTURE = "# A\n\n正文四字。\n\n$$\n\\frac{1}{2}\n$$\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```js\nlet x=1\n```\n\n## B\n";

test("主 fixture：正文+js 围栏=24，公式/图表整剔（与 Rust stats 同值）", () => {
  // 期望逐件可核：#A(2)+正文四字。(5)+```js(5)+letx=1(6)+```(3)+##B(3)=24；
  // $$ 界行与 \frac 内容行、mermaid 整块全部剔除。两侧同数字（跨语言契约，改口径同改两处）。
  assert.equal(countWords(FIXTURE), 24);
});

test("公式块整剔：$$…$$ / ```math / ```mermaid（大小写不敏感）", () => {
  assert.equal(countWords("$$\n\\frac{1}{2}\n$$\n"), 0);
  assert.equal(countWords("```math\nE=mc^2\n```\n"), 0);
  assert.equal(countWords("```MERMAID\ngraph TD\nA-->B\n```\n"), 0);
});

test("普通代码块照旧计入（M0 旧口径，N19 待定项不动）", () => {
  assert.ok(countWords("```js\nlet x=1\n```\n") > 0);
});

test("未闭合 $$ 吃到 EOF；$$ 块内的 ``` 不误判为代码围栏", () => {
  assert.equal(countWords("$$\n```\nx\n"), 0);
});

test("码点计数：emoji 算 1（UTF-16 length 陷阱，对齐 Rust chars()）", () => {
  assert.equal(countWords("😀"), 1);
  assert.equal(countWords("😀😀 文字"), 4);
});

test("第二档：~~~ 围栏同跳、变长配对（与 Rust stats 同值）", () => {
  assert.equal(countWords("~~~mermaid\ngraph TD\nA-->B\n~~~\n"), 0, "~~~mermaid 整块剔除");
  assert.equal(countWords("~~~\nx\n~~~~\n"), 8, "~~~ 被更长的 ~~~~ 关闭：3+1+4 全计");
});
