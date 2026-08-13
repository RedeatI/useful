//! 应用更新：确认退出 → 备份 → 原子替换 → 启动失败回滚 → 清理旧备份。
//!
//! 布局（便携目录）：
//!   app_root/Useful.exe …            当前版本文件
//!   app_root/update/pending/          待应用更新（manifest + payload.zip）
//!   app_root/update/staging/          解包临时目录（应用前验证完毕）
//!   app_root/backup/<ver>-<ts>/       版本备份（回滚来源）

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    #[error("IO 失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("Useful 仍在运行，无法更新（请先退出）")]
    AppStillRunning,
    #[error("更新包内路径不安全: {0}")]
    UnsafePath(String),
    #[error("更新包解包失败: {0}")]
    BadArchive(String),
    #[error("更新包超过解压大小上限")]
    TooLarge,
    #[error("当前平台不支持安全确认 Useful 已退出，拒绝自动替换")]
    UnsupportedPlatform,
    #[error("备份失败: {0}")]
    Backup(String),
    #[error("回滚失败（备份仍保留在 {0}）")]
    Rollback(String),
}

/// 解压总大小上限（1 GB）与文件数上限。
const MAX_EXTRACT_SIZE: u64 = 1 << 30;
const MAX_ENTRIES: usize = 10_000;

/// 确认主程序已退出：尝试以写方式打开 exe——Windows 上映像被加载时会共享冲突。
/// exe 不存在视为"已退出"（首次安装/被移动）。
pub fn ensure_app_exited(app_exe: &Path) -> Result<(), ApplyError> {
    #[cfg(not(windows))]
    {
        let _ = app_exe;
        Err(ApplyError::UnsupportedPlatform)
    }
    #[cfg(windows)]
    {
        if !app_exe.exists() {
            return Ok(());
        }
        match fs::OpenOptions::new().write(true).open(app_exe) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                Err(ApplyError::AppStillRunning)
            }
            Err(_) => Err(ApplyError::AppStillRunning),
        }
    }
}

/// 安全解包 payload.zip 到 staging（ZIP Slip/绝对路径/大小/数量防护；不解符号链接）。
pub fn extract_payload(payload: &[u8], staging: &Path) -> Result<Vec<PathBuf>, ApplyError> {
    let reader = std::io::Cursor::new(payload);
    let mut zip =
        zip::ZipArchive::new(reader).map_err(|e| ApplyError::BadArchive(e.to_string()))?;
    if zip.len() > MAX_ENTRIES {
        return Err(ApplyError::BadArchive("文件数量超限".into()));
    }
    fs::create_dir_all(staging)?;
    let mut total: u64 = 0;
    let mut files = Vec::new();
    for i in 0..zip.len() {
        let entry = zip
            .by_index(i)
            .map_err(|e| ApplyError::BadArchive(e.to_string()))?;
        let name = entry.name().to_string();
        if name.starts_with('/')
            || name.contains("..")
            || name.contains('\\')
            || (name.len() > 1 && name.as_bytes()[1] == b':')
        {
            return Err(ApplyError::UnsafePath(name));
        }
        if entry.is_dir() {
            fs::create_dir_all(staging.join(&name))?;
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > MAX_EXTRACT_SIZE {
            return Err(ApplyError::TooLarge);
        }
        let dest = staging.join(&name);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .take(MAX_EXTRACT_SIZE)
            .read_to_end(&mut buf)
            .map_err(|e| ApplyError::BadArchive(e.to_string()))?;
        fs::write(&dest, &buf)?;
        files.push(PathBuf::from(name));
    }
    Ok(files)
}

/// 备份将被替换的文件到 backup_dir（保持相对路径）。
fn backup_files(app_root: &Path, files: &[PathBuf], backup_dir: &Path) -> Result<(), ApplyError> {
    for rel in files {
        let src = app_root.join(rel);
        if !src.exists() {
            continue; // 新增文件无需备份
        }
        let dst = backup_dir.join(rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&src, &dst).map_err(|e| ApplyError::Backup(format!("{rel:?}: {e}")))?;
    }
    Ok(())
}

/// 应用更新：备份 → 逐文件替换（先写临时名再 rename，单文件原子）。
/// 返回备份目录路径（启动失败时供回滚）。
pub fn apply_update(
    app_root: &Path,
    staging: &Path,
    files: &[PathBuf],
    backup_root: &Path,
    old_version: &str,
) -> Result<PathBuf, ApplyError> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup_dir = backup_root.join(format!("{old_version}-{ts}"));
    fs::create_dir_all(&backup_dir)?;
    backup_files(app_root, files, &backup_dir)?;

    for rel in files {
        let new_file = staging.join(rel);
        let target = app_root.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        // 先落临时名，再 rename 覆盖（同卷 rename 原子）
        let tmp = target.with_extension("useful-new");
        fs::copy(&new_file, &tmp)?;
        if target.exists() {
            fs::remove_file(&target)?;
        }
        fs::rename(&tmp, &target)?;
    }
    Ok(backup_dir)
}

