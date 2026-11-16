//! Markdown 的纯函数工具：标题解析、统计口径、slug、任务清单回写。
//! 重要约定（评审 v2·N3 的教训）：**凡是要和 DOM 渲染结果对序号的解析，
//! 必须与渲染器使用同一套围栏状态机**——本模块就是唯一实现。

use std::collections::HashSet;

/// 解析出的标题（sec 自 1 起，与前端 data-sec 对齐）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    pub sec: i64,
    pub level: i64,
    pub text: String,
    /// 源文本行号，0 起
    pub line: i64,
}

fn is_fence(line: &str) -> bool {
    line.trim_start().starts_with("```")
}

/// ATX 标题提取。跳过代码围栏内部；去掉闭合 # 串。
pub fn headings(src: &str) -> Vec<Heading> {
    let mut out: Vec<Heading> = Vec::new();
    let mut in_fence = false;
    for (i, raw) in src.lines().enumerate() {
        if is_fence(raw) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let t = raw.trim_start();
        let hashes = t.chars().take_while(|c| *c == '#').count();
        if hashes == 0 || hashes > 6 {
            continue;
        }
        let rest: String = t.chars().skip(hashes).collect();
        // '#' 后必须跟空白或行尾（排除 "###tag"）
        if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
            continue;
        }
        let mut text = rest.trim().to_string();
        if text.ends_with('#') {
            let cut = text.trim_end_matches('#');
            if cut.is_empty() || cut.ends_with(' ') || cut.ends_with('\t') {
                text = cut.trim_end().to_string();
            }
        }
        out.push(Heading { sec: (out.len() + 1) as i64, level: hashes as i64, text, line: i as i64 });
    }
    out
}

/// (word_count, head_count, sec_count)。
/// M0 口径：word_count = 源文本非空白字符数（含代码块，与原型 article.textContent 对齐）；
/// head_count = 大纲条目（h1~h6）；sec_count = 小节（h2~h6）。
/// 「代码块是否计字、阅读速度常数」是正式版待定的设置项（评审 v2·N19），M1 落。
pub fn stats(src: &str) -> (i64, i64, i64) {
    let hs = headings(src);
    let word_count = src.chars().filter(|c| !c.is_whitespace()).count() as i64;
    let head_count = hs.len() as i64;
    let sec_count = hs.iter().filter(|h| h.level >= 2).count() as i64;
    (word_count, head_count, sec_count)
}

/// 列表行拆分：若该行以 "缩进 + (-|*|+|n.|n\)) + 空白" 开头，返回标记段之后的剩余切片。
/// 全程按字符迭代取字节偏移，多字节安全。
fn after_list_marker(line: &str) -> Option<&str> {
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let mut i = 0usize;
    while i < chars.len() && (chars[i].1 == ' ' || chars[i].1 == '\t') {
        i += 1;
    }
    if i >= chars.len() {
        return None;
    }
    let mut j = i;
    let c0 = chars[i].1;
    if c0 == '-' || c0 == '*' || c0 == '+' {
        j += 1;
    } else {
        let mut k = i;
        while k < chars.len() && chars[k].1.is_ascii_digit() {
            k += 1;
        }
        if k == i || k >= chars.len() || (chars[k].1 != '.' && chars[k].1 != ')') {
            return None;
        }
        j = k + 1;
    }
    if j >= chars.len() || !(chars[j].1 == ' ' || chars[j].1 == '\t') {
        return None;
    }
    while j < chars.len() && (chars[j].1 == ' ' || chars[j].1 == '\t') {
        j += 1;
    }
    if j >= chars.len() {
        return Some("");
    }
    Some(&line[chars[j].0..])
}

/// 任务行拆分：返回（'[' 之前的前缀字节长, 勾选字符, ']' 的绝对字节偏移）。
fn task_parts(line: &str) -> Option<(usize, char, usize)> {
    let body = after_list_marker(line)?;
    let bc: Vec<(usize, char)> = body.char_indices().collect();
    if bc.len() < 3 || bc[0].1 != '[' || bc[2].1 != ']' {
        return None;
    }
    let state = bc[1].1;
    if state != ' ' && state != 'x' && state != 'X' {
        return None;
    }
    let head_len = line.len() - body.len();
    Some((head_len, state, head_len + bc[2].0))
}

/// 切换第 nth 个（0 起）**围栏外**任务行的勾选状态；越界返回 None。
/// 与渲染器同坐标系：代码块里的假任务不参与计数（评审 v2·N3）。
/// 保留行尾风格（CRLF/LF）与文件末尾换行。
pub fn toggle_task(src: &str, nth: usize) -> Option<String> {
    let rows: Vec<&str> = src.lines().collect();
    let mut out_rows: Vec<String> = rows.iter().map(|s| s.to_string()).collect();
    let mut in_fence = false;
    let mut seen = 0usize;
    for (i, raw) in rows.iter().enumerate() {
        if is_fence(raw) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some((head_len, state, tail_off)) = task_parts(raw) else { continue };
        if seen == nth {
            let new_state = if state == ' ' { 'x' } else { ' ' };
            out_rows[i] = format!("{}[{}{}", &raw[..head_len], new_state, &raw[tail_off..]);
            let nl = if src.contains("\r\n") { "\r\n" } else { "\n" };
            let joined = out_rows.join(nl);
            return Some(if src.ends_with('\n') { joined + nl } else { joined });
        }
        seen += 1;
    }
    None
}

