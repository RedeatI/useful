//! 下载校验与源安装策略。
//!
//! 下载器把包写入 `<uuid>.useful.part`，全部字节落盘后重命名为 `.useful`，
//! 再由本模块校验大小与 SHA-256；校验通过前绝不进入安装管线，
//! 保证“下载未完成/被篡改就安装”不可能发生。

use crate::error::PluginError;
use crate::manifest::{EntryType, PluginManifest};
use crate::zip_safety;
use std::path::Path;

/// 下载中间文件后缀。以该后缀结尾的文件视为未完成下载，拒绝进入校验/安装。
pub const PARTIAL_SUFFIX: &str = ".part";

/// 校验一个已完成下载的包文件：
/// 1. 不允许 `.part` 未完成文件；
/// 2. 实际大小必须与源索引声明一致；
/// 3. SHA-256 必须与源索引声明一致。
pub fn verify_downloaded_file(
    path: &Path,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<(), PluginError> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(PARTIAL_SUFFIX) {
        return Err(PluginError::UnsafeArchive(
            "下载未完成（.part 文件），拒绝安装".into(),
        ));
    }
    let meta = std::fs::metadata(path)?;
    if meta.len() != expected_size {
        return Err(PluginError::SizeExceeded {
            actual: meta.len(),
            limit: expected_size,
        });
    }
    let actual = zip_safety::sha256_file(path)?;
    if !actual.eq_ignore_ascii_case(expected_sha256.trim()) {
        return Err(PluginError::HashMismatch {
            expected: expected_sha256.to_string(),
            actual,
        });
    }
    Ok(())
}

/// 公开工具源安装策略：默认禁止 `entry.type == worker` 自动安装。
/// 原生 worker 只允许可信签名源（未来扩展）或用户本地导入并明确确认。
pub fn ensure_source_install_allowed(manifest: &PluginManifest) -> Result<(), PluginError> {
    if manifest.entry.entry_type == EntryType::Worker {
        return Err(PluginError::PermissionDenied(
            "公开源默认禁止安装原生 worker 插件，请从本地导入并明确确认".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_tmp(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn accepts_valid_download() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"hello useful";
        let p = write_tmp(&dir, "pkg.useful", data);
        let sha = zip_safety::sha256_bytes(data);
        assert!(verify_downloaded_file(&p, &sha, data.len() as u64).is_ok());
        // 大小写不敏感
        assert!(verify_downloaded_file(&p, &sha.to_uppercase(), data.len() as u64).is_ok());
    }

    #[test]
    fn rejects_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"incomplete";
        let p = write_tmp(&dir, "pkg.useful.part", data);
        let sha = zip_safety::sha256_bytes(data);
        let err = verify_downloaded_file(&p, &sha, data.len() as u64).unwrap_err();
        assert!(err.to_string().contains("未完成"));
    }

    #[test]
    fn rejects_hash_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"tampered content";
        let p = write_tmp(&dir, "pkg.useful", data);
        let err = verify_downloaded_file(&p, &"0".repeat(64), data.len() as u64).unwrap_err();
        assert!(matches!(err, PluginError::HashMismatch { .. }));
    }

    #[test]
    fn rejects_size_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"short";
        let p = write_tmp(&dir, "pkg.useful", data);
        let sha = zip_safety::sha256_bytes(data);
        let err = verify_downloaded_file(&p, &sha, 999).unwrap_err();
        assert!(matches!(err, PluginError::SizeExceeded { .. }));
    }

    #[test]
    fn source_install_blocks_worker() {
        let json = r#"{
            "schemaVersion": 1,
            "id": "com.example.worker-tool",
            "name": "worker",
            "version": "1.0.0",
            "entry": { "type": "worker", "path": "bin/tool.exe" },
            "platforms": ["windows-x64"]
        }"#;
        let m = PluginManifest::parse_and_validate(json.as_bytes()).unwrap();
        assert!(ensure_source_install_allowed(&m).is_err());

        let web = r#"{
            "schemaVersion": 1,
            "id": "com.example.web-tool",
            "name": "web",
            "version": "1.0.0",
            "entry": { "type": "web", "path": "index.html" },
            "platforms": ["windows-x64"]
        }"#;
        let m = PluginManifest::parse_and_validate(web.as_bytes()).unwrap();
        assert!(ensure_source_install_allowed(&m).is_ok());
    }
}
