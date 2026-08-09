//! 进程监视器命令：后台 1 秒采样线程 + 每秒差量事件。
//! 首发版本仅提供只读监控；历史结束进程命令保留稳定 ABI，但始终 fail closed。
//!
//! 采样器（含 PDH/ETW 原生句柄，!Send）完全存活于后台线程内，不进入 Tauri 托管状态。

use super::{CmdError, CmdResult};
use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{Emitter, State};
use useful_procmon::diff::{build_map, diff, SnapshotMap};
use useful_procmon::sampler::Sampler;
use useful_procmon::NetworkSnapshot;

const PROCESS_CONTROL_DISABLED: &str = "当前版本仅支持只读进程监控，不提供结束进程或结束进程树能力";

/// 后台采样统计，供开发者性能面板读取。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcmonStats {
    pub running: bool,
    pub paused: bool,
    pub backend_sampling_ms: f64,
    pub process_count: u32,
    pub net_available: bool,
    pub network: NetworkSnapshot,
    pub gpu_available: bool,
    pub process_control_available: bool,
    pub last_delta_added: u32,
    pub last_delta_updated: u32,
    pub last_delta_removed: u32,
}

/// 进程监视器运行状态（仅控制原语，均 Send+Sync）。
#[derive(Default)]
pub struct ProcmonState {
    running: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    network_reset: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    stats: Arc<Mutex<ProcmonStats>>,
}

#[tauri::command]
pub fn procmon_start(app: tauri::AppHandle, state: State<AppState>) -> CmdResult<()> {
    let mut pm = state
        .procmon
        .lock()
        .map_err(|_| CmdError::from("锁定采样器失败"))?;
    if pm.running.load(Ordering::SeqCst) {
        return Ok(());
    }
    pm.running.store(true, Ordering::SeqCst);
    pm.paused.store(false, Ordering::SeqCst);
    pm.network_reset.store(false, Ordering::SeqCst);

    let running = pm.running.clone();
    let paused = pm.paused.clone();
    let network_reset = pm.network_reset.clone();
    let stats = pm.stats.clone();

    let handle = std::thread::Builder::new()
        .name("procmon-sampler".into())
        .spawn(move || {
            // 采样器在本线程内构造与销毁（含 !Send 的原生句柄）
            let mut sampler = Sampler::new();
            {
                let mut s = stats.lock().unwrap();
                s.running = true;
                s.net_available = sampler.net_available();
                s.gpu_available = sampler.gpu_available();
            }
            // 首次采样建立 CPU 基线
            let base = sampler.sample();
            let mut prev: SnapshotMap = build_map(base);
            {
                let mut s = stats.lock().unwrap();
                s.network = sampler.network_snapshot().clone();
            }

            // 立即向前端推送全量基线：以空表为基准 diff → added = 全部进程。
            // 否则前端从空表起步，只会收到它不认识的 updated（applyDelta 对未知 key 的
            // updated 直接忽略），表现为“只显示极少进程”。CPU 首帧为基线值（≈0），
            // 随后每秒的 updated 带来真实占用——与系统任务管理器行为一致。
            let initial = diff(&SnapshotMap::new(), &prev);
            {
                let mut s = stats.lock().unwrap();
                s.process_count = prev.len() as u32;
                s.last_delta_added = initial.added.len() as u32;
            }
            let _ = app.emit("procmon-delta", &initial);

            let mut was_paused = false;
            while running.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                // Atomic transition flag also catches a pause+resume pair shorter than one tick.
                if network_reset.swap(false, Ordering::SeqCst) {
                    let network = sampler.reset_network();
                    if let Ok(mut s) = stats.lock() {
                        s.network = network;
                    }
                    was_paused = paused.load(Ordering::SeqCst);
                    continue;
                }
                match pause_action(paused.load(Ordering::SeqCst), &mut was_paused) {
                    PauseAction::Drain => {
                        let network = sampler.reset_network();
                        if let Ok(mut s) = stats.lock() {
                            s.network = network;
                        }
                        continue;
                    }
                    PauseAction::Sample => {}
                }
                if paused.load(Ordering::SeqCst) {
                    continue;
                }
                let snaps = sampler.sample();
                let count = snaps.len() as u32;
                let next = build_map(snaps);
                let delta = diff(&prev, &next);
                prev = next;

                {
                    let mut s = stats.lock().unwrap();
                    s.backend_sampling_ms = sampler.last_sample_ms;
                    s.process_count = count;
                    s.last_delta_added = delta.added.len() as u32;
                    s.last_delta_updated = delta.updated.len() as u32;
                    s.last_delta_removed = delta.removed.len() as u32;
                    s.network = sampler.network_snapshot().clone();
                }

                // 发送差量（即使无变更也发，便于前端心跳；空差量开销极小）
                let _ = app.emit("procmon-delta", &delta);
            }

            if let Ok(mut s) = stats.lock() {
                s.running = false;
            }
        });

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            pm.running.store(false, Ordering::SeqCst);
            return Err(CmdError::from(error.to_string()));
        }
    };

    pm.handle = Some(handle);
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PauseAction {
    Sample,
    Drain,
}

