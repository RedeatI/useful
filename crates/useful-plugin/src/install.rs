//! 插件安装管线：staging → 校验 → 原子移动 → 回滚。
//!
//! 安装路径：`data/plugins/<plugin-id>/<version>/`
//! 全流程任一步失败都完整回滚，绝不留下半安装状态。

use crate::error::PluginError;
use crate::manifest::PluginManifest;
use crate::zip_safety;
use std::path::{Path, PathBuf};

/// Stable prefix returned when an interrupted install could not be restored
/// completely and the orphan requires operator cleanup before it may be used.
pub const INSTALL_RECOVERY_REQUIRED: &str = "INSTALL_RECOVERY_REQUIRED";
const RECOVERY_MARKER_FILE: &str = ".useful-install-recovery-required";

/// 安装选项。
pub struct InstallOptions {
    /// 压缩包大小上限
    pub max_package_size: u64,
    /// 解压后总大小上限
    pub max_uncompressed_size: u64,
    /// 期望 SHA-256（来自源索引）；本地导入可为 None
    pub expected_sha256: Option<String>,
    /// 宿主版本
    pub host_version: String,
    /// 已安装版本（用于降级检测）；首次安装为 None
    pub installed_version: Option<String>,
    /// 是否允许降级（用户在 UI 明确选择“降级”时为 true）
    pub allow_downgrade: bool,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            max_package_size: zip_safety::DEFAULT_MAX_PACKAGE_SIZE,
            max_uncompressed_size: zip_safety::DEFAULT_MAX_UNCOMPRESSED_SIZE,
            expected_sha256: None,
            host_version: "0.1.0".into(),
            installed_version: None,
            allow_downgrade: false,
        }
    }
}

/// 安装结果。
#[derive(Debug)]
pub struct InstallOutcome {
    pub manifest: PluginManifest,
    pub install_dir: PathBuf,
    pub sha256: String,
    transaction: InstallTransaction,
}

impl InstallOutcome {
    /// Finalize the filesystem side of an install after all durable state and
    /// in-process registration have committed. Any replaced same-version
    /// directory is no longer needed after this point.
    pub fn commit(mut self) {
        self.transaction.commit();
    }

    /// Restore the exact pre-install filesystem state. This is used when a
    /// database or registry write fails after the package was made visible.
    pub fn rollback(mut self) -> Result<(), PluginError> {
        self.transaction.rollback()
    }
}

#[derive(Debug)]
struct InstallTransaction {
    destination: PathBuf,
    replaced: Option<PathBuf>,
    finalized: bool,
}

impl InstallTransaction {
    fn new(destination: PathBuf, replaced: Option<PathBuf>) -> Self {
        Self {
            destination,
            replaced,
            finalized: false,
        }
    }

    fn commit(&mut self) {
        self.finalized = true;
        if let Some(replaced) = self.replaced.take() {
            // The installed version is already durably pinned in SQLite and
            // the registry. A stale hidden backup is safer than undoing that
            // commit if cleanup is interrupted.
            let _ = std::fs::remove_dir_all(replaced);
        }
    }

