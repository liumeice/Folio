//! folio-core — 领域模型 / 错误 / 纯函数工具
//! 约定：本 crate 不做任何 IO，供 db / fs / search / app 共同依赖。

pub mod error;
pub mod markdown;
pub mod models;

pub use error::{CoreError, Result};
pub use models::*;
