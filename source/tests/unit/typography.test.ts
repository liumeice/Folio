/* 排版设置的机械核对：范围、换算、CSS 变量出口、跨语言默认值一致性。
 * 运行：node --experimental-strip-types --test tests/unit/typography.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULTS, RANGE, STEP, clampNum, densityClass, paraPx, typeVars,
} from "../../src/lib/typography.ts";
import { DEFAULT_SETTINGS } from "../../src/lib/defaults.ts";
import type { Settings } from "../../src/lib/types.ts";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const full = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

test("clampNum：越界夹回区间，且不积累浮点尾数", () => {
  assert.equal(clampNum("letterSpacing", 5), 0.12);
  assert.equal(clampNum("letterSpacing", -1), 0);
  assert.equal(clampNum("paraSpacing", 0), 0.6);
  assert.equal(clampNum("width", 99999), 1280);
  assert.equal(clampNum("lh", 1.8500000001), 1.85, "0.05 步长不该出现 1.8500000000000001");
  assert.equal(clampNum("codeFs", 20), 15.5);
  assert.equal(clampNum("未知键", 42), 42, "不认识的键原样返回");
  for (const [k, [lo, hi]] of Object.entries(RANGE)) {
    for (const v of [lo - 100, lo, hi, hi + 100, 0, -0.005]) {
      const c = clampNum(k, v);
      assert.ok(c >= lo - 1e-9 && c <= hi + 1e-9, `${k}: ${v} → ${c} 越界`);
    }
  }
});

test("段距 em → px：相对当前字号基线", () => {
  assert.equal(paraPx(full({ serif: true, fsSerif: 15.5, paraSpacing: 1 })), 15.5);
  assert.equal(paraPx(full({ serif: false, fsSans: 14, paraSpacing: 1.2 })), 16.8);
  assert.equal(paraPx(full({ serif: true, fsSerif: 19.5, paraSpacing: 2 })), 39, "上限也不该溢出");
});

test("typeVars：键齐全、值带单位、并跟随衬线切换", () => {
  const v = typeVars(full({ serif: true, fsSerif: 16, lh: 1.7, width: 720,
    letterSpacing: 0.02, paraSpacing: 1.4, align: "justify", codeFs: 13 }));
  assert.deepEqual(v, {
    "--prose-fs": "16px",
    "--prose-w": "720px",
    "--prose-lh": "1.7",
    "--prose-ls": "0.02em",
    "--prose-para": "22.4px",
    "--prose-align": "justify",
    "--code-fs": "13px",
  });
  assert.equal(typeVars(full({ serif: false, fsSans: 14 }))["--prose-fs"], "14px", "无衬线基线跟着切");
  // 恶意值也要夹住（设置可能被旧版本或手改 DB 带进来）
  const bad = typeVars(full({ letterSpacing: 9, codeFs: 1, width: 10 }));
  assert.equal(bad["--prose-ls"], "0.12em");
  assert.equal(bad["--code-fs"], "10.5px");
  assert.equal(bad["--prose-w"], "640px");
});

test("CSS 侧必须真的用这些变量与密度类名，否则设置写了也没人看", () => {
  const css = read("../../src/styles/app.css");
  for (const key of Object.keys(typeVars(full()))) {
    assert.ok(css.includes(`var(${key}`), `app.css 里没有引用 ${key}`);
  }
  for (const cls of ["density-compact", "density-loose"]) {
    assert.ok(css.includes(`.${cls}`), `app.css 缺少 .${cls} —— 密度设置会静默失效`);
  }
});

test("密度类名映射", () => {
  assert.equal(densityClass("compact"), "density-compact");
  assert.equal(densityClass("loose"), "density-loose");
  assert.equal(densityClass("standard"), "", "标准态不加类，走 CSS 默认");
});

test("默认值两份 TS 来源一致（Rust 由 tests/fixtures/settings-default.json 契约覆盖）", () => {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    assert.equal((DEFAULT_SETTINGS as Record<string, unknown>)[k], v, `TS 两份默认值打架：${k}`);
  }
});

test("每个数值控件都有区间与步长（抽屉里的滑块不至于漏配）", () => {
  for (const k of Object.keys(RANGE)) {
    assert.ok(STEP[k] > 0, `${k} 缺步长`);
    const [lo, hi] = RANGE[k];
    assert.ok(hi > lo, `${k} 区间反了`);
    // 步长要能在区间里走至少 8 档，又不能大到一格跨过整个量程
    assert.ok(STEP[k] <= (hi - lo) / 8, `${k} 步长相对区间太大`);
    assert.ok((hi - lo) / STEP[k] <= 2000, `${k} 步长太细，滑块会没有手感`);
  }
});
