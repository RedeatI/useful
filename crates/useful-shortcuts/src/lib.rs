//! 桌面快捷方式：通过 Windows COM IShellLink（windows-rs）创建/删除/修复 .lnk。
//!
//! 不使用 PowerShell 脚本。所有快捷方式目标统一指向 Useful.exe 并携带 `--open-tool <id>`。

use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ShortcutError {
    #[error("COM 调用失败: {0}")]
    Com(String),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("参数无效: {0}")]
    Invalid(String),
    #[error("当前平台不支持创建快捷方式")]
    Unsupported,
}

/// 快捷方式规格。
#[derive(Debug, Clone)]
pub struct ShortcutSpec {
    /// 目标 exe（通常是 Useful.exe 绝对路径）
    pub target_exe: PathBuf,
    /// 命令行参数，如 ["--open-tool", "builtin.video-trim"]
    pub args: Vec<String>,
    /// 工作目录
    pub working_dir: PathBuf,
    /// .lnk 完整输出路径
    pub lnk_path: PathBuf,
    /// 图标文件（.ico）路径；None 则使用 target_exe 默认图标
    pub icon_path: Option<PathBuf>,
    /// 描述/悬浮提示
    pub description: String,
}

/// 从 Windows .lnk 读取的关键属性，用于验收与修复校验。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutDetails {
    pub target_exe: PathBuf,
    pub args: String,
    pub working_dir: PathBuf,
    pub icon_path: Option<PathBuf>,
    pub description: String,
}

impl ShortcutSpec {
    /// 便捷构造：在桌面为某工具创建快捷方式的规格。
    pub fn for_tool(
        useful_exe: PathBuf,
        desktop_dir: &Path,
        tool_id: &str,
        display_name: &str,
        icon_path: Option<PathBuf>,
    ) -> ShortcutSpec {
        let working_dir = useful_exe
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        ShortcutSpec {
            target_exe: useful_exe,
            args: vec!["--open-tool".into(), tool_id.into()],
            working_dir,
            lnk_path: desktop_dir.join(format!("{}.lnk", sanitize_filename(display_name))),
            icon_path,
            description: format!("Useful - {display_name}"),
        }
    }

    /// 参数拼接为 lnk Arguments 字符串（带引号转义）。
    pub fn arguments_string(&self) -> String {
        self.args
            .iter()
            .map(|a| quote_arg(a))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// 将参数按 Windows 规则加引号（含空格/引号时）。
pub fn quote_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".into();
    }
    if !arg.contains(' ') && !arg.contains('"') && !arg.contains('\t') {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                for _ in 0..=backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push('"');
            }
            _ => {
                backslashes = 0;
                out.push(c);
            }
        }
    }
    for _ in 0..backslashes {
        out.push('\\');
    }
    out.push('"');
    out
}

/// 去除文件名中的非法字符。
pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn from_wide(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    /// RAII COM 初始化守卫。
    struct ComGuard;
    impl ComGuard {
        fn new() -> Result<Self, ShortcutError> {
            unsafe {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                if hr.is_err() {
                    return Err(ShortcutError::Com(format!("CoInitializeEx: {hr:?}")));
                }
            }
            Ok(ComGuard)
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    pub fn create(spec: &ShortcutSpec) -> Result<(), ShortcutError> {
        if let Some(parent) = spec.lnk_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let _guard = ComGuard::new()?;
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| ShortcutError::Com(format!("CoCreateInstance: {e}")))?;

            let target = to_wide(&spec.target_exe.to_string_lossy());
            link.SetPath(PCWSTR(target.as_ptr()))
                .map_err(|e| ShortcutError::Com(format!("SetPath: {e}")))?;

            let args = to_wide(&spec.arguments_string());
            link.SetArguments(PCWSTR(args.as_ptr()))
                .map_err(|e| ShortcutError::Com(format!("SetArguments: {e}")))?;

            let wd = to_wide(&spec.working_dir.to_string_lossy());
            link.SetWorkingDirectory(PCWSTR(wd.as_ptr()))
                .map_err(|e| ShortcutError::Com(format!("SetWorkingDirectory: {e}")))?;

            let desc = to_wide(&spec.description);
            link.SetDescription(PCWSTR(desc.as_ptr()))
                .map_err(|e| ShortcutError::Com(format!("SetDescription: {e}")))?;

            if let Some(icon) = &spec.icon_path {
                let icon_w = to_wide(&icon.to_string_lossy());
                link.SetIconLocation(PCWSTR(icon_w.as_ptr()), 0)
                    .map_err(|e| ShortcutError::Com(format!("SetIconLocation: {e}")))?;
            }

            let persist: IPersistFile = link
                .cast()
                .map_err(|e| ShortcutError::Com(format!("cast IPersistFile: {e}")))?;
            let lnk = to_wide(&spec.lnk_path.to_string_lossy());
            persist
                .Save(PCWSTR(lnk.as_ptr()), true)
                .map_err(|e| ShortcutError::Com(format!("Save: {e}")))?;
        }
        Ok(())
    }

    /// 读取现有 .lnk 的目标路径（用于修复校验）。
    pub fn read_target(lnk_path: &Path) -> Result<PathBuf, ShortcutError> {
        Ok(read_details(lnk_path)?.target_exe)
    }

    pub fn read_details(lnk_path: &Path) -> Result<ShortcutDetails, ShortcutError> {
        let _guard = ComGuard::new()?;
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| ShortcutError::Com(format!("CoCreateInstance: {e}")))?;
            let persist: IPersistFile = link
                .cast()
                .map_err(|e| ShortcutError::Com(format!("cast IPersistFile: {e}")))?;
            let lnk = to_wide(&lnk_path.to_string_lossy());
            persist
                .Load(PCWSTR(lnk.as_ptr()), windows::Win32::System::Com::STGM_READ)
                .map_err(|e| ShortcutError::Com(format!("Load: {e}")))?;
            let mut target = [0u16; 32768];
            link.GetPath(&mut target, std::ptr::null_mut(), 0)
                .map_err(|e| ShortcutError::Com(format!("GetPath: {e}")))?;
            let mut args = [0u16; 32768];
            link.GetArguments(&mut args)
                .map_err(|e| ShortcutError::Com(format!("GetArguments: {e}")))?;
            let mut working_dir = [0u16; 32768];
            link.GetWorkingDirectory(&mut working_dir)
                .map_err(|e| ShortcutError::Com(format!("GetWorkingDirectory: {e}")))?;
            let mut icon = [0u16; 32768];
            let mut icon_index = 0;
            link.GetIconLocation(&mut icon, &mut icon_index)
                .map_err(|e| ShortcutError::Com(format!("GetIconLocation: {e}")))?;
            let mut description = [0u16; 1024];
            link.GetDescription(&mut description)
                .map_err(|e| ShortcutError::Com(format!("GetDescription: {e}")))?;
            let icon = from_wide(&icon);
            Ok(ShortcutDetails {
                target_exe: PathBuf::from(from_wide(&target)),
                args: from_wide(&args),
                working_dir: PathBuf::from(from_wide(&working_dir)),
                icon_path: (!icon.is_empty()).then(|| PathBuf::from(icon)),
                description: from_wide(&description),
            })
        }
    }

    /// 通过 SHGetKnownFolderPath(FOLDERID_Desktop) 获取桌面目录。
    pub fn known_desktop() -> Result<PathBuf, ShortcutError> {
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::{FOLDERID_Desktop, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
        unsafe {
            let pwstr = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None)
                .map_err(|e| ShortcutError::Com(format!("SHGetKnownFolderPath: {e}")))?;
            if pwstr.is_null() {
                return Err(ShortcutError::Com("桌面路径为空".into()));
            }
            let path = pwstr
                .to_string()
                .map_err(|e| ShortcutError::Com(e.to_string()))?;
            CoTaskMemFree(Some(pwstr.0 as *const _));
            Ok(PathBuf::from(path))
        }
    }
}