    fn rollback(&mut self) -> Result<(), PluginError> {
        if self.finalized {
            return Ok(());
        }
        let mut failures = Vec::new();
        if self.destination.exists() {
            if let Err(remove_error) = std::fs::remove_dir_all(&self.destination) {
                let quarantine = self
                    .destination
                    .with_extension(format!("orphan-recovery-required-{}", uuid::Uuid::new_v4()));
                match std::fs::rename(&self.destination, &quarantine) {
                    Ok(()) => {
                        let marker = quarantine.join(RECOVERY_MARKER_FILE);
                        if let Err(marker_error) = std::fs::write(
                            marker,
                            "This directory is an incomplete install and must not be loaded.\n",
                        ) {
                            failures.push(format!(
                                "隔离未完成安装后写 recovery marker 失败: {marker_error}"
                            ));
                        }
                        failures.push(format!(
                            "删除未完成安装失败，已隔离为 orphan: {remove_error}"
                        ));
                    }
                    Err(quarantine_error) => {
                        let marker = self.destination.join(RECOVERY_MARKER_FILE);
                        let marker_result = std::fs::write(
                            marker,
                            "This directory is an incomplete install and must not be loaded.\n",
                        );
                        failures.push(format!(
                            "删除未完成安装失败 ({remove_error})，且无法隔离 ({quarantine_error}){}",
                            marker_result
                                .err()
                                .map(|error| format!("，recovery marker 也写入失败 ({error})"))
                                .unwrap_or_default()
                        ));
                    }
                }
            }
        }
        if let Some(replaced) = self.replaced.take() {
            if let Err(error) = std::fs::rename(&replaced, &self.destination) {
                let marker_result = std::fs::write(
                    replaced.join(RECOVERY_MARKER_FILE),
                    "This directory is the hidden pre-install version; manual recovery is required.\n",
                );
                failures.push(format!(
                    "恢复被替换版本失败: {error}{}",
                    marker_result
                        .err()
                        .map(|marker_error| format!(
                            "，recovery marker 也写入失败 ({marker_error})"
                        ))
                        .unwrap_or_default()
                ));
            }
        }
        self.finalized = true;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(PluginError::InstallRolledBack(format!(
                "{INSTALL_RECOVERY_REQUIRED}: {}",
                failures.join("; ")
            )))
        }
    }
}

impl Drop for InstallTransaction {
    fn drop(&mut self) {
        let _ = self.rollback();
    }
}

