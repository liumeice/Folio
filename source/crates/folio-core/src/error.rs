use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("io error: {0}")]
    Io(String),
    #[error("database error: {0}")]
    Db(String),
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("unsupported file type: {0}")]
    Unsupported(String),
    #[error("invalid argument: {0}")]
    Invalid(String),
    #[error("internal: {0}")]
    Internal(String),
}

/// 文件名校验/冲突子码（design §4.7.2 附录 B.2）：Invalid 携带这些码时映射为 `reason`，
/// 供前端查 `error.invalid.<reason>` / `filename.error.<reason>` 文案。
/// `CONFLICT` 特殊：code 单列为 `conflict`（保存覆盖判据），reason 仍为 `CONFLICT`。
const REASON_CODES: [&str; 8] = [
    "EMPTY",
    "ILLEGAL_CHARS",
    "BAD_END",
    "TOO_LONG",
    "BAD_EXT",
    "EXISTS",
    "NO_DIR",
    "CONFLICT",
];

impl CoreError {
    /// 稳定错误码（附录 B.1），前端据此判断与翻译；与 `Display`（英文日志串）解耦。
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Io(_) => "io",
            CoreError::Db(_) => "db",
            CoreError::NotFound(_) => "not_found",
            CoreError::Unsupported(_) => "unsupported",
            CoreError::Invalid(s) if s == "CONFLICT" => "conflict",
            CoreError::Invalid(_) => "invalid",
            CoreError::Internal(_) => "internal",
        }
    }

    /// 子原因码：仅当 Invalid 携带附录 B.2 的已知码时给出，其余为 None。
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            CoreError::Invalid(s) => REASON_CODES.iter().find(|c| *c == s).copied(),
            _ => None,
        }
    }
}

/// 让命令层可以把任意错误串到前端
impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        CoreError::Io(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    fn cr(code: &str, err: CoreError) {
        assert_eq!(err.code(), code, "code({err:?})");
    }

    #[test]
    fn variant_codes() {
        cr("io", CoreError::Io("x".into()));
        cr("db", CoreError::Db("x".into()));
        cr("not_found", CoreError::NotFound("p".into()));
        cr("unsupported", CoreError::Unsupported("p".into()));
        cr("internal", CoreError::Internal("x".into()));
    }

    #[test]
    fn invalid_reason_codes_map_to_invalid_with_reason() {
        for c in ["EMPTY", "ILLEGAL_CHARS", "BAD_END", "TOO_LONG", "BAD_EXT", "EXISTS", "NO_DIR"] {
            let e = CoreError::Invalid(c.into());
            assert_eq!(e.code(), "invalid");
            assert_eq!(e.reason(), Some(c));
        }
    }

    #[test]
    fn conflict_is_its_own_code() {
        let e = CoreError::Invalid("CONFLICT".into());
        assert_eq!(e.code(), "conflict");
        assert_eq!(e.reason(), Some("CONFLICT"));
    }

    #[test]
    fn free_form_invalid_has_no_reason() {
        let e = CoreError::Invalid("nth < 0".into());
        assert_eq!(e.code(), "invalid");
        assert_eq!(e.reason(), None);
        // 非纯大写 / 未收录的码不算 reason
        let e2 = CoreError::Invalid("exists".into());
        assert_eq!(e2.code(), "invalid");
        assert_eq!(e2.reason(), None);
        // 只有 Invalid 能带 reason
        assert_eq!(CoreError::Io("EXISTS".into()).reason(), None);
    }

    #[test]
    fn display_unchanged_for_logs() {
        // Display 保持英文原样（日志口径），code/reason 是并行通道
        assert_eq!(CoreError::NotFound("C:\\a.md".into()).to_string(), "file not found: C:\\a.md");
        assert_eq!(CoreError::Invalid("EXISTS".into()).to_string(), "invalid argument: EXISTS");
    }
}
