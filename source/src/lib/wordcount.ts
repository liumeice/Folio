/* 字数口径（需求方 2026-11-17 定夺）：统计跳过 公式块（$$…$$ / ```math）与 图表块（```mermaid，
 * 含首行 zenuml 的图）——这类文档的源码不是"读到的字"，计入会让字数严重虚高。
 * 普通代码围栏维持 M0 旧口径（照计，含围栏标记）；PRD 把"代码块是否计字"另列为待定项 N19。
 * 与 Rust folio-core::markdown::stats 的 word_count 逐行同规则（权威=两侧各自的钉桩测试，
 * fixture 数值必须一致：tests/wordcount.test.ts ↔ markdown.rs::tests）。 */

import { fenceClose, fenceInfo, fenceOpen, splitSrcLines, type Fence } from "./md.ts";

const MATH_FENCE_RE = /^\s*\$\$\s*$/;

/** 围栏语言是否"非正文块"（math/mermaid，大小写不敏感；info 取首词，裸关闭返回 false；
 *  与 Rust markdown.rs is_skipped_fence/fence_info 同口径——2026-11-21 第二档） */
function isSkippedFence(line: string): boolean {
  const w = fenceInfo(line).toLowerCase();
  return w === "math" || w === "mermaid";
}

/* 性能审查 v3.0 P1-2：字数在首屏被算两遍——Reader.tsx 的 .sub 行与 SidePanels 状态栏都调
 * countWords(同一 doc.src)。加单槽引用记忆：两处调用命中的是同一字符串引用（current() 与
 * Reader 的 curDoc 同源），=== 走指针相等即刻返回，省掉第二遍 ~25ms 全量扫描。
 * 只缓存最后一份 src：任何输入仍返回正确值（无脏读），内存上限一份正文。 */
let memoSrc: string | null = null;
let memoVal = 0;

export function countWords(src: string): number {
  if (src === memoSrc) return memoVal;
  const n = countWordsRaw(src);
  memoSrc = src;
  memoVal = n;
  return n;
}

function countWordsRaw(src: string): number {
  const lines = splitSrcLines(src); // P2：裸 CR/NUL 输入预处理与 md.ts、Rust normalize() 同源
  const kept: string[] = [];
  let fence: Fence | null = null;
  let codeSkipped = false;
  let inMath = false;
  for (const ln of lines) {
    if (fence) {
      if (fenceClose(ln, fence)) { // 闭栏：同字符且长度 ≥ 开栏（↔ Rust prose_chars，2026-11-21 第二档配对）
        fence = null;
        if (!codeSkipped) kept.push(ln);
      } else if (!codeSkipped) {
        kept.push(ln);
      }
      continue;
    }
    if (!inMath) {
      const fo = fenceOpen(ln); // 开栏（``` 与 ~~~）：判定跳过与否
      if (fo) {
        fence = fo;
        codeSkipped = isSkippedFence(ln);
        if (!codeSkipped) kept.push(ln); // 普通代码块的围栏标记照旧计入
        continue;
      }
    }
    if (MATH_FENCE_RE.test(ln)) { inMath = !inMath; continue; } // $$ 开/闭界行本身不计（必须 toggle！漏关会吞掉全文）
    if (inMath) continue;
    kept.push(ln);
  }
  // 码点计数（非 UTF-16 单元）：与 Rust src.chars().count() 同基——emoji 两侧都算 1
  return [...kept.join("\n").replace(/\s/g, "")].length;
}
