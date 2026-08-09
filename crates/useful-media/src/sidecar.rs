//! Sidecar 二进制（ffmpeg/ffprobe/mpv）解析。
//!
//! 解析顺序：
//! 1. 环境变量覆盖（USEFUL_FFMPEG / USEFUL_FFPROBE / USEFUL_MPV）
//! 2. 已验证并激活的应用数据 MediaPack
//! 3. 可执行文件旁 `binaries/<name>`
//! 4. 可执行文件旁 `<name>`
//! 5. 不可用（默认不搜索系统 PATH，避免执行未绑定的同名程序）
//!
//! 找不到时对应能力标记为不可用（Lite 版无媒体运行时时给出明确提示，不崩溃）。

use serde::Serialize;
use std::path::{Path, PathBuf};

/// 单个 sidecar 的解析结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarSet {
    pub name: String,
    pub path: Option<String>,
    pub available: bool,
    pub reason: Option<String>,
}

/// 三个媒体 sidecar 的集合。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sidecars {
    pub ffmpeg: SidecarSet,
    pub ffprobe: SidecarSet,
    pub mpv: SidecarSet,
}

impl Sidecars {
    /// 根据可执行文件目录解析全部 sidecar。
    pub fn resolve(exe_dir: &Path) -> Sidecars {
        Self::resolve_internal(exe_dir, None)
    }

    /// 同时解析版本化 MediaPack current 指针。无效或不完整指针按未安装处理。
    pub fn resolve_with_media_root(exe_dir: &Path, media_root: &Path) -> Sidecars {
        Self::resolve_internal(exe_dir, Some(media_root))
    }

    fn resolve_internal(exe_dir: &Path, media_root: Option<&Path>) -> Sidecars {
        Sidecars {
            ffmpeg: resolve_one("ffmpeg", "USEFUL_FFMPEG", exe_dir, media_root),
            ffprobe: resolve_one("ffprobe", "USEFUL_FFPROBE", exe_dir, media_root),
            mpv: resolve_one("mpv", "USEFUL_MPV", exe_dir, media_root),
        }
    }

    pub fn ffmpeg_path(&self) -> Option<PathBuf> {
        self.ffmpeg.path.as_ref().map(PathBuf::from)
    }
    pub fn ffprobe_path(&self) -> Option<PathBuf> {
        self.ffprobe.path.as_ref().map(PathBuf::from)
    }
    pub fn mpv_path(&self) -> Option<PathBuf> {
        self.mpv.path.as_ref().map(PathBuf::from)
    }
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn resolve_one(base: &str, env_key: &str, exe_dir: &Path, media_root: Option<&Path>) -> SidecarSet {
    let file = exe_name(base);

    // 1) 环境变量覆盖
    if let Some(v) = std::env::var_os(env_key) {
        let p = PathBuf::from(v);
        if p.is_file() {
            return found(base, &p);
        }
    }
    // 2) 已验证并激活的应用数据 MediaPack
    let mut media_pack_damaged = false;
    if let Some(root) = media_root {
        let pack_id = if base == "mpv" {
            "preview"
        } else {
            "transcode"
        };
        if let Some(path) = crate::pack::resolve_installed_component(root, pack_id, &file) {
            return found(base, &path);
        }
        media_pack_damaged = crate::pack::installed_status(root, pack_id).damaged;
    }
    // 3) exe_dir/binaries/<name>
    let in_binaries = exe_dir.join("binaries").join(&file);
    if in_binaries.is_file() {
        return found(base, &in_binaries);
    }
    // 4) exe_dir/<name>
    let beside = exe_dir.join(&file);
    if beside.is_file() {
        return found(base, &beside);
    }
    SidecarSet {
        name: base.to_string(),
        path: None,
        available: false,
        reason: Some(
            if media_pack_damaged {
                "media-pack-damaged"
            } else {
                "not-found"
            }
            .into(),
        ),
    }
}

fn found(name: &str, path: &Path) -> SidecarSet {
    let canonical = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    SidecarSet {
        name: name.to_string(),
        path: Some(canonical.to_string_lossy().to_string()),
        available: true,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolves_from_binaries_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("binaries");
        fs::create_dir_all(&bin).unwrap();
        let ff = bin.join(exe_name("ffmpeg"));
        fs::write(&ff, b"stub").unwrap();

        let set = resolve_one("ffmpeg", "USEFUL_FFMPEG_NONEXIST", tmp.path(), None);
        assert!(set.available);
        assert!(set.path.unwrap().contains("ffmpeg"));
    }

    #[test]
    fn resolves_beside_exe() {
        let tmp = tempfile::tempdir().unwrap();
        let ff = tmp.path().join(exe_name("mpv"));
        fs::write(&ff, b"stub").unwrap();
        let set = resolve_one("mpv", "USEFUL_MPV_NONEXIST", tmp.path(), None);
        assert!(set.available);
    }

    #[test]
    fn unavailable_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        // 使用一个几乎不可能在 PATH 中的名字
        let set = resolve_one("useful-no-such-binary-xyz", "USEFUL_NOPE", tmp.path(), None);
        assert!(!set.available);
        assert!(set.path.is_none());
        assert_eq!(set.reason.as_deref(), Some("not-found"));
    }

    #[test]
    fn resolve_all_three() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Sidecars::resolve(tmp.path());
        // 结构完整，字段可读（是否可用取决于环境）
        assert_eq!(s.ffmpeg.name, "ffmpeg");
        assert_eq!(s.ffprobe.name, "ffprobe");
        assert_eq!(s.mpv.name, "mpv");
    }
}
