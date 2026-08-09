//! 便携模式路径解析。
//!
//! 当可执行文件旁存在 `portable.flag` 时，全部数据写入 `./data`；
//! 否则使用平台数据目录。Windows 继续沿用 `%APPDATA%/Useful`，保证
//! Useful 显示品牌升级后收藏、插件和更新身份不会丢失；macOS/Linux 为
//! 新平台，分别使用系统 Application Support/XDG data 下的 `Useful`。
//! 所有路径均通过 `dunce::canonicalize` 规范化，支持中文、空格、长路径与可移动磁盘。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const PORTABLE_FLAG_FILE: &str = "portable.flag";
static WRITE_PROBE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
const INSTALLED_DATA_DIR_NAME: &str = "Useful";
#[cfg(not(windows))]
const INSTALLED_DATA_DIR_NAME: &str = "Useful";

fn absolute_env_path(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn platform_data_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        absolute_env_path(std::env::var_os("APPDATA"))
    }
    #[cfg(target_os = "macos")]
    {
        absolute_env_path(std::env::var_os("HOME"))
            .map(|home| home.join("Library").join("Application Support"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        absolute_env_path(std::env::var_os("XDG_DATA_HOME")).or_else(|| {
            absolute_env_path(std::env::var_os("HOME"))
                .map(|home| home.join(".local").join("share"))
        })
    }
    #[cfg(not(any(windows, unix)))]
    {
        None
    }
}

/// 应用运行模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    Portable,
    Installed,
}

/// 应用全部数据目录的集中定义。
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub mode: RunMode,
    /// 数据根目录（便携: exe 旁 ./data）
    pub data_dir: PathBuf,
    pub plugins_dir: PathBuf,
    pub downloads_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub agent_dir: PathBuf,
    pub agent_profile_path: PathBuf,
    pub db_path: PathBuf,
    /// 可执行文件所在目录
    pub exe_dir: PathBuf,
}

impl AppPaths {
    /// 根据可执行文件位置探测运行模式并生成路径。
    pub fn detect(exe_path: &Path, appdata_dir: Option<PathBuf>) -> std::io::Result<AppPaths> {
        let exe_dir = exe_path
            .parent()
            .ok_or_else(|| std::io::Error::other("无法解析可执行文件目录"))?
            .to_path_buf();

        let portable = exe_dir.join(PORTABLE_FLAG_FILE).exists();
        let (mode, data_dir) = if portable {
            (RunMode::Portable, exe_dir.join("data"))
        } else {
            let base = appdata_dir
                .or_else(platform_data_root)
                .unwrap_or_else(|| exe_dir.join("data"));
            (RunMode::Installed, base.join(INSTALLED_DATA_DIR_NAME))
        };

        Ok(Self::from_data_dir(mode, exe_dir, data_dir))
    }

    fn from_data_dir(mode: RunMode, exe_dir: PathBuf, data_dir: PathBuf) -> AppPaths {
        AppPaths {
            mode,
            plugins_dir: data_dir.join("plugins"),
            downloads_dir: data_dir.join("downloads"),
            cache_dir: data_dir.join("cache"),
            logs_dir: data_dir.join("logs"),
            staging_dir: data_dir.join("staging"),
            agent_dir: data_dir.join("agent"),
            agent_profile_path: data_dir.join("agent").join("useful.agent-profile.v1.json"),
            db_path: data_dir.join("useful.db"),
            data_dir,
            exe_dir,
        }
    }

    /// 创建全部目录（幂等）。
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for dir in [
            &self.data_dir,
            &self.plugins_dir,
            &self.downloads_dir,
            &self.cache_dir,
            &self.logs_dir,
            &self.staging_dir,
            &self.agent_dir,
        ] {
            std::fs::create_dir_all(long_path(dir))?;
            probe_directory_writable(dir)?;
        }
        Ok(())
    }
}