/// 创建桌面快捷方式。
pub fn create_shortcut(spec: &ShortcutSpec) -> Result<(), ShortcutError> {
    #[cfg(windows)]
    {
        win::create(spec)
    }
    #[cfg(not(windows))]
    {
        let _ = spec;
        Err(ShortcutError::Unsupported)
    }
}

/// 删除快捷方式。
pub fn delete_shortcut(lnk_path: &Path) -> Result<(), ShortcutError> {
    if lnk_path.exists() {
        std::fs::remove_file(lnk_path)?;
    }
    Ok(())
}

/// 修复快捷方式：删除旧的并按新规格重建（用于软件移动目录后）。
pub fn repair_shortcut(spec: &ShortcutSpec) -> Result<(), ShortcutError> {
    let _ = delete_shortcut(&spec.lnk_path);
    create_shortcut(spec)
}

/// 读取 .lnk 目标（仅 Windows）。
pub fn read_shortcut_target(lnk_path: &Path) -> Result<PathBuf, ShortcutError> {
    #[cfg(windows)]
    {
        win::read_target(lnk_path)
    }
    #[cfg(not(windows))]
    {
        let _ = lnk_path;
        Err(ShortcutError::Unsupported)
    }
}

/// 读取 .lnk 的目标、参数、工作目录、图标和描述（仅 Windows）。
pub fn read_shortcut_details(lnk_path: &Path) -> Result<ShortcutDetails, ShortcutError> {
    #[cfg(windows)]
    {
        win::read_details(lnk_path)
    }
    #[cfg(not(windows))]
    {
        let _ = lnk_path;
        Err(ShortcutError::Unsupported)
    }
}

/// 获取当前用户桌面目录（Windows 使用 FOLDERID_Desktop 已知文件夹，支持重定向桌面）。
pub fn desktop_dir() -> Result<PathBuf, ShortcutError> {
    #[cfg(windows)]
    {
        win::known_desktop()
    }
    #[cfg(not(windows))]
    {
        Err(ShortcutError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_args_with_spaces() {
        assert_eq!(quote_arg("simple"), "simple");
        assert_eq!(quote_arg("with space"), "\"with space\"");
        assert_eq!(
            quote_arg(r"C:\path with space\file"),
            "\"C:\\path with space\\file\""
        );
    }

    #[test]
    fn arguments_string_for_tool() {
        let spec = ShortcutSpec::for_tool(
            PathBuf::from(r"C:\Apps\Useful\Useful.exe"),
            Path::new(r"C:\Users\me\Desktop"),
            "builtin.video-trim",
            "视频裁剪",
            None,
        );
        assert_eq!(spec.arguments_string(), "--open-tool builtin.video-trim");
        assert!(spec.lnk_path.to_string_lossy().ends_with("视频裁剪.lnk"));
    }

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(sanitize_filename("a/b:c*d"), "a_b_c_d");
        assert_eq!(sanitize_filename("正常名称"), "正常名称");
    }

    #[test]
    fn tool_id_with_special_chars_is_quoted_safely() {
        // 防 shell 参数注入：带空格的工具 ID 会被正确引用
        let spec = ShortcutSpec {
            target_exe: PathBuf::from("Useful.exe"),
            args: vec!["--open-tool".into(), "evil id & del".into()],
            working_dir: PathBuf::from("."),
            lnk_path: PathBuf::from("x.lnk"),
            icon_path: None,
            description: String::new(),
        };
        assert_eq!(spec.arguments_string(), "--open-tool \"evil id & del\"");
    }
}
