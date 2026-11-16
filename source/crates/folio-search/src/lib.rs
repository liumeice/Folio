//! folio-search — 查询规划 + 片段构造（执行在 folio-db）。
//!
//! 中文检索决策（评审 v1 硬提醒）：FTS5 默认 unicode61 不分中文词，
//! 本库用 **trigram tokenizer**（SQLite ≥3.34，rusqlite bundled 满足）：
//! 任意 ≥3 字符的连续子串可 MATCH，中英混排都工作；
//! **<3 字符的查询自动降级 LIKE**，否则 trigram 必然零命中。

pub mod sections;

pub use sections::{hits_for_doc, sections, Section};

pub enum Plan {
    /// 走 FTS5 MATCH：已构造好的安全短语（双引号包裹转义后的原查询）
    Fts { match_expr: String },
    /// 走 LIKE（已做 ESCAPE 转义，并给出小写 needle 供片段构造）
    Like { pattern: String, needle: String },
}

pub fn plan(query: &str) -> Option<Plan> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    if q.chars().count() >= 3 {
        // trigram：整串作为一个短语匹配；FTS5 短语内的 " 需翻倍转义
        let escaped = q.replace('"', "\"\"");
        Some(Plan::Fts { match_expr: format!("\"{escaped}\"") })
    } else {
        // LIKE 兜底：转义 % _ \（SQL 侧配合 ESCAPE '\'）
        let mut esc = String::new();
        for c in q.chars() {
            match c {
                '%' | '_' | '\\' => {
                    esc.push('\\');
                    esc.push(c);
                }
                _ => esc.push(c),
            }
        }
        Some(Plan::Like { pattern: format!("%{esc}%"), needle: q.to_lowercase() })
    }
}

/// 用 « » 包裹命中词（大小写不敏感，前端替换成 <em>），并给出命中次数。
/// 片段窗口：首个命中前 24 字符、后 48 字符，两端截断处加省略号。
pub fn snippet(text: &str, query: &str) -> (String, i64) {
    let ql = query.trim().to_lowercase();
    if ql.is_empty() {
        return (String::new(), 0);
    }
    let tl = text.to_lowercase();
    let count = tl.match_indices(&ql).count() as i64;
    if count == 0 {
        return (String::new(), 0);
    }
    let chars: Vec<char> = text.chars().collect();
    let lchars: Vec<char> = tl.chars().collect();
    let pat: Vec<char> = ql.chars().collect();
    let Some(h) = lchars.windows(pat.len()).position(|w| w == &pat[..]) else {
        return (String::new(), 0);
    };
    let start = h.saturating_sub(24);
    let end = (h + pat.len() + 48).min(chars.len());
    let seg: String = chars[start..end].iter().collect();
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(&wrap_all(&seg, &ql));
    if end < chars.len() {
        out.push('…');
    }
    (out, count)
}

fn wrap_all(seg: &str, ql: &str) -> String {
    let segl = seg.to_lowercase();
    let mut out = String::new();
    let mut last = 0usize;
    let mut from = 0usize;
    while let Some(rel) = segl[from..].find(ql) {
        let a = from + rel;
        let b = a + ql.len();
        if !seg.is_char_boundary(a) || !seg.is_char_boundary(b) {
            from = b;
            continue;
        }
        out.push_str(&seg[last..a]);
        out.push('«');
        out.push_str(&seg[a..b]);
        out.push('»');
        last = b;
        from = b;
    }
    out.push_str(&seg[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_switches_by_length() {
        assert!(plan("   ").is_none());
        match plan("大纲") {
            Some(Plan::Like { pattern, needle }) => {
                assert_eq!(pattern, "%大纲%");
                assert_eq!(needle, "大纲");
            }
            _ => panic!("2-char query should plan LIKE"),
        }
        assert!(matches!(plan("三字符"), Some(Plan::Fts { .. })));
    }

    #[test]
    fn fts_expr_escapes_quotes() {
        match plan("说\"法\"了") {
            Some(Plan::Fts { match_expr }) => assert_eq!(match_expr, "\"说\"\"法\"\"了\""),
            _ => panic!(),
        }
    }

    #[test]
    fn like_escapes_wildcards() {
        // 仅 <3 字符走 LIKE；通配符需按 ESCAPE '\' 转义
        match plan("a%") {
            Some(Plan::Like { pattern, .. }) => assert_eq!(pattern, "%a\\%%"),
            other => panic!("expected LIKE, got {}", matches!(other, Some(Plan::Fts { .. }))),
        }
        match plan("a_") {
            Some(Plan::Like { pattern, .. }) => assert_eq!(pattern, "%a\\_%"),
            _ => panic!(),
        }
        // ≥3 字符含 % 走 FTS：trigram 天然把 % 当字面量，无需转义
        assert!(matches!(plan("a%b"), Some(Plan::Fts { .. })));
    }

    #[test]
    fn snippet_wraps_and_counts_case_insensitive() {
        let (s, c) = snippet("Folio 是 folio 阅读器，folio 好用", "folio");
        assert_eq!(c, 3);
        assert_eq!(s.matches('«').count(), 3);
    }

    #[test]
    fn snippet_cjk_window_and_ellipsis() {
        let long = "前".repeat(60) + "大纲联动" + &"后".repeat(60);
        let (s, c) = snippet(&long, "大纲");
        assert_eq!(c, 1);
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.contains("«大纲»"));
    }

    #[test]
    fn snippet_empty_and_miss() {
        assert_eq!(snippet("abc", "").0, "");
        assert_eq!(snippet("abc", "zz").1, 0);
    }
}
