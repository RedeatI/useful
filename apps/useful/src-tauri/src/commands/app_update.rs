//! 客户端更新源（AppUpdateSource）命令：独立信任域（Phase 10）。
//!
//! 原则：与工具源（trp_sources）完全隔离——本模块不读工具源表、不接受
//! 工具源密钥；官方身份仅由预置更新根公钥字节匹配决定；更换为自定义
//! 更新源必须显式确认单独警告（不从任何工具源自动继承）。

use super::{CmdError, CmdResult};
use serde::Serialize;
use std::path::PathBuf;
use useful_bootstrap::config::{load_or_official, AppUpdateSource, PRODUCTION_UPDATE_CONFIGURED};

/// 更新配置目录：便携布局为 exe 同级 update/；开发运行时同样按 exe 目录。
fn update_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("update")))
        .unwrap_or_else(|| PathBuf::from("update"))
}

fn config_path() -> PathBuf {
    update_dir().join("app-update-source.json")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateSourceInfo {
    pub update_feed_url: String,
    pub channel: String,
    /// 仅由预置更新根公钥匹配产生；URL/名称不参与判定。
    pub is_official: bool,
    pub is_default_official: bool,
    pub using_development_update_trust: bool,
    pub root_fingerprint: String,
    pub warning_acknowledged_at: Option<String>,
    pub current_version: String,
    pub pending_update: bool,
    pub bootstrap_present: bool,
}

fn info_from(cfg: &AppUpdateSource) -> AppUpdateSourceInfo {
    let dir = update_dir();
    let root = dir.parent().map(PathBuf::from).unwrap_or_default();
    AppUpdateSourceInfo {
        update_feed_url: cfg.update_feed_url.clone(),
        channel: cfg.channel.clone(),
        is_official: cfg.is_official(),
        is_default_official: cfg.is_default_official,
        using_development_update_trust: !PRODUCTION_UPDATE_CONFIGURED,
        root_fingerprint: cfg.root_fingerprint(),
        warning_acknowledged_at: cfg.warning_acknowledged_at.clone(),
        current_version: std::fs::read_to_string(dir.join("current-version.txt"))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string()),
        pending_update: dir.join("pending/update-manifest.json").exists(),
        bootstrap_present: root.join("useful-bootstrap.exe").exists(),
    }
}

/// 读取当前客户端更新源（缺省 = 官方预置）。
#[tauri::command]
pub fn app_update_source_get() -> CmdResult<AppUpdateSourceInfo> {
    let cfg = load_or_official(&config_path()).map_err(CmdError::from)?;
    Ok(info_from(&cfg))
}

/// 更换客户端更新源（高级用户）。必须显式确认单独警告；
/// 密钥只能在此处导入，绝不从工具源继承。
#[tauri::command]
pub fn app_update_source_set_custom(
    update_feed_url: String,
    update_root_public_key: String,
    warning_acknowledged: bool,
) -> CmdResult<AppUpdateSourceInfo> {
    if !warning_acknowledged {
        return Err(CmdError::from(
            "必须先阅读并确认警告：更换更新服务提供商后，客户端更新将由该源签名",
        ));
    }
    let now = time_rfc3339();
    let cfg = AppUpdateSource {
        kind: "app-update".into(),
        update_feed_url,
        update_root_public_key: update_root_public_key.trim().to_lowercase(),
        channel: "stable".into(),
        is_default_official: false,
        warning_acknowledged_at: Some(now),
    };
    cfg.validate().map_err(CmdError::from)?;
    persist(&cfg)?;
    Ok(info_from(&cfg))
}

/// 切换客户端更新通道。切换通道不会更换更新根或服务提供商。
#[tauri::command]
pub fn app_update_channel_set(channel: String) -> CmdResult<AppUpdateSourceInfo> {
    let mut cfg = load_or_official(&config_path()).map_err(CmdError::from)?;
    cfg.channel = channel;
    cfg.validate().map_err(CmdError::from)?;
    persist(&cfg)?;
    Ok(info_from(&cfg))
}

/// 恢复官方预置更新源。
#[tauri::command]
pub fn app_update_source_reset_official() -> CmdResult<AppUpdateSourceInfo> {
    let cfg = AppUpdateSource::official_default();
    persist(&cfg)?;
    Ok(info_from(&cfg))
}

fn persist(cfg: &AppUpdateSource) -> CmdResult<()> {
    let dir = update_dir();
    std::fs::create_dir_all(&dir).map_err(CmdError::from)?;
    let raw = serde_json::to_vec_pretty(cfg).map_err(CmdError::from)?;
    std::fs::write(config_path(), raw).map_err(CmdError::from)?;
    Ok(())
}

fn time_rfc3339() -> String {
    // 秒级 UTC RFC3339（无外部时间库依赖）
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86400;
    let (mut y, mut rem_days) = (1970i64, days as i64);
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let len = if leap { 366 } else { 365 };
        if rem_days < len {
            break;
        }
        rem_days -= len;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let ml = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 0usize;
    while rem_days >= ml[m] {
        rem_days -= ml[m];
        m += 1;
    }
    let t = secs % 86400;
    format!(
        "{y:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        m + 1,
        rem_days + 1,
        t / 3600,
        (t % 3600) / 60,
        t % 60
    )
}