/// 执行完整安装管线。
///
/// - `archive_path`: .useful 包（已下载到临时目录/或本地选择）
/// - `staging_root`: staging 根目录（data/staging）
/// - `plugins_root`: 正式插件根目录（data/plugins）
pub fn install_useful(
    archive_path: &Path,
    staging_root: &Path,
    plugins_root: &Path,
    opts: &InstallOptions,
) -> Result<InstallOutcome, PluginError> {
    // 3) 验证文件大小上限
    let size = std::fs::metadata(archive_path)?.len();
    if size > opts.max_package_size {
        return Err(PluginError::SizeExceeded {
            actual: size,
            limit: opts.max_package_size,
        });
    }

    // 4) 验证 SHA-256（若提供期望值）
    let actual_sha = zip_safety::sha256_file(archive_path)?;
    if let Some(expected) = &opts.expected_sha256 {
        if !actual_sha.eq_ignore_ascii_case(expected) {
            return Err(PluginError::HashMismatch {
                expected: expected.clone(),
                actual: actual_sha,
            });
        }
    }

    // 6) 先只读取 manifest 校验（含 5：路径穿越在 schema/语义中拦截）
    let manifest_bytes = zip_safety::read_manifest_bytes(archive_path)?;
    let manifest = PluginManifest::parse_and_validate(&manifest_bytes)?;

    // 7) 校验平台
    if !manifest.supports_windows_x64() {
        return Err(PluginError::VersionIncompatible(
            "插件不支持 windows-x64".into(),
        ));
    }

    // 8) 宿主版本兼容
    manifest.check_host_version(&opts.host_version)?;

    // 版本降级检测（防降级攻击）
    if let Some(installed) = &opts.installed_version {
        let cur = semver::Version::parse(installed)
            .map_err(|e| PluginError::VersionIncompatible(e.to_string()))?;
        let cand = semver::Version::parse(&manifest.version)
            .map_err(|e| PluginError::VersionIncompatible(e.to_string()))?;
        if cand < cur && !opts.allow_downgrade {
            return Err(PluginError::DowngradeRejected {
                installed: installed.clone(),
                candidate: manifest.version.clone(),
            });
        }
    }

    // 2) 写入 staging：解压到唯一 staging 目录
    std::fs::create_dir_all(staging_root)?;
    let staging_dir = staging_root.join(format!(
        "{}-{}-{}",
        sanitize_component(&manifest.id),
        manifest.version,
        uuid::Uuid::new_v4()
    ));
    // UUID 路径必须由本次安装独占；若碰撞则直接失败，绝不复用残留目录。
    std::fs::create_dir(&staging_dir)?;

    // 用闭包承载可能失败的步骤，失败时统一回滚 staging
    let result = (|| -> Result<(PathBuf, Option<PathBuf>), PluginError> {
        zip_safety::extract_zip_safely(archive_path, &staging_dir, opts.max_uncompressed_size)?;

        // 复核解压后的 manifest 与包外 manifest 一致
        let extracted_manifest_path = staging_dir.join("manifest.json");
        if !extracted_manifest_path.exists() {
            return Err(PluginError::ManifestInvalid(
                "解压后缺少 manifest.json".into(),
            ));
        }
        let extracted_bytes = std::fs::read(&extracted_manifest_path)?;
        let extracted_manifest = PluginManifest::parse_and_validate(&extracted_bytes)?;
        if extracted_manifest.id != manifest.id || extracted_manifest.version != manifest.version {
            return Err(PluginError::IdConflict(
                "解压后的 manifest 与预检不一致".into(),
            ));
        }

        // web 入口必须存在
        if manifest.entry.entry_type == crate::manifest::EntryType::Web {
            let entry_file = staging_dir.join(&manifest.entry.path);
            if !entry_file.exists() {
                return Err(PluginError::ManifestInvalid(format!(
                    "web 入口文件不存在: {}",
                    manifest.entry.path
                )));
            }
        }

        for action in &manifest.contributes.actions {
            let action_file = staging_dir.join(&action.path);
            let metadata = std::fs::symlink_metadata(&action_file).map_err(|_| {
                PluginError::ManifestInvalid(format!("action spec 文件不存在: {}", action.path))
            })?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(PluginError::ManifestInvalid(format!(
                    "action spec 必须是普通文件: {}",
                    action.path
                )));
            }
        }

        // 11) 原子移动到正式目录：data/plugins/<id>/<version>/
        let dest_dir = plugins_root
            .join(sanitize_component(&manifest.id))
            .join(&manifest.version);
        std::fs::create_dir_all(dest_dir.parent().unwrap())?;

        // 若目标已存在（重装相同版本），先移到临时备份，成功后删除
        let mut backup: Option<PathBuf> = None;
        if dest_dir.exists() {
            let b = dest_dir.with_extension(format!("old-{}", uuid::Uuid::new_v4()));
            std::fs::rename(&dest_dir, &b)?;
            backup = Some(b);
        }

        match std::fs::rename(&staging_dir, &dest_dir) {
            Ok(()) => Ok((dest_dir, backup)),
            Err(rename_error) => {
                // 跨卷 rename 可能失败。先在目标卷的私有目录完整复制，再原子切换，
                // 绝不把复制中的目录暴露为当前版本。
                let copy_dir = dest_dir.with_extension(format!("copy-{}", uuid::Uuid::new_v4()));
                match copy_dir_all(&staging_dir, &copy_dir)
                    .and_then(|_| std::fs::rename(&copy_dir, &dest_dir))
                {
                    Ok(()) => {
                        if let Err(cleanup_error) = std::fs::remove_dir_all(&staging_dir) {
                            let mut transaction = InstallTransaction::new(dest_dir.clone(), backup);
                            let rollback = transaction.rollback();
                            return Err(PluginError::InstallRolledBack(match rollback {
                                Ok(()) => format!(
                                    "目标卷副本切换后清理 staging 失败并已回滚: {cleanup_error}"
                                ),
                                Err(error) => format!(
                                    "目标卷副本切换后清理 staging 失败: {cleanup_error}; {error}"
                                ),
                            }));
                        }
                        Ok((dest_dir, backup))
                    }
                    Err(copy_error) => {
                        let mut rollback_failures = Vec::new();
                        if copy_dir.exists() {
                            if let Err(error) = std::fs::remove_dir_all(&copy_dir) {
                                rollback_failures.push(format!("清理不完整副本失败: {error}"));
                            }
                        }
                        if let Some(replaced) = backup {
                            if let Err(error) = std::fs::rename(&replaced, &dest_dir) {
                                let _ = std::fs::write(
                                    replaced.join(RECOVERY_MARKER_FILE),
                                    "This directory is the hidden pre-install version; manual recovery is required.\n",
                                );
                                rollback_failures.push(format!("恢复被替换版本失败: {error}"));
                            }
                        }
                        let recovery = if rollback_failures.is_empty() {
                            String::new()
                        } else {
                            format!(
                                "; {INSTALL_RECOVERY_REQUIRED}: {}",
                                rollback_failures.join("; ")
                            )
                        };
                        Err(PluginError::InstallRolledBack(format!(
                            "原子移动失败: {rename_error}; 目标卷副本切换失败: {copy_error}{recovery}"
                        )))
                    }
                }
            }
        }
    })();

    match result {
        Ok((install_dir, replaced)) => Ok(InstallOutcome {
            manifest,
            transaction: InstallTransaction::new(install_dir.clone(), replaced),
            install_dir,
            sha256: actual_sha,
        }),
        Err(e) => {
            // 13) 失败完整回滚：清理 staging
            let staging_rollback = if staging_dir.exists() {
                std::fs::remove_dir_all(&staging_dir).err()
            } else {
                None
            };
            let original = match e {
                PluginError::InstallRolledBack(message) => message,
                other => other.to_string(),
            };
            Err(PluginError::InstallRolledBack(match staging_rollback {
                Some(error) => format!("{original}; staging rollback 失败: {error}"),
                None => original,
            }))
        }
    }
}

