//! 临时文件 + 原子替换写入，防止断电/崩溃损坏关键配置。

use std::io::Write;
use std::path::Path;

/// 将 `bytes` 原子写入 `dest`：
/// 1. 写入同目录临时文件并 fsync；
/// 2. `rename`（同卷原子替换）到目标路径。
pub fn atomic_write(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = dest
        .parent()
        .ok_or_else(|| std::io::Error::other("目标路径缺少父目录"))?;
    std::fs::create_dir_all(dir)?;

    let mut tmp = tempfile::Builder::new()
        .prefix(".useful-write-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;

    // Windows 上 persist 使用 MoveFileExW(REPLACE_EXISTING) 实现原子替换
    tmp.persist(dest).map_err(|e| e.error)?;
    Ok(())
}

/// 原子写入 JSON（pretty，便于用户诊断时阅读）。
pub fn atomic_write_json<T: serde::Serialize>(dest: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| std::io::Error::other(format!("序列化失败: {e}")))?;
    atomic_write(dest, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("配置 file.json");
        atomic_write(&f, b"{\"a\":1}").unwrap();
        atomic_write(&f, b"{\"a\":2}").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"{\"a\":2}");
        // 不留下临时文件
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".useful-write-")
            })
            .collect();
        assert!(leftovers.is_empty());
    }
}
