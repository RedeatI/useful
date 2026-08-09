//! Core edition stubs: process monitor is not linked.

use super::{CmdError, CmdResult};
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcmonStats {
    pub running: bool,
    pub paused: bool,
    pub backend_sampling_ms: f64,
    pub process_count: u32,
    pub net_available: bool,
    pub network: serde_json::Value,
    pub gpu_available: bool,
    pub process_control_available: bool,
    pub last_delta_added: u32,
    pub last_delta_updated: u32,
    pub last_delta_removed: u32,
}

#[derive(Default)]
pub struct ProcmonState;

fn unavailable() -> CmdError {
    CmdError::from("进程监视器未包含在此 edition（Core）中")
}

#[tauri::command]
pub fn procmon_start(_app: tauri::AppHandle, _state: State<AppState>) -> CmdResult<()> {
    Err(unavailable())
}

#[tauri::command]
pub fn procmon_stop(_state: State<AppState>) -> CmdResult<()> {
    Err(unavailable())
}

#[tauri::command]
pub fn procmon_set_paused(_state: State<AppState>, _paused: bool) -> CmdResult<()> {
    Err(unavailable())
}

#[tauri::command]
pub fn procmon_stats(_state: State<AppState>) -> CmdResult<ProcmonStats> {
    Err(unavailable())
}

#[tauri::command]
pub fn kill_process(_pid: u32, _start_time: u64) -> CmdResult<()> {
    Err(CmdError::from(
        "当前版本仅支持只读进程监控，不提供结束进程或结束进程树能力",
    ))
}

#[tauri::command]
pub fn kill_process_tree(_pid: u32, _start_time: u64) -> CmdResult<()> {
    Err(CmdError::from(
        "当前版本仅支持只读进程监控，不提供结束进程或结束进程树能力",
    ))
}

#[tauri::command]
pub fn procmon_open_folder(_app: tauri::AppHandle, _exe_path: String) -> CmdResult<()> {
    Err(unavailable())
}
