//! 文档分块与命中装配：FTS 只负责圈定文档，片段/分组数据在这里从源文本现算。
//! 单点真相 = 磁盘文件（索引可能滞后，编辑后不会读到旧片段）。

use folio_core::{markdown::headings, SearchHit};

pub struct Section {
    /// 所属标题文本；文档开头（首个标题前）为 ""
    pub sec: String,
    /// 所属标题的 data-sec 序号；开头块为 None
    pub anchor: Option<i64>,
    /// 该节正文（不含标题行）
    pub body: String,
    /// 该节标题文本（供标题命中）
    pub title: String,
    pub is_doc_start: bool,
}

/// 按标题切分文档（与 headings 同一围栏状态机）
pub fn sections(src: &str) -> Vec<Section> {
    let hs = headings(src);
    let lines: Vec<&str> = src.lines().collect();
    let mut out = Vec::new();
    if hs.is_empty() {
        return vec![Section {
            sec: String::new(),
            anchor: None,
            body: lines.join("\n"),
            title: String::new(),
            is_doc_start: true,
        }];
    }
    let first = hs[0].line.max(0) as usize;
    if first > 0 {
        let prelude = lines[..first].join("\n");
        if !prelude.trim().is_empty() {
            out.push(Section {
                sec: String::new(),
                anchor: None,
                body: prelude,
                title: String::new(),
                is_doc_start: true,
            });
        }
    }
    for (idx, h) in hs.iter().enumerate() {
        let start = h.line.max(0) as usize + 1;
        let end = hs.get(idx + 1).map(|n| n.line.max(0) as usize).unwrap_or(lines.len());
        let body = if start < end { lines[start..end].join("\n") } else { String::new() };
        out.push(Section {
            sec: h.text.clone(),
            anchor: Some(h.sec),
            body,
            title: h.text.clone(),
            is_doc_start: false,
        });
    }
    out
}

/// 对单文档源文本产出命中列表（按出现顺序；标题命中在前，正文命中在后）。
pub fn hits_for_doc(
    doc_id: i64,
    doc_path: &str,
    doc_title: &str,
    src: &str,
    query: &str,
    limit: usize,
) -> Vec<SearchHit> {
    let mut hits: Vec<SearchHit> = Vec::new();
    for sec in sections(src) {
        if hits.len() >= limit {
            break;
        }
        if !sec.is_doc_start {
            let (snip, count) = crate::snippet(&sec.title, query);
            if count > 0 {
                hits.push(SearchHit {
                    doc_id,
                    doc_path: doc_path.to_string(),
                    doc_title: doc_title.to_string(),
                    sec: sec.sec.clone(),
                    sec_anchor: sec.anchor,
                    snippet: snip,
                    count,
                    is_heading: true,
                });
            }
        }
        let (snip, count) = crate::snippet(&sec.body, query);
        if count > 0 {
            hits.push(SearchHit {
                doc_id,
                doc_path: doc_path.to_string(),
                doc_title: doc_title.to_string(),
                sec: sec.sec.clone(),
                sec_anchor: sec.anchor,
                snippet: snip,
                count,
                is_heading: false,
            });
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prelude_and_sections() {
        let src = "开头段落\n\n# T\n\nt1\n\n## S\n\ns1\n";
        let ss = sections(src);
        assert_eq!(ss.len(), 3);
        assert!(ss[0].is_doc_start && ss[0].body.contains("开头段落"));
        assert_eq!(ss[1].title, "T");
        assert_eq!(ss[2].sec, "S");
        assert_eq!(ss[2].anchor, Some(2));
    }

    #[test]
    fn heading_hit_precedes_body_hit() {
        let src = "# 大纲\n\n这里讲大纲和大纲。\n";
        let hits = hits_for_doc(1, "p.md", "doc", src, "大纲", 10);
        assert_eq!(hits.len(), 2);
        assert!(hits[0].is_heading);
        assert_eq!(hits[0].sec, "大纲");
        assert!(!hits[1].is_heading);
    }

    #[test]
    fn limit_respected() {
        let src = "# a\n\nx\n\n# b\n\nx\n\n# c\n\nx\n";
        let hits = hits_for_doc(1, "p", "d", src, "x", 2);
        assert_eq!(hits.len(), 2);
    }
}
