/* 文档主语言轻量判定（设计 §4.6.6）：只用于 <article lang> / 导出 HTML 的 lang，
 * 不参与翻译与搜索分词。判据是启发式：剔除代码围栏、行内代码、公式与链接 URL 后，
 * 统计 CJK 与拉丁字母占比；无法判断返回 null（调用方不加 lang）。 */
export type ContentLang = "zh-CN" | "en-US" | null;

/** 去掉围栏代码块（``` / ~~~）、行内代码、$$ 公式块、链接/图片 URL，保留正文文字 */
export function stripNonProse(src: string): string {
  let s = src.replace(/^---[\s\S]*?\n---[ \t]*$/m, "");            // front matter
  s = s.replace(/^(```|~~~)[\s\S]*?^\1[ \t]*$/gm, "");             // 围栏代码（同字符闭合）
  s = s.replace(/\$\$[\s\S]*?\$\$/g, "");                          // 块公式
  s = s.replace(/`[^`\n]*`/g, "");                                  // 行内代码
  s = s.replace(/\]\([^)\s]+\)/g, "]");                             // 链接/图片目标
  s = s.replace(/https?:\/\/\S+/g, "");                             // 裸 URL
  return s;
}

export function detectContentLang(src: string): ContentLang {
  const text = stripNonProse(src);
  let cjk = 0, latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
  }
  const total = cjk + latin;
  if (total < 8) return null;                       // 空文档/纯代码/纯符号：不判
  if (cjk >= latin * 0.6) return "zh-CN";           // 中文占显著比例（混排中文为主）
  if (latin >= cjk * 4) return "en-US";             // 拉丁为主
  return null;                                       // 中英接近：不硬判
}