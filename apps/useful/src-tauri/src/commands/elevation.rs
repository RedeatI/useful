//! 权限提升状态。
//!
//! 一键提权被刻意禁用：从非提权进程延迟启动磁盘上的可执行文件会留下路径替换窗口，
//! 而便携版/用户可写安装无法证明镜像身份受系统目录保护。用户仍可从 Windows 外壳手动
//! “以管理员身份运行”，这样由系统在启动时选择并确认目标镜像。

use super::{CmdError, CmdResult};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationStatus {
    pub elevated: bool,
    pub platform: String,
    pub can_request: bool,
}

#[tauri::command]
pub fn elevation_status() -> CmdResult<ElevationStatus> {
    Ok(ElevationStatus {
        elevated: is_elevated(),
        platform: std::env::consts::OS.to_string(),
        can_request: false,
    })
}

#[tauri::command]
pub fn restart_elevated(open_tool: Option<String>) -> CmdResult<()> {
    let _ = sanitized_relaunch_args(&[], open_tool.as_deref());
    Err(CmdError::from(elevation_request_error(
        std::env::consts::OS,
        is_elevated(),
    )))
}

fn elevation_request_error(platform: &str, elevated: bool) -> &'static str {
    if elevated {
        "当前已是提升后的权限，无需再次请求"
    } else if platform == "windows" {
        "为防止可执行文件替换，一键提权已禁用；请退出后从 Windows 外壳手动选择“以管理员身份运行”"
    } else {
        "当前平台不支持一键管理员重启"
    }
}

/// 严格移除继承参数中的 open-tool，仅保留调用者明确请求的单个值。
/// 当前禁用的自动提权路径不执行这些参数；保留纯函数作为未来受保护安装实现的协议边界。
fn sanitized_relaunch_args(args: &[String], open_tool: Option<&str>) -> Vec<String> {
    let mut cleaned = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--open-tool" {
            index = (index + 2).min(args.len());
            continue;
        }
        if args[index].starts_with("--open-tool=") {
            index += 1;
            continue;
        }
        cleaned.push(args[index].clone());
        index += 1;
    }
    if let Some(tool) = open_tool.filter(|value| !value.is_empty()) {
        cleaned.push("--open-tool".into());
        cleaned.push(tool.to_string());
    }
    cleaned
}

fn is_elevated() -> bool {
    #[cfg(windows)]
    {
        windows_is_elevated()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn windows_is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relaunch_args_remove_all_inherited_open_tool_forms() {
        let args = vec![
            "--open-tool".into(),
            "old".into(),
            "--other".into(),
            "--open-tool=also-old".into(),
        ];
        assert_eq!(
            sanitized_relaunch_args(&args, Some("new")),
            vec![
                "--other".to_string(),
                "--open-tool".to_string(),
                "new".to_string(),
            ]
        );
    }

    #[test]
    fn elevation_policy_fails_closed() {
        assert!(elevation_request_error("windows", false).contains("手动"));
        assert!(elevation_request_error("linux", false).contains("不支持"));
        assert!(elevation_request_error("windows", true).contains("无需"));
    }

    #[test]
    fn public_commands_do_not_advertise_or_perform_one_click_elevation() {
        assert!(!elevation_status().unwrap().can_request);
        assert!(restart_elevated(Some("builtin.process-monitor".into())).is_err());
    }
}