/// 文件名 → 深度链接 slug 基形：去扩展名，保留字母数字/汉字（近似码点判断），
/// 其余转 '-'，转小写。
pub fn slugify(file_name: &str) -> String {
    let stem = file_name.rsplit_once('.').map(|(s, _)| s).unwrap_or(file_name);
    let mut out = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || (c as u32) > 0x2E7F {
            out.extend(c.to_lowercase());
            continue;
        }
        if c == '-' || c == '_' || c == ' ' || c == '.' {
            if !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() { "doc".to_string() } else { out }
}

/// 在已占用集合内保证唯一：base, base-2, base-3 …
pub fn unique_slug(base: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let cand = format!("{base}-{n}");
        if !taken.contains(&cand) {
            return cand;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_skip_fences() {
        let src = "# T\n\n```md\n# 假标题\n```\n\n## 真小节 ##\n";
        let hs = headings(src);
        assert_eq!(hs.len(), 2);
        assert_eq!(hs[0].text, "T");
        assert_eq!(hs[1].text, "真小节");
        assert_eq!(hs[1].level, 2);
    }

    #[test]
    fn headings_need_space_after_hashes() {
        assert!(headings("#tag 不算标题").is_empty());
        assert_eq!(headings("#! 也不算").len(), 0);
        assert_eq!(headings("# 算").len(), 1);
    }

    #[test]
    fn stats_counts() {
        let (_w, h, s) = stats("# A\n\n文字四个字。\n\n## B\n");
        assert_eq!(h, 2);
        assert_eq!(s, 1);
    }

    #[test]
    fn toggle_task_ignores_fenced_fake() {
        let src = "- [ ] real one\n\n```text\n- [ ] fake in code\n```\n\n- [ ] real two\n";
        let out = toggle_task(src, 0).unwrap();
        assert!(out.contains("[x] real one"));
        assert!(out.contains("- [ ] fake in code"));
        let out2 = toggle_task(&out, 1).unwrap();
        assert!(out2.contains("[x] real two"));
        assert!(toggle_task(src, 2).is_none());
    }

    #[test]
    fn toggle_task_preserves_ordered_and_indent() {
        let out = toggle_task("  1. [ ] indented item\n", 0).unwrap();
        assert_eq!(out, "  1. [x] indented item\n");
    }

    #[test]
    fn toggle_task_multibyte_prefix_and_crlf() {
        // 列表标记与勾选框之间是 ASCII；行尾 CRLF 保留
        let out = toggle_task("- [ ] 中文任务\r\n正文\r\n", 0).unwrap();
        assert_eq!(out, "- [x] 中文任务\r\n正文\r\n");
    }

    #[test]
    fn toggle_task_no_trailing_newline_added() {
        assert_eq!(toggle_task("- [ ] a", 0).unwrap(), "- [x] a");
    }

    // ── 跨语言契约钉桩（审查报告 v1.0 CON-01/CON-02）：改这里的任一判定必须同步 src/lib/md.ts ──

    #[test]
    fn headings_accept_indent_and_bare_hash_reject_quote_prefix() {
        let src = "# Top\n\n  # Indented\n\n#\n\n> # Quoted\n";
        let hs = headings(src);
        assert_eq!(hs.len(), 3, "Rust 是权威口径：缩进与裸 # 计标题，引用前缀不计");
        assert_eq!(hs[2].text, "");
        assert_eq!(hs[2].sec, 3);
    }

    #[test]
    fn toggle_task_skips_quoted_tasks() {
        // 渲染器（md.ts nested 分支）必须同样不给引用块任务生成 data-task——否则序号错位勾错行
        let src = "> - [ ] quoted\n\n- [ ] real\n";
        let out = toggle_task(src, 0).unwrap();
        assert!(out.contains("> - [ ] quoted"), "引用行不许被改写");
        assert!(out.contains("- [x] real"));
        assert!(toggle_task(src, 1).is_none(), "全篇可勾选任务只有 1 个");
    }

    #[test]
    fn task_without_space_after_bracket_counts() {
        // "- [ ]x"：Rust task_parts 不要求 ] 后空白，TS 渲染器同步放宽（\s* 而非 \s+）
        let out = toggle_task("- [ ]x\n", 0).unwrap();
        assert_eq!(out, "- [x]x\n");
    }

    #[test]
    fn slug_and_unique() {
        assert_eq!(slugify("Rust Notes.md"), "rust-notes");
        assert_eq!(slugify("架构设计 v3.md"), "架构设计-v3");
        let mut taken = HashSet::new();
        taken.insert("a".to_string());
        assert_eq!(unique_slug("a", &taken), "a-2");
    }
}
