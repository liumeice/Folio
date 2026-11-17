/* 字数口径（需求方 2026-11-17 定夺）：统计跳过 公式块（$$…$$ / ```math）与 图表块（```mermaid，
 * 含首行 zenuml 的图）——这类文档的源码不是"读到的字"，计入会让字数严重虚高。
 * 普通代码围栏维持 M0 旧口径（照计，含围栏标记）；PRD 把"代码块是否计字"另列为待定项 N19。
 * 与 Rust folio-core::markdown::stats 的 word_count 逐行同规则（权威=两侧各自的钉桩测试，
 * fixture 数值必须一致：tests/wordcount.test.ts ↔ markdown.rs::tests）。 */

const FENCE_RE = /^\s*```/;
const MATH_FENCE_RE = /^\s*\$\$\s*$/;

/** 围栏语言是否"非正文块"（math/mermaid，大小写不敏感；``` 裸关闭返回 false） */
function isSkippedFence(line: string): boolean {
  const body = line.trim().slice(3).trim().toLowerCase();
  return body === "math" || body === "mermaid";
}

export function countWords(src: string): number {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let inCode = false;
  let codeSkipped = false;
  let inMath = false;
  for (const ln of lines) {
    if (!inCode && !inMath && FENCE_RE.test(ln)) { // ``` 开栏：判定跳过与否
      inCode = true;
      codeSkipped = isSkippedFence(ln);
      if (!codeSkipped) kept.push(ln); // 普通代码块的围栏标记照旧计入
      continue;
    }
    if (inCode) {
      if (FENCE_RE.test(ln)) { // 闭栏（与 Rust is_fence 同判定）
        inCode = false;
        if (!codeSkipped) kept.push(ln);
      } else if (!codeSkipped) {
        kept.push(ln);
      }
      continue;
    }
    if (MATH_FENCE_RE.test(ln)) { inMath = !inMath; continue; } // $$ 开/闭界行本身不计（必须 toggle！漏关会吞掉全文）
    if (inMath) continue;
    kept.push(ln);
  }
  // 码点计数（非 UTF-16 单元）：与 Rust src.chars().count() 同基——emoji 两侧都算 1
  return [...kept.join("\n").replace(/\s/g, "")].length;
}