fn pause_action(paused: bool, was_paused: &mut bool) -> PauseAction {
    if paused {
        *was_paused = true;
        PauseAction::Drain
    } else if *was_paused {
        // Resume establishes a fresh ETW/interface baseline; sample on the next full interval.
        *was_paused = false;
        PauseAction::Drain
    } else {
        PauseAction::Sample
    }
}

#[tauri::command]
pub fn procmon_stop(state: State<AppState>) -> CmdResult<()> {
    let mut pm = state
        .procmon
        .lock()
        .map_err(|_| CmdError::from("锁定采样器失败"))?;
    pm.running.store(false, Ordering::SeqCst);
    if let Some(h) = pm.handle.take() {
        // 不在锁内 join 过久：采样循环最多 1s 后退出
        drop(pm);
        let _ = h.join();
    }
    Ok(())
}

/// 暂停/恢复采样（不销毁线程与基线）。
#[tauri::command]
pub fn procmon_set_paused(state: State<AppState>, paused: bool) -> CmdResult<()> {
    let pm = state
        .procmon
        .lock()
        .map_err(|_| CmdError::from("锁定采样器失败"))?;
    pm.paused.store(paused, Ordering::SeqCst);
    pm.network_reset.store(true, Ordering::SeqCst);
    if let Ok(mut s) = pm.stats.lock() {
        s.paused = paused;
    }
    Ok(())
}

#[tauri::command]
pub fn procmon_stats(state: State<AppState>) -> CmdResult<ProcmonStats> {
    let pm = state
        .procmon
        .lock()
        .map_err(|_| CmdError::from("锁定采样器失败"))?;
    let s = pm
        .stats
        .lock()
        .map_err(|_| CmdError::from("锁定统计失败"))?;
    Ok(s.clone())
}

/// 历史 ABI：首发版本不提供结束进程能力，始终返回稳定的只读错误。
#[tauri::command]
pub fn kill_process(pid: u32, start_time: u64) -> CmdResult<()> {
    kill_verified(pid, start_time, false)
}

/// 历史 ABI：首发版本不提供结束进程树能力，始终返回稳定的只读错误。
#[tauri::command]
pub fn kill_process_tree(pid: u32, start_time: u64) -> CmdResult<()> {
    kill_verified(pid, start_time, true)
}

/// 打开进程所在文件夹（在资源管理器中定位可执行文件）。
#[tauri::command]
pub fn procmon_open_folder(app: tauri::AppHandle, exe_path: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let path = std::path::Path::new(&exe_path);
    let folder = path
        .parent()
        .ok_or_else(|| CmdError::from("无法解析所在文件夹"))?;
    app.opener()
        .open_path(folder.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| CmdError::from(e.to_string()))?;
    Ok(())
}

fn kill_verified(_pid: u32, _start_time: u64, _tree: bool) -> CmdResult<()> {
    Err(CmdError::from(PROCESS_CONTROL_DISABLED))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_drains_and_resume_resets_before_sampling() {
        let mut was_paused = false;
        assert_eq!(pause_action(false, &mut was_paused), PauseAction::Sample);
        assert_eq!(pause_action(true, &mut was_paused), PauseAction::Drain);
        assert!(was_paused);
        assert_eq!(pause_action(true, &mut was_paused), PauseAction::Drain);
        assert_eq!(pause_action(false, &mut was_paused), PauseAction::Drain);
        assert!(!was_paused);
        assert_eq!(pause_action(false, &mut was_paused), PauseAction::Sample);
    }

    #[test]
    fn process_control_is_unavailable_and_commands_fail_closed() {
        assert!(!ProcmonStats::default().process_control_available);
        assert!(kill_verified(42, 1_000, false).is_err());
        assert!(kill_verified(42, 1_000, true).is_err());
    }
}
