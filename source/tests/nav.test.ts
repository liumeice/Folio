/* FR-5.2 历史导航语义断言（评审 D1 的"补冒烟断言"落点之一；
 * 运行：node --experimental-strip-types --test tests/nav.test.ts ）
 * 跨文档/打开恢复路径由 store 的 switchTo + positions 承担，待 M1 组件落地后转 Playwright e2e。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { navForHistEntrySameDoc } from "../src/lib/nav.ts";

test("同文档：ratio 存在 → 绝对位置优先（prefer=position），不再锚点优先", () => {
  const n = navForHistEntrySameDoc({ docId: 1, sec: 3, secText: "3.2 阅读进度", ratio: 0.42 });
  assert.equal(n?.kind, "restore");
  assert.equal((n as { prefer?: string }).prefer, "position");
  assert.equal((n as { ratio: number }).ratio, 0.42);
});

test("同文档：ratio 缺失/过小 → 退锚点", () => {
  assert.equal(navForHistEntrySameDoc({ docId: 1, sec: 3, secText: "x", ratio: null })?.kind, "anchor");
  assert.equal(navForHistEntrySameDoc({ docId: 1, sec: 3, secText: "x", ratio: 0.01 })?.kind, "anchor");
});

test("同文档：二者皆无 → 顶部", () => {
  assert.equal(navForHistEntrySameDoc({ docId: 1, sec: null, secText: null, ratio: null })?.kind, "top");
});

import { secFracFromTopline, lineForSecFrac } from "../src/lib/nav.ts";

test("secFracFromTopline：顶行→章节+章节内比例", () => {
  const ol = [{ sec: 1, line: 0 }, { sec: 2, line: 10 }, { sec: 3, line: 20 }];
  assert.deepEqual(secFracFromTopline(ol, 0), { sec: 1, frac: 0 });
  assert.deepEqual(secFracFromTopline(ol, 15), { sec: 2, frac: 0.5 });
  assert.deepEqual(secFracFromTopline(ol, 25), { sec: 3, frac: 1 });
  assert.deepEqual(secFracFromTopline([], 9), { sec: null, frac: 0 });
});

test("lineForSecFrac：往返一致（与 secFracFromTopline 同一坐标系）", () => {
  const ol = [{ sec: 1, line: 0 }, { sec: 2, line: 10 }, { sec: 3, line: 20 }];
  assert.equal(lineForSecFrac(ol, 2, 0.5), 15);
  assert.equal(lineForSecFrac(ol, 3, 0), 20);
  assert.equal(lineForSecFrac(ol, null, 0), 0);
  const sf = secFracFromTopline(ol, 13);
  assert.equal(lineForSecFrac(ol, sf.sec, sf.frac), 13, "行→比例→行应还原");
});