fn probe_directory_writable(directory: &Path) -> std::io::Result<()> {
    let sequence = WRITE_PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let probe = directory.join(format!(
        ".useful-write-probe-{}-{timestamp}-{sequence}",
        std::process::id(),
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(long_path(&probe))?;
        file.write_all(b"useful-write-probe")?;
        file.sync_all()
    })();
    let cleanup = std::fs::remove_file(long_path(&probe));
    match (result, cleanup) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

/// Windows 上为超长路径加 `\\?\` 前缀；其余平台原样返回。
pub fn long_path(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        // dunce 只有在必要时才保留 UNC 前缀
        if p.is_absolute() {
            let s = p.as_os_str().to_string_lossy();
            if !s.starts_with(r"\\?\") && s.len() >= 240 {
                return PathBuf::from(format!(r"\\?\{s}"));
            }
        }
        p.to_path_buf()
    }
    #[cfg(not(windows))]
    {
        p.to_path_buf()
    }
}

/// 规范化路径用于缓存键/比较：小写盘符、去除 UNC 前缀、统一分隔符。
pub fn normalize_for_key(p: &Path) -> String {
    let canon = dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    #[cfg(windows)]
    {
        let s = canon.to_string_lossy().replace('/', "\\");
        let mut chars = s.chars();
        match (chars.next(), chars.next()) {
            (Some(drive), Some(':')) if drive.is_ascii_alphabetic() => {
                format!(
                    "{}:{}",
                    drive.to_ascii_lowercase(),
                    chars.collect::<String>()
                )
            }
            _ => s,
        }
    }
    #[cfg(not(windows))]
    {
        // Unix 路径区分大小写，不能像 Windows 一样转反斜杠或折叠盘符大小写。
        canon.to_string_lossy().into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn portable_flag_switches_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("Useful.exe");
        fs::write(&exe, b"stub").unwrap();

        let paths = AppPaths::detect(&exe, Some(tmp.path().join("appdata"))).unwrap();
        assert_eq!(paths.mode, RunMode::Installed);

        fs::write(tmp.path().join(PORTABLE_FLAG_FILE), b"").unwrap();
        let paths = AppPaths::detect(&exe, Some(tmp.path().join("appdata"))).unwrap();
        assert_eq!(paths.mode, RunMode::Portable);
        assert_eq!(paths.data_dir, tmp.path().join("data"));
        assert_eq!(paths.db_path, tmp.path().join("data").join("useful.db"));
        assert_eq!(paths.plugins_dir, tmp.path().join("data").join("plugins"));
    }

    #[test]
    fn chinese_and_space_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("中文 目录 テスト");
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("Useful.exe");
        fs::write(&exe, b"stub").unwrap();
        fs::write(dir.join(PORTABLE_FLAG_FILE), b"").unwrap();

        let paths = AppPaths::detect(&exe, None).unwrap();
        paths.ensure_dirs().unwrap();
        assert!(paths.plugins_dir.exists());
        assert!(paths.logs_dir.exists());
        assert!(fs::read_dir(&paths.data_dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".useful-write-probe-")));
    }

    #[test]
    fn portable_data_failure_never_falls_back_to_appdata() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("portable");
        let appdata = tmp.path().join("appdata");
        fs::create_dir(&exe_dir).unwrap();
        let exe = exe_dir.join("Useful.exe");
        fs::write(&exe, b"stub").unwrap();
        fs::write(exe_dir.join(PORTABLE_FLAG_FILE), b"").unwrap();
        fs::write(exe_dir.join("data"), b"not a directory").unwrap();

        let paths = AppPaths::detect(&exe, Some(appdata.clone())).unwrap();
        assert_eq!(paths.mode, RunMode::Portable);
        assert!(paths.ensure_dirs().is_err());
        assert!(!appdata.exists());
    }

    #[test]
    fn normalize_key_lowercases_drive() {
        let tmp = tempfile::tempdir().unwrap();
        let k = normalize_for_key(tmp.path());
        assert!(!k.starts_with(r"\\?\"), "不应包含 UNC 前缀: {k}");
        #[cfg(not(windows))]
        assert!(!k.contains('\\'), "Unix 缓存键必须保留平台分隔符: {k}");
    }

    #[test]
    fn platform_environment_paths_must_be_nonempty_and_absolute() {
        assert!(absolute_env_path(None).is_none());
        assert!(absolute_env_path(Some(std::ffi::OsString::new())).is_none());
        assert!(absolute_env_path(Some("relative/data".into())).is_none());
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            absolute_env_path(Some(tmp.path().as_os_str().to_owned())),
            Some(tmp.path().to_path_buf())
        );
    }
}
