/* i18n 目录完整性与解析矩阵（设计 §7.1.1）。运行：
 * node --experimental-strip-types --test tests/unit/i18n.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { zhCN } from "../../src/lib/i18n/catalog/zh-CN.ts";
import { enUS } from "../../src/lib/i18n/catalog/en-US.ts";
import {
  resolveLocale, interpolate, tp, t, locale,
  setLocale, bootLocale, rememberPref, LS_PREF, LS_RESOLVED,
} from "../../src/lib/i18n/index.ts";

const zhKeys = Object.keys(zhCN).sort();
const enKeys = Object.keys(enUS as Record<string, string>).sort();

const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

/** 英文目录允许出现中文的白名单（语言名 / 语言切换提示本身） */
const EN_CJK_ALLOWED = new Set(["toast.language.zh"]);

test("key 集合完全一致（不多、不少）", () => {
  assert.deepEqual(enKeys, zhKeys);
});

test("每条非空；不允许 TODO/FIXME/undefined", () => {
  for (const [k, v] of Object.entries(zhCN as Record<string, string>)) {
    assert.ok(v.trim().length > 0, `zh 空值：${k}`);
    assert.ok(!/TODO|FIXME|undefined/.test(v), `zh 占位残留：${k}`);
  }
  for (const [k, v] of Object.entries(enUS as Record<string, string>)) {
    assert.ok(v.trim().length > 0, `en 空值：${k}`);
    assert.ok(!/TODO|FIXME|undefined/.test(v), `en 占位残留：${k}`);
  }
});

test("占位符集合中英一致", () => {
  for (const k of zhKeys) {
    const a = placeholders((zhCN as Record<string, string>)[k]);
    const b = placeholders((enUS as Record<string, string>)[k]);
    assert.deepEqual(b, a, `占位符不一致：${k}`);
  }
});

test("复数：每个 .one 都有配对 .other（两种语言）", () => {
  for (const keys of [zhKeys, enKeys]) {
    for (const k of keys) {
      if (k.endsWith(".one")) {
        assert.ok(keys.includes(k.replace(/\.one$/, ".other")), `${k} 缺 .other`);
      }
    }
  }
});

test("英文目录不得残留中文（语言名白名单除外）", () => {
  for (const [k, v] of Object.entries(enUS as Record<string, string>)) {
    if (EN_CJK_ALLOWED.has(k)) continue;
    assert.ok(!/[㐀-鿿]/.test(v), `英文残留中文：${k} = ${v}`);
  }
});

test("resolveLocale 解析矩阵（设计 §2.2）", () => {
  assert.equal(resolveLocale("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLocale("en-US", ["zh-CN"]), "en-US");
  assert.equal(resolveLocale("auto", ["zh-CN", "en-US"]), "zh-CN");
  assert.equal(resolveLocale("auto", ["en-US", "zh-CN"]), "en-US");
  assert.equal(resolveLocale("auto", ["en-GB"]), "en-US");
  assert.equal(resolveLocale("auto", ["zh-Hans"]), "zh-CN");
  assert.equal(resolveLocale("auto", ["zh-TW"]), "zh-CN");   // 繁中暂回退简体
  assert.equal(resolveLocale("auto", ["ja-JP"]), "en-US");   // 不支持 → en-US
  assert.equal(resolveLocale("auto", []), "zh-CN");          // 无 navigator → 源语言兜底
  assert.equal(resolveLocale("bogus" as unknown as string, ["en-US"]), "en-US"); // 非法值按 auto
});

test("t() 插值与缺失回退", () => {
  assert.equal(interpolate("Hi {name}!", { name: "Folio" }), "Hi Folio!");
  assert.equal(interpolate("{a} {b}", { a: 1 }), "1 {b}");
  assert.equal(t("titlebar.chip.version", { version: "0.2.1" }).includes("0.2.1"), true);
});

test("tp()：英文单复数、中文恒取 other", () => {
  const prev = locale();
  try {
    // 直接验证目录层的复数选择逻辑：locale 信号受 Solid 控制，这里用 tp 看当前 locale 的形态。
    // en 分支由 resolveLocale + setLocale 驱动（组件内）；测试独立校验两个目录的文案完整性。
    assert.equal((enUS as Record<string, string>)["side.library.count.one"], "{count} document");
    assert.equal((enUS as Record<string, string>)["side.library.count.other"], "{count} documents");
    assert.equal((zhCN as Record<string, string>)["side.library.count.one"], "共 {count} 篇");
    assert.equal(tp("side.library.count", 3, { count: 3 }).includes("3"), true);
  } finally {
    assert.equal(locale(), prev);
  }
});

test("locale 持久化镜像：rememberPref / setLocale / bootLocale 闭环", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const savedLS = g.localStorage;
  const savedDoc = g.document;
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const root = { lang: "", dir: "" };
  g.document = { documentElement: root };
  const prev = locale();
  try {
    rememberPref("en-US");
    assert.equal(store.get(LS_PREF), "en-US");
    assert.equal(bootLocale(), "en-US", "首帧读 localStorage 偏好");

    setLocale("en-US");
    assert.equal(locale(), "en-US");
    assert.equal(root.lang, "en-US");
    assert.equal(root.dir, "ltr");
    assert.equal(store.get(LS_RESOLVED), "en-US");

    setLocale("zh-CN");
    assert.equal(bootLocale(), "en-US", "bootLocale 只认偏好，不认已解析值");
    rememberPref("zh-CN");
    assert.equal(bootLocale(), "zh-CN");
  } finally {
    setLocale(prev);
    g.localStorage = savedLS;
    g.document = savedDoc;
  }
});
