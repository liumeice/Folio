/* 左右栏宽度约束的纯函数断言（分隔条的行为核心都在这里）。
 * 运行：node --experimental-strip-types --test tests/unit/layout.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampSide, sideMax, SIDE_DEFAULT, SIDE_MAX_STATIC, SIDE_MIN, CENTER_MIN,
} from "../../src/lib/layout.ts";

test("缺省与非法值都落到合法区间", () => {
  assert.equal(clampSide(null, 1280), SIDE_DEFAULT);
  assert.equal(clampSide(undefined, 1280), SIDE_DEFAULT);
  assert.equal(clampSide(-5, 1280), SIDE_MIN, "负数 → 下限");
  assert.equal(clampSide(9999, 1280), SIDE_MAX_STATIC, "过大 → 静态上限");
  assert.equal(clampSide(266.4, 1280), 266, "四舍五入取整");
});

test("窗口越窄，上限越紧，但绝不超过静态 560", () => {
  assert.equal(sideMax(1000), 1000 - CENTER_MIN);          // 最小窗口：320
  assert.equal(sideMax(1240), SIDE_MAX_STATIC);            // 1240-680=560 正好触顶
  assert.equal(sideMax(2000), SIDE_MAX_STATIC, "再宽也不给超过 560");
  assert.equal(sideMax(600), SIDE_MIN, "窗口小于最小值时也要留得下侧栏");
});

test("记住的宽度在窗口缩窄后被重新夹紧", () => {
  assert.equal(clampSide(500, 1000), 320, "500 在 1000 宽的窗口里放不下 → 让位给阅读区");
  assert.equal(clampSide(300, 1000), 300, "本来就合规的宽度不动");
  assert.equal(clampSide(100, 1400), SIDE_MIN, "低于下限的偏好被抬回来");
});

test("拖动区间始终单调：下限 ≤ 任意夹紧值 ≤ 上限", () => {
  for (const w of [800, 1000, 1280, 1920, 3840]) {
    for (const v of [0, 120, 209, 210, 266, 559, 560, 561, 1200]) {
      const px = clampSide(v, w);
      assert.ok(px >= SIDE_MIN && px <= sideMax(w), `${w}/${v} → ${px} 越界`);
    }
  }
});

test("applySide：唯一生效路径写 --w-side 像素值", async () => {
  const { applySide } = await import("../../src/lib/layout.ts");
  const writes: Array<[string, string]> = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.document;
  g.document = { documentElement: { style: { setProperty: (k: string, v: string) => writes.push([k, v]) } } };
  try {
    applySide(320);
    assert.deepEqual(writes, [["--w-side", "320px"]]);
  } finally {
    g.document = saved;
  }
});
