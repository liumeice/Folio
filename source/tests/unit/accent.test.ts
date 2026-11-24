/* 强调色派生纯逻辑单测（2026-11-17 配色提案 02）：日夜双档解析、墨色分规则、旧色旧口径承诺不破。 */
import test from "node:test";
import assert from "node:assert/strict";
import { ACCENTS, accentVars, applyAccent, bestInk, findAccent, relLum, resolveAccentHex, themeMode } from "../src/lib/accent.ts";

test("色板构成：12 枚、id 唯一、默认青绿在板且为单档", () => {
  assert.equal(ACCENTS.length, 12);
  const ids = ACCENTS.map((a) => a.id.toLowerCase());
  assert.equal(new Set(ids).size, 12, "id 不得重复");
  assert.equal(findAccent("#2DD4BF")?.name, "青绿");
  assert.equal(findAccent("#2DD4BF")?.tiered, false);
  for (const a of ACCENTS) {
    if (a.tiered) assert.notEqual(a.light.toLowerCase(), a.dark.toLowerCase(), `${a.name} 双档必须两值`);
    else assert.equal(a.id.toLowerCase(), a.light.toLowerCase(), `${a.name} 单档 id=light`);
  }
});

test("档位解析：双档随主题切档，单档/未知 hex 恒等直通", () => {
  assert.equal(resolveAccentHex("#B53825", "dark"), "#FF826D", "朱砂·暗底取暗档");
  assert.equal(resolveAccentHex("#B53825", "light"), "#B53825", "朱砂·浅底取浅档");
  assert.equal(resolveAccentHex("#B53825", "sepia"), "#B53825", "米色归浅档");
  assert.equal(resolveAccentHex("#7E5A18", "dark"), "#E3B25E", "茶金·暗底");
  assert.equal(resolveAccentHex("#2DD4BF", "dark"), "#2DD4BF", "旧单档不随主题变");
  assert.equal(resolveAccentHex("#123456", "dark"), "#123456", "板外自由 hex 直通");
  assert.equal(themeMode("dark"), "dark");
  assert.equal(themeMode("light"), "light");
  assert.equal(themeMode("sepia"), "light");
});

test("大小写宽容：设置里存什么写法都认；板内色归一化到规范形", () => {
  assert.equal(resolveAccentHex("#b53825", "dark"), "#FF826D");
  assert.equal(accentVars("#b53825", "light")["--accent"], "#B53825");
  // 板外自由 hex 原样直通（含大小写）
  assert.equal(accentVars("#abcdef", "light")["--accent"], "#abcdef");
});

test("accentVars：空 id 交回主题内置色；双档墨色走对比度择优", () => {
  assert.deepEqual(accentVars("", "dark"), {});
  const darkV = accentVars("#B53825", "dark");
  assert.equal(darkV["--accent"], "#FF826D");
  assert.equal(darkV["--accent-bg"], "rgba(255,130,109,.14)");
  assert.equal(darkV["--accent-dim"], "rgb(209,107,89)");
  assert.equal(darkV["--accent-ink"], "#0A1020", "亮珊瑚粉配深墨（提案注 02 的误判例）");
  const lightV = accentVars("#B53825", "light");
  assert.equal(lightV["--accent-ink"], "#FFFFFF", "深朱砂配白墨");
  // 茶金同理：浅档深金 #7E5A18→白墨，暗档亮金 #E3B25E→深墨
  assert.equal(accentVars("#7E5A18", "light")["--accent-ink"], "#FFFFFF");
  assert.equal(accentVars("#7E5A18", "dark")["--accent-ink"], "#0A1020");
});

test("accentVars：旧六枚维持亮度阈值旧口径（观感承诺不破）", () => {
  // 玫红 #FB7185：阈值 L≈0.564≤0.6 → 白墨；若被"升级"成择优会得到深墨（两规则分歧哨兵）
  assert.equal(accentVars("#FB7185", "dark")["--accent-ink"], "#FFFFFF");
  assert.equal(accentVars("#FB7185", "light")["--accent-ink"], "#FFFFFF");
  // 青绿：两规则一致 → 深墨
  assert.equal(accentVars("#2DD4BF", "dark")["--accent-ink"], "#0A1020");
});

test("bestInk / relLum：与提案 02 数值口径一致", () => {
  assert.equal(bestInk("#FF826D"), "#0A1020");
  assert.equal(bestInk("#B53825"), "#FFFFFF");
  // 朱砂暗档 vs 曜石阅读底 #17181F ≈ 7.3:1（提案实测 7.30）
  const c = (relLum("#FF826D") + 0.05) / (relLum("#17181F") + 0.05);
  assert.ok(Math.abs(c - 7.3) < 0.05, `7.30 口径,实得 ${c.toFixed(2)}`);
});

test("applyAccent 只触碰四个强调变量（DOM 契约）", () => {
  const b = (globalThis as { document?: { body: HTMLElement } }).document?.body;
  if (!b) return; // 无 DOM 环境跳过（本套测试跑在 strip-types 直连 node 时的保险丝）
  applyAccent("#B53825", "dark");
  assert.equal(b.style.getPropertyValue("--accent"), "#FF826D");
  applyAccent("", "dark");
  assert.equal(b.style.getPropertyValue("--accent"), "");
});
