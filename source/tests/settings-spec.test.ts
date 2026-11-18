/* 设置中心声明层的机械核对（视图不做判断，所以判断都能在这里测）。
 * 运行：node --experimental-strip-types --test tests/settings-spec.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, ITEMS, activeDomain, bump, resetPatch } from "../src/lib/settings-spec.ts";
import { DEFAULTS, RANGE, STEP, clampNum } from "../src/lib/typography.ts";
import { DEFAULT_SETTINGS } from "../src/lib/defaults.ts";
import type { Settings } from "../src/lib/types.ts";

const S = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
const numeric = ITEMS.filter((i) => typeof i.get(S()) === "number");
const segs = ITEMS.filter((i) => i.control.kind === "segment");

test("分组自洽：每组有行、每行归到存在的组", () => {
  for (const g of GROUPS) assert.ok(ITEMS.some((i) => i.group === g.id), `${g.title} 是空组`);
  const ids = new Set(GROUPS.map((g) => g.id));
  for (const i of ITEMS) assert.ok(ids.has(i.group), `${i.label} 归到不存在的组`);
});

test("每个数值行：set→get 落在域内，且域与 typography 单一来源一致", () => {
  for (const i of numeric) {
    const d = activeDomain(i, S())!;
    for (const raw of [-9999, 0, d.min, d.max, 99999, d.min + (d.max - d.min) / 2]) {
      const back = i.get(S(i.set(S(), raw)));
      assert.ok(typeof back === "number" && back >= d.min - 1e-9 && back <= d.max + 1e-9,
        `${i.label}: 写入 ${raw} 读回 ${back} 越界 [${d.min},${d.max}]`);
    }
  }
  // 域来自 RANGE/STEP（sideWidth 除外，它另有硬边界）
  const mapBy = { lh: "lh", letterSpacing: "letterSpacing", paraSpacing: "paraSpacing", width: "width", codeFs: "codeFs" } as const;
  for (const [label, rk] of Object.entries(mapBy)) {
    const item = ITEMS.find((i) => i.key === label)!;
    const d = item.domain!;
    assert.deepEqual([d.min, d.max], [...RANGE[rk]], `${label} 的值域没跟 typography.RANGE 走`);
    assert.equal(d.step, STEP[rk], `${label} 的步长没跟 typography.STEP 走`);
  }
});

test("正文字号那一行按字体族换域，两端不越界", () => {
  const fs = ITEMS.find((i) => i.key === "fs")!;
  assert.deepEqual(activeDomain(fs, S({ serif: true })), { min: RANGE.fsSerif[0], max: RANGE.fsSerif[1], step: STEP.fsSerif });
  assert.deepEqual(activeDomain(fs, S({ serif: false })), { min: RANGE.fsSans[0], max: RANGE.fsSans[1], step: STEP.fsSans });
  // 从衬线高字号切到无衬线：get 取的是 fsSans，不该报衬线的值
  assert.equal(fs.get(S({ serif: true, fsSerif: 19, fsSans: 13 })), 19);
  assert.equal(fs.get(S({ serif: false, fsSerif: 19, fsSans: 13 })), 13);
});

test("bump 步进夹在两端，不会溢出区间", () => {
  for (const i of numeric) {
    const d = activeDomain(i, S())!;
    let v = i.get(S());
    for (let k = 0; k < 200; k++) v = bump(i, S(i.set(S(), v as number)), 1) as number;
    assert.ok((v as number) <= d.max + 1e-9, `${i.label} 连点 + 越上限：${v}`);
    for (let k = 0; k < 200; k++) v = bump(i, S(i.set(S(), v as number)), -1) as number;
    assert.ok((v as number) >= d.min - 1e-9, `${i.label} 连点 − 越下限：${v}`);
  }
});

test("分段行：get 一定落在自己的选项里，set 回读稳定", () => {
  for (const i of segs) {
    const opts = (i.control as { options: readonly (readonly [string, string])[] }).options.map(([v]) => v);
    assert.ok(opts.includes(String(i.get(S()))), `${i.label} 当前值 ${i.get(S())} 不在选项 ${opts.join("/")}`);
    for (const o of opts) assert.equal(i.get(S(i.set(S(), o))), o, `${i.label} 选项 ${o} 读写不一致`);
  }
});

test("主题三卡：当前值在选项内，逐选项读写一致（含护眼米色 sepia）", () => {
  const theme = ITEMS.find((i) => i.control.kind === "themeCard")!;
  const opts = (theme.control as { options: readonly (readonly [string, string])[] }).options.map(([v]) => v);
  assert.deepEqual(opts, ["dark", "light", "sepia"]);
  assert.ok(opts.includes(String(theme.get(S()))), `默认主题 ${theme.get(S())} 不在选项`);
  for (const o of opts) assert.equal(theme.get(S(theme.set(S(), o))), o, `主题 ${o} 读写不一致`);
});

test("强调色色板：get 落在 ACCENTS 内，逐色读写一致", async () => {
  const { ACCENTS } = await import("../src/lib/accent.ts");
  const accent = ITEMS.find((i) => i.control.kind === "swatch")!;
  const hexes = ACCENTS.map((a) => a.id.toLowerCase());
  assert.ok(hexes.includes(String(accent.get(S())).toLowerCase()), `默认强调色 ${accent.get(S())} 不在色板`);
  for (const a of ACCENTS) assert.equal(String(accent.get(S(accent.set(S(), a.id)))).toLowerCase(), a.id.toLowerCase(), `色 ${a.id} 读写不一致`);
});

test("恢复默认只动排版，且值就是 DEFAULTS；不碰主题/强调色/侧栏/库根", () => {
  const patch = resetPatch();
  assert.ok(!("accent" in patch), "恢复默认不该动强调色");
  assert.ok(!("theme" in patch) && !("sideWidth" in patch) && !("libraryRoot" in patch));
  const merged = S({ theme: "light", sideWidth: 500, ...patch });
  assert.equal(merged.lh, DEFAULTS.lh);
  assert.equal(merged.width, DEFAULTS.width);
  assert.equal(merged.letterSpacing, DEFAULTS.letterSpacing);
  assert.equal(merged.paraSpacing, DEFAULTS.paraSpacing);
  assert.equal(merged.codeFs, DEFAULTS.codeFs);
  assert.equal(merged.align, DEFAULTS.align);
  assert.equal(merged.tableDensity, DEFAULTS.tableDensity);
  assert.equal(merged.serif, DEFAULTS.serif);
  assert.equal(merged.theme, "light", "恢复默认不该把用户主题也改了");
});

test("spec 里的 key 都是真实 Settings 字段（fs 是衬线/无衬线合并行，允许）", () => {
  const fields = new Set(Object.keys(DEFAULT_SETTINGS));
  for (const i of ITEMS) {
    if (i.key === "fs") continue;
    assert.ok(fields.has(i.key), `${i.label} 的 key=${i.key} 不在 Settings 里`);
  }
});

test("侧栏宽度不再是设置行，改由分隔条管：layout.clampSide 兜上下限", async () => {
  assert.ok(!ITEMS.some((i) => i.key === "sideWidth"), "spec 里不该再有 sideWidth 行");
  const { clampSide, SIDE_DEFAULT } = await import("../src/lib/layout.ts");
  assert.equal(clampSide(999, 1280), 560, "硬上限 560");
  assert.equal(clampSide(100, 1280), 210, "硬下限 210");
  assert.equal(clampSide(null, 1280), SIDE_DEFAULT, "无记录用默认宽度");
  assert.equal(clampSide(500, 850), 210, "窗口窄时 sideMax 收到 210（850−680=170 再夹到下限），不会给下不去的宽度");
});

test("开关行与首启默认（需求方 2026-11-18：浅色主题 + 石青强调，双语言一致）", async () => {
  const { ACCENTS } = await import("../src/lib/accent.ts");
  const sw = ITEMS.find((i) => i.control.kind === "switch")!;
  assert.equal(sw.key, "restoreOnLaunch");
  assert.equal(sw.group, "appearance");
  assert.equal(sw.get(S()), true, "开关默认=开（恢复上次文档）");
  assert.equal(sw.get(S(sw.set(S(), false))), false);
  assert.equal(sw.get(S(sw.set(S(), "true" as unknown as boolean))), false, "非 true 一律按关——只认布尔真");
  assert.equal(DEFAULT_SETTINGS.theme, "light", "首启默认主题=浅色");
  assert.equal(DEFAULT_SETTINGS.accent, "#1B6372", "首启默认强调色=石青浅档");
  assert.ok(ACCENTS.some((a) => a.id === "#1B6372" && a.name === "石青"), "默认强调色必须是色板内的石青");
});
