//! Core edition stubs: media / video trim is not linked.

use super::{CmdError, CmdResult};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

/// Placeholder so AppState can still compile without useful-media.
pub struct MediaState;

impl MediaState {
    pub fn new(
        _exe_dir: &std::path::Path,
        _cache_dir: &std::path::Path,
        _media_root: &std::path::Path,
    ) -> Self {
        Self
    }
}

fn unavailable() -> CmdError {
    CmdError::from("视频裁剪/媒体能力未包含在此 edition（Core）中")
}

#[tauri::command]
pub fn media_sidecars(_state: State<AppState>) -> CmdResult<serde_json::Value> {
    Err(unavailable())
}

#[tauri::command]
pub async fn media_probe(
    _state: State<'_, AppState>,
    _path: String,
) -> CmdResult<serde_json::Value> {
    Err(unavailable())
}

#[tauri::command]
pub async fn media_detect_encoders(_state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    Err(unavailable())
}

#[tauri::command]
pub async fn media_thumbnail(
    _state: State<'_, AppState>,
    _path: String,
    _time_sec: f64,
    _width: u32,
) -> CmdResult<String> {
    Err(unavailable())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStarted {
    pub task_id: String,
}

#[tauri::command]
pub async fn media_export(
    _app: tauri::AppHandle,
    _state: State<'_, AppState>,
    _req: ExportRequest,
) -> CmdResult<ExportStarted> {
    Err(unavailable())
}

#[tauri::command]
pub fn media_cancel_export(_state: State<AppState>, _task_id: String) -> CmdResult<()> {
    Err(unavailable())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvLoadResult {
    pub ok: bool,
}

#[tauri::command]
pub fn mpv_start(
    _app: tauri::AppHandle,
    _state: State<AppState>,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
    _software: bool,
) -> CmdResult<()> {
    Err(unavailable())
}

#[tauri::command]
pub fn mpv_set_rect(
    _state: State<AppState>,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
) -> CmdResult<()> {
    Err(unavailable())
}

#[tauri::command]
pub fn mpv_load(_state: State<AppState>, _path: String) -> CmdResult<MpvLoadResult> {
    Err(unavailable())
}

#[tauri::command]
pub fn mpv_set_paused(_state: State<AppState>, _paused: bool) -> CmdResult<()> {
    Err(unavailable())
}

#[tauri::command]
pub fn mpv_seek(_state: State<AppState>, _sec: f64) -> CmdResult<()> {
    Err(unavailable())
}

#[tauri::command]
pub fn mpv_stop(_state: State<AppState>) -> CmdResult<()> {
    Err(unavailable())
}