/// 卸载：删除某插件的整个目录（所有版本）。
pub fn uninstall(plugins_root: &Path, plugin_id: &str) -> Result<(), PluginError> {
    let dir = plugins_root.join(sanitize_component(plugin_id));
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

/// 卸载单个版本（回滚到上一版本时删除新版本目录）。
pub fn uninstall_version(
    plugins_root: &Path,
    plugin_id: &str,
    version: &str,
) -> Result<(), PluginError> {
    let dir = plugins_root
        .join(sanitize_component(plugin_id))
        .join(version);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

/// 将插件 ID 转为安全的目录名分量（防注入路径分隔符）。
pub fn sanitize_component(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    let result = (|| {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            let target = dst.join(entry.file_name());
            if ty.is_dir() {
                copy_dir_all(&entry.path(), &target)?;
            } else {
                std::fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dst);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{copy_dir_all, InstallTransaction};

    #[test]
    fn failed_copy_removes_its_partial_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("first.txt"), "copied before the failure").unwrap();
        std::fs::write(source.join("blocked"), "cannot overwrite a directory").unwrap();
        std::fs::create_dir_all(destination.join("blocked")).unwrap();

        assert!(copy_dir_all(&source, &destination).is_err());
        assert!(
            !destination.exists(),
            "partial copy directory must be removed"
        );
    }

    #[test]
    fn pending_install_rolls_back_replaced_directory() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("plugin");
        let replaced = root.path().join("plugin.old");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(destination.join("version.txt"), "new").unwrap();
        std::fs::create_dir_all(&replaced).unwrap();
        std::fs::write(replaced.join("version.txt"), "old").unwrap();

        let mut transaction = InstallTransaction::new(destination.clone(), Some(replaced));
        transaction.rollback().unwrap();

        assert_eq!(
            std::fs::read_to_string(destination.join("version.txt")).unwrap(),
            "old"
        );
    }

    #[test]
    fn committed_install_keeps_new_directory() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("plugin");
        let replaced = root.path().join("plugin.old");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(destination.join("version.txt"), "new").unwrap();
        std::fs::create_dir_all(&replaced).unwrap();
        std::fs::write(replaced.join("version.txt"), "old").unwrap();

        let mut transaction = InstallTransaction::new(destination.clone(), Some(replaced.clone()));
        transaction.commit();

        assert_eq!(
            std::fs::read_to_string(destination.join("version.txt")).unwrap(),
            "new"
        );
        assert!(!replaced.exists());
    }
}