/// 回滚：把备份目录内容复制回 app_root。
pub fn rollback(app_root: &Path, backup_dir: &Path) -> Result<(), ApplyError> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for e in fs::read_dir(dir)? {
            let e = e?;
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out)?;
            } else if let Ok(rel) = p.strip_prefix(base) {
                out.push(rel.to_path_buf());
            }
        }
        Ok(())
    }
    let mut rels = Vec::new();
    walk(backup_dir, backup_dir, &mut rels)
        .map_err(|e| ApplyError::Rollback(format!("{}: {e}", backup_dir.display())))?;
    for rel in rels {
        let src = backup_dir.join(&rel);
        let dst = app_root.join(&rel);
        if let Some(parent) = dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::copy(&src, &dst)
            .map_err(|e| ApplyError::Rollback(format!("{}: {e}", backup_dir.display())))?;
    }
    Ok(())
}

/// 清理过期备份：按修改时间保留最近 keep 个，其余删除。
pub fn cleanup_backups(backup_root: &Path, keep: usize) -> Result<usize, ApplyError> {
    if !backup_root.exists() {
        return Ok(0);
    }
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(backup_root)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let t = e.metadata().and_then(|m| m.modified()).ok()?;
            Some((t, e.path()))
        })
        .collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.0)); // 新→旧
    let mut removed = 0;
    for (_, p) in dirs.into_iter().skip(keep) {
        if fs::remove_dir_all(&p).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, data) in entries {
                zw.start_file(*name, opts).unwrap();
                zw.write_all(data).unwrap();
            }
            zw.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn extract_apply_and_rollback_cycle() {
        // 验收：更新失败后旧版本仍可启动（回滚恢复旧文件）
        let tmp = tempfile::tempdir().unwrap();
        let app_root = tmp.path();
        fs::write(app_root.join("Useful.exe"), b"old-exe-v1").unwrap();
        fs::write(app_root.join("data.dat"), b"keep-me").unwrap();

        let payload = make_zip(&[("Useful.exe", b"new-exe-v2" as &[u8])]);
        let staging = app_root.join("update/staging");
        let files = extract_payload(&payload, &staging).unwrap();
        assert_eq!(files, vec![PathBuf::from("Useful.exe")]);

        let backup_root = app_root.join("backup");
        let backup_dir = apply_update(app_root, &staging, &files, &backup_root, "0.1.0").unwrap();
        assert_eq!(
            fs::read(app_root.join("Useful.exe")).unwrap(),
            b"new-exe-v2"
        );
        assert_eq!(fs::read(app_root.join("data.dat")).unwrap(), b"keep-me");

        // 模拟启动失败 → 回滚
        rollback(app_root, &backup_dir).unwrap();
        assert_eq!(
            fs::read(app_root.join("Useful.exe")).unwrap(),
            b"old-exe-v1"
        );
        assert_eq!(fs::read(app_root.join("data.dat")).unwrap(), b"keep-me");
    }

    #[test]
    fn zip_slip_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for evil in ["../evil.exe", "/abs.exe", "a\\b.exe", "C:evil.exe"] {
            let payload = make_zip(&[(evil, b"x" as &[u8])]);
            assert!(
                extract_payload(&payload, &tmp.path().join("s")).is_err(),
                "必须拒绝不安全路径: {evil}"
            );
        }
    }

    #[test]
    fn corrupt_archive_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(extract_payload(b"not a zip", &tmp.path().join("s")).is_err());
    }

    #[test]
    fn cleanup_keeps_recent_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("backup");
        for i in 0..5 {
            let d = root.join(format!("0.1.{i}-100{i}"));
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("f"), b"x").unwrap();
            // 保证 mtime 单调可比
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let removed = cleanup_backups(&root, 2).unwrap();
        assert_eq!(removed, 3);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
    }

    #[test]
    #[cfg(windows)]
    fn ensure_exited_ok_when_missing_or_closed() {
        let tmp = tempfile::tempdir().unwrap();
        // 不存在 → OK
        ensure_app_exited(&tmp.path().join("Useful.exe")).unwrap();
        // 已关闭的文件 → OK
        let exe = tmp.path().join("Useful.exe");
        fs::write(&exe, b"exe").unwrap();
        ensure_app_exited(&exe).unwrap();
    }

    #[test]
    #[cfg(not(windows))]
    fn ensure_exited_fails_closed_on_unsupported_platforms() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(matches!(
            ensure_app_exited(&tmp.path().join("Useful")),
            Err(ApplyError::UnsupportedPlatform)
        ));
    }
}
