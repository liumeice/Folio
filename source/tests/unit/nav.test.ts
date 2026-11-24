/* FR-5.2 历史导航语义断言 + v1.2「一把尺」坐标层断言（滚动定位同步方案 §6）：
 * lineFromAnchors / pxFromLine 的边界（零跨度、零高度、外边距、末块哨兵、嵌套取深）、
 * lineOffFromLine / navForRestorePos 恢复主链、三常量互不串用。
 * 运行：node --experimental-strip-types --test tests/nav.test.ts ） */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_SEC_ZONE, HEAD_OFFSET, SYNC_TOP,
  lineFromAnchors, pxFromLine, lineOffFromLine, navForRestorePos,
  navForHistEntrySameDoc, lineForSec, type AnchorBlk,
} from "../src/lib/nav.ts";

/* 构造锚点表：top/bottom 直接给定 */
const blk = (start: number, end: number, top: number, bottom: number): AnchorBlk =>
  ({ start, end, top, bottom });

test("常量分离铁律：交接线=0，大纲 zone 与锚点留白不得混入交接", () => {
  assert.equal(SYNC_TOP, 0);
  assert.equal(ACTIVE_SEC_ZONE, 80);
  // HEAD_OFFSET 必须与 app.css .prose h* scroll-margin-top 同值（单源校验，二轮评审 3.5.2）
  assert.equal(HEAD_OFFSET, 60);
});

test("像素→行：块内线性；相邻块零高度（denom≤0）不产 NaN", () => {
  const blks = [blk(0, 0, 0, 40), blk(1, 3, 40, 40), blk(4, 10, 40, 300)];
  // 占位块塌陷（bottom==top==40）：sampleY=40 处 denom 若取 (1,3)→(4,10) 之间为 0 → pxFrac=0
  const l = lineFromAnchors(blks, 40, 20)!;
  assert.ok(Number.isFinite(l), "不得为 NaN");
  assert.equal(l, 4, "零高度相邻时落该块起始行");
});

test("像素→行：标题外边距归属下一块（第一个 bottom>sampleY 规则）", () => {
  const blks = [blk(0, 0, 0, 20), blk(2, 4, 54, 100)]; // 标题底 20，下一段顶 54，中间是 margin
  assert.equal(lineFromAnchors(blks, 30, 10), 2, "margin 区采样直接判给下一块首行");
});

test("像素→行：零跨度块用下一块 start 补跨度（卡行缺陷回归）", () => {
  const blks = [blk(5, 5, 100, 130), blk(6, 9, 130, 200)];
  const l = lineFromAnchors(blks, 115, 30)!; // 标题块中部
  assert.ok(l > 5 && l <= 6, "应落在 5→6 的补跨度内，而不是恒等于 5：" + l);
});

test("像素→行：末块无 next 时按剩余区间返回；超尾钳到 docLines-1", () => {
  const blks = [blk(0, 0, 0, 50), blk(1, 5, 50, 500)];
  const mid = lineFromAnchors(blks, 300, 6)!;
  assert.ok(mid >= 1 && mid <= 6);
  assert.equal(lineFromAnchors(blks, 99999, 6)! <= 5, true);
});

test("行→像素：末块/无 next 时取块顶起线性外推不越界；无包含块取后一块顶", () => {
  const blks = [blk(0, 0, 10, 30), blk(2, 2, 100, 120)]; // [1,1] 是表分隔行等无锚行
  const y = pxFromLine(blks, 2, 10)!;
  assert.equal(y, 100);
  const yGap = pxFromLine(blks, 1, 10)!; // 不被任何块包含
  assert.equal(yGap, 100, "就近取其后一块顶边");
});

test("行↔像素往返一致（子锚嵌套时取最窄跨度）", () => {
  const blks = [
    blk(3, 9, 300, 900),    // codeblock 外层（含 header）
    blk(4, 8, 340, 890),    // <pre> 子锚
  ];
  for (const l of [4, 5.3, 6.75, 8]) {
    const y = pxFromLine(blks, l, 30)!;
    const back = lineFromAnchors(blks, y, 30)!;
    assert.ok(Math.abs(back - l) < 0.51, `往返 ${l} → ${back}`);
  }
});

test("lineOffFromLine：章节内偏移；无标题文档退绝对行", () => {
  const ol = [{ sec: 1, line: 0 }, { sec: 2, line: 10 }, { sec: 3, line: 20 }];
  assert.deepEqual(lineOffFromLine(ol, 15), { sec: 2, off: 5 });
  assert.deepEqual(lineOffFromLine(ol, 0.5), { sec: 1, off: 0.5 });
  assert.deepEqual(lineOffFromLine([], 7), { sec: null, off: 7 });
});

test("navForRestorePos：行偏移主链；标题上方增删抗变（相对偏移语义）；缺锚退 null", () => {
  const olNew = [{ sec: 1, line: 0 }, { sec: 2, line: 60 }, { sec: 3, line: 70 }]; // sec2 上方新增 50 行
  const nav = navForRestorePos({ sec: 2, secLineOff: 5 }, olNew, 80);
  assert.deepEqual(nav, { kind: "line", line: 65 });
  assert.deepEqual(navForRestorePos({ sec: null, secLineOff: 12 }, [], 80), { kind: "line", line: 12 }, "无标题文档走绝对行");
  assert.equal(navForRestorePos({ sec: 1, secLineOff: -1 }, olNew, 80), null, "旧行无值退旧链");
  assert.equal(navForRestorePos({ sec: 99, secLineOff: 3 }, olNew, 80), null, "章节已删退旧链");
});

test("lineFloat 历史导航：有行号绝对位置优先；无行号退回 ratio（向后兼容）", () => {
  const n = navForHistEntrySameDoc({ docId: 1, sec: 3, secText: "x", ratio: 0.42, lineFloat: 17.5 });
  assert.deepEqual(n, { kind: "line", line: 17.5 });
  const legacy = navForHistEntrySameDoc({ docId: 1, sec: 3, secText: "x", ratio: 0.42 });
  assert.equal(legacy.kind, "restore");
  const top = navForHistEntrySameDoc({ docId: 1, sec: 3, secText: "x", ratio: 0.42, lineFloat: 0.2 });
  assert.equal(top.kind, "restore", "开头几行微小残留不算位置");
});

test("lineForSec：大纲点击取章节起始行", () => {
  const ol = [{ sec: 1, line: 0 }, { sec: 2, line: 10 }];
  assert.equal(lineForSec(ol, 2), 10);
  assert.equal(lineForSec(ol, 7), null);
});
