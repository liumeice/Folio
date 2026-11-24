//! 跨语言 Markdown 契约：与 TypeScript `tests/contract/markdown-parity.test.ts`
//! 读同一份 `tests/fixtures/markdown-contract.json`。任何一侧口径变化都必须让这份夹具
//! 先失败，而不是让两侧各自改期望值后继续漂移。

use folio_core::markdown::{headings, stats, toggle_task};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Suite {
    version: u32,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    description: String,
    src: String,
    #[serde(rename = "wordCount")]
    word_count: i64,
    #[serde(rename = "headCount")]
    head_count: i64,
    #[serde(rename = "secCount")]
    sec_count: i64,
    headings: Vec<HeadingVec>,
    tasks: Vec<TaskVec>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct HeadingVec {
    sec: i64,
    level: i64,
    text: String,
    line: i64,
}

#[derive(Debug, Deserialize)]
struct TaskVec {
    nth: usize,
    expected: String,
}

const FIXTURE: &str = include_str!("../../../tests/fixtures/markdown-contract.json");

#[test]
fn markdown_contract_matches_shared_fixture() {
    let suite: Suite = serde_json::from_str(FIXTURE).expect("fixture JSON 可解析");
    assert_eq!(suite.version, 1, "夹具 schema 版本");

    for c in &suite.cases {
        let label = format!("{} {}", c.id, c.description);

        let got: Vec<HeadingVec> = headings(&c.src)
            .into_iter()
            .map(|h| HeadingVec {
                sec: h.sec,
                level: h.level,
                text: h.text,
                line: h.line,
            })
            .collect();
        assert_eq!(got, c.headings, "{label}: headings");

        let (words, heads, secs) = stats(&c.src);
        assert_eq!(words, c.word_count, "{label}: wordCount");
        assert_eq!(heads, c.head_count, "{label}: headCount");
        assert_eq!(secs, c.sec_count, "{label}: secCount");

        for t in &c.tasks {
            let out = toggle_task(&c.src, t.nth)
                .unwrap_or_else(|| panic!("{label}: 第 {} 个任务应可翻转", t.nth));
            assert_eq!(out, t.expected, "{label}: task #{}", t.nth);
        }
        assert!(
            toggle_task(&c.src, c.tasks.len()).is_none(),
            "{label}: 任务序号越界必须返回 None"
        );
    }
}
