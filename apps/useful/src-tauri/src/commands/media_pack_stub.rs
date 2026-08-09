//! Core edition stubs for MediaPack management.

use super::{CmdError, CmdResult};
use crate::state::AppState;
use tauri::State;

fn unavailable() -> CmdError {
    CmdError::from("MediaPack 能力未包含在此 edition（Core）中")
}

#[tauri::command]
pub async fn media_pack_catalog(_state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    Err(unavailable())
}

#[tauri::command]
pub async fn media_pack_install(
    _app: tauri::AppHandle,
    _state: State<'_, AppState>,
    _pack_id: String,
) -> CmdResult<String> {
    Err(unavailable())
}

#[tauri::command]
pub fn media_pack_cancel(_state: State<AppState>, _task_id: String) -> CmdResult<()> {
    Err(unavailable())
}

#[tauri::command]
pub fn media_pack_rollback(_state: State<AppState>, _pack_id: String) -> CmdResult<()> {
    Err(unavailable())
}
