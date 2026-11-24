//! 跨语言文件名校验契约：与 TypeScript `tests/contract/filename-parity.test.ts`
//! 共享 `tests/fixtures/filename-contract.json`，防止两侧原因码或短路顺序漂移。

use folio_app_lib::commands::{validate_dir_name, validate_file_name};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Suite {
    version: u32,
    #[serde(rename = "fileCases")]
    file_cases: Vec<NameCase>,
    #[serde(rename = "dirCases")]
    dir_cases: Vec<NameCase>,
}

#[derive(Debug, Deserialize)]
struct NameCase {
    id: String,
    input: String,
    expected: String,
    normalized: Option<String>,
}

const FIXTURE: &str = include_str!("../../tests/fixtures/filename-contract.json");

fn assert_case(c: &NameCase, actual: folio_core::Result<String>, kind: &str) {
    if c.expected == "OK" {
        let got = actual.unwrap_or_else(|e| panic!("{} {}: 应通过，实际 {e:?}", c.id, kind));
        assert_eq!(
            Some(&got),
            c.normalized.as_ref(),
            "{} {}: trim 后落盘名",
            c.id,
            kind
        );
    } else {
        let err = actual
            .err()
            .unwrap_or_else(|| panic!("{} {}: 应拒绝", c.id, kind));
        assert_eq!(
            err.reason(),
            Some(c.expected.as_str()),
            "{} {}: 原因码",
            c.id,
            kind
        );
    }
}

#[test]
fn filename_contract_matches_shared_fixture() {
    let suite: Suite = serde_json::from_str(FIXTURE).expect("fixture JSON 可解析");
    assert_eq!(suite.version, 1);
    for c in &suite.file_cases {
        assert_case(c, validate_file_name(&c.input), "file");
    }
    for c in &suite.dir_cases {
        assert_case(c, validate_dir_name(&c.input), "dir");
    }
}
