//! ZIP 解压安全：阻止绝对路径、`..` 穿越、符号链接、ZIP Slip 与解压炸弹。

use crate::error::PluginError;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// 单个包的默认大小上限：256 MiB（压缩后）。
pub const DEFAULT_MAX_PACKAGE_SIZE: u64 = 256 * 1024 * 1024;
/// 解压后总大小上限：1 GiB（防解压炸弹）。
pub const DEFAULT_MAX_UNCOMPRESSED_SIZE: u64 = 1024 * 1024 * 1024;
/// 单个 manifest 大小上限。
pub const MAX_MANIFEST_SIZE: u64 = 256 * 1024;

/// 校验 ZIP 内条目名是相对且不穿越的安全路径。
/// 拒绝：绝对路径、盘符、`..`、根前缀 `/` 或 `\`。
pub fn ensure_safe_relative(name: &str) -> Result<PathBuf, PluginError> {
    if name.is_empty() {
        return Err(PluginError::UnsafeArchive("空路径".into()));
    }
    // 反斜杠也要检查（zip 规范用正斜杠，但恶意包可能塞反斜杠）
    if name.contains('\\') {
        return Err(PluginError::UnsafeArchive(format!(
            "包含反斜杠的路径: {name}"
        )));
    }
    let path = Path::new(name);
    if path.is_absolute() {
        return Err(PluginError::UnsafeArchive(format!("绝对路径: {name}")));
    }
    let mut normalized = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(PluginError::UnsafeArchive(format!("包含 .. 穿越: {name}")));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(PluginError::UnsafeArchive(format!("包含根/盘符: {name}")));
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(PluginError::UnsafeArchive(format!("非法路径: {name}")));
    }
    Ok(normalized)
}

/// 安全解压 .useful（ZIP）到目标目录。
/// - 阻止 ZIP Slip / 路径穿越 / 符号链接
/// - 强制解压后总大小上限
/// - 确保最终路径仍在 dest_root 内
pub fn extract_zip_safely(
    archive_path: &Path,
    dest_root: &Path,
    max_uncompressed: u64,
) -> Result<(), PluginError> {
    let file = std::fs::File::open(archive_path)?;
    let mut zip = zip::ZipArchive::new(file)?;

    std::fs::create_dir_all(dest_root)?;
    let canonical_root = dunce::canonicalize(dest_root)?;
    let mut total_uncompressed: u64 = 0;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;

        // 符号链接检测：Unix 权限位 S_IFLNK (0xA000)
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(PluginError::UnsafeArchive(format!(
                    "包含符号链接: {}",
                    entry.name()
                )));
            }
        }

        let raw_name = entry.name().to_string();
        // 目录条目
        if entry.is_dir() {
            let rel = ensure_safe_relative(raw_name.trim_end_matches('/'))?;
            let target = canonical_root.join(&rel);
            std::fs::create_dir_all(&target)?;
            continue;
        }

        let rel = ensure_safe_relative(&raw_name)?;
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
        if total_uncompressed > max_uncompressed {
            return Err(PluginError::SizeExceeded {
                actual: total_uncompressed,
                limit: max_uncompressed,
            });
        }

        let target = canonical_root.join(&rel);
        // 双保险：最终路径必须仍在根目录下
        if !target.starts_with(&canonical_root) {
            return Err(PluginError::UnsafeArchive(format!(
                "解压路径逃逸: {raw_name}"
            )));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

/// 从 .useful 包中仅读取 manifest.json（不解压全部），用于安装前预检。
pub fn read_manifest_bytes(archive_path: &Path) -> Result<Vec<u8>, PluginError> {
    let file = std::fs::File::open(archive_path)?;
    let mut zip = zip::ZipArchive::new(file)?;
    let mut entry = zip
        .by_name("manifest.json")
        .map_err(|_| PluginError::ManifestInvalid("缺少 manifest.json".into()))?;
    if entry.size() > MAX_MANIFEST_SIZE {
        return Err(PluginError::SizeExceeded {
            actual: entry.size(),
            limit: MAX_MANIFEST_SIZE,
        });
    }
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf)?;
    Ok(buf)
}

/// 计算文件 SHA-256（hex 小写）。
pub fn sha256_file(path: &Path) -> Result<String, PluginError> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// 计算字节 SHA-256（hex 小写）。
pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// 校验文件哈希是否匹配期望值（大小写不敏感）。
pub fn verify_sha256(path: &Path, expected: &str) -> Result<(), PluginError> {
    let actual = sha256_file(path)?;
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(PluginError::HashMismatch {
            expected: expected.to_string(),
            actual,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_absolute() {
        assert!(ensure_safe_relative("../evil").is_err());
        assert!(ensure_safe_relative("/etc/passwd").is_err());
        assert!(ensure_safe_relative("a/../../b").is_err());
        assert!(ensure_safe_relative("C:\\Windows\\x").is_err());
        assert!(ensure_safe_relative("dir\\file").is_err());
        assert!(ensure_safe_relative("dist/index.html").is_ok());
        assert!(ensure_safe_relative("assets/中文 图标.png").is_ok());
    }

    #[test]
    fn sha256_matches_known_vector() {
        // echo -n "" | sha256sum
        assert_eq!(
            sha256_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
