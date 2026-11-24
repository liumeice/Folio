//! 首启默认设置跨语言契约：与 TS `tests/contract/settings-parity.test.ts` 共享夹具。
use folio_core::Settings;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/settings-default.json");

#[test]
fn settings_default_matches_shared_fixture() {
    let golden: Value = serde_json::from_str(FIXTURE).expect("fixture JSON 可解析");
    let actual = serde_json::to_value(Settings::default()).expect("Settings 可序列化");
    assert_eq!(actual, golden);
}
