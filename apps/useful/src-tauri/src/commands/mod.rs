//! Tauri 命令集合。

pub mod accounts;
pub mod agent_profile;
pub mod app;
pub mod app_update;
pub mod diagnostics;
pub mod downloads;
pub mod dpapi_store;
pub mod elevation;
#[cfg(feature = "media")]
pub mod media;
#[cfg(not(feature = "media"))]
#[path = "media_stub.rs"]
pub mod media;
#[cfg(feature = "media")]
pub mod media_pack;
#[cfg(not(feature = "media"))]
#[path = "media_pack_stub.rs"]
pub mod media_pack;
pub mod plugins;
#[cfg(feature = "procmon")]
pub mod procmon;
#[cfg(not(feature = "procmon"))]
#[path = "procmon_stub.rs"]
pub mod procmon;
pub mod shortcuts;
pub mod sources;
pub mod trp_sources;

use serde::Serialize;

/// 统一命令错误：转成字符串给前端展示（避免泄露内部细节结构）。
#[derive(Debug, Serialize)]
pub struct CmdError {
    pub message: String,
}

impl<E: std::fmt::Display> From<E> for CmdError {
    fn from(e: E) -> Self {
        CmdError {
            message: e.to_string(),
        }
    }
}

pub type CmdResult<T> = Result<T, CmdError>;
