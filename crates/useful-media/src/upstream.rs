//! Build-pinned upstream media runtime installation.
//!
//! Useful downloads the original ZIP assets published by the upstream projects. The renderer can
//! select only a pack id; URLs, sizes, archive hashes, selected paths, and extracted-file hashes
//! are compiled into the application from `scripts/media-runtimes.upstream.lock.json`.

use crate::pack::{
    sha256_file, sha256_hex, MediaPackError, Result, MAX_ARCHIVE_BYTES, MAX_SMALL_ASSET_BYTES,
};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tempfile::{Builder, NamedTempFile};
use url::Url;

pub const UPSTREAM_LOCK_SCHEMA: &str = "useful.media-runtimes-upstream.v1";
const POINTER_SCHEMA: &str = "useful.upstream-runtime-current.v1";
const RECEIPT_SCHEMA: &str = "useful.upstream-runtime-installed.v1";
const LOCK_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../scripts/media-runtimes.upstream.lock.json"
));

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpstreamRuntimeLock {
    pub schema_version: String,
    pub platform: String,
    pub arch: String,
    pub packs: Vec<UpstreamPack>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpstreamPack {
    pub id: String,
    pub version: String,
    pub provider: String,
    pub provider_page_url: String,
    pub source_code_url: String,
    pub license: String,
    pub minimum_useful_version: String,
    pub archive: UpstreamAsset,
    pub files: Vec<UpstreamFile>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpstreamAsset {
    pub url: String,
    pub file_name: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpstreamFile {
    pub component: Option<String>,
    pub source_path: String,
    pub target_name: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpstreamPointer {
    schema_version: String,
    pack_id: String,
    spec_sha256: String,
    relative_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpstreamReceipt {
    schema_version: String,
    status: String,
    pack_id: String,
    spec_sha256: String,
    archive_url: String,
    archive_sha256: String,
}

#[derive(Debug, Clone)]
pub struct UpstreamInstalledStatus {
    pub current_relative_path: Option<String>,
    pub previous_available: bool,
    pub damaged: bool,
}

pub struct UpstreamInstallInput<'a> {
    pub pack: &'a UpstreamPack,
    pub archive_path: &'a Path,
    pub install_root: &'a Path,
    pub current_useful_version: &'a str,
}

pub fn built_in_lock() -> Result<UpstreamRuntimeLock> {
    let lock: UpstreamRuntimeLock = serde_json::from_slice(LOCK_BYTES)?;
    validate_lock(&lock)?;
    Ok(lock)
}

pub fn built_in_lock_sha256() -> String {
    sha256_hex(LOCK_BYTES)
}

pub fn built_in_pack(pack_id: &str) -> Result<UpstreamPack> {
    validate_pack_id(pack_id)?;
    built_in_lock()?
        .packs
        .into_iter()
        .find(|pack| pack.id == pack_id)
        .ok_or_else(|| MediaPackError::InvalidSchema("missing upstream pack".into()))
}

fn validate_lock(lock: &UpstreamRuntimeLock) -> Result<()> {
    if lock.schema_version != UPSTREAM_LOCK_SCHEMA
        || lock.platform != "windows"
        || lock.arch != "x64"
    {
        return Err(MediaPackError::InvalidSchema(
            "upstream lock identity".into(),
        ));
    }
    let ids: BTreeSet<&str> = lock.packs.iter().map(|pack| pack.id.as_str()).collect();
    if ids != BTreeSet::from(["preview", "transcode"]) || ids.len() != lock.packs.len() {
        return Err(MediaPackError::InvalidSchema(
            "upstream pack closure".into(),
        ));
    }
    for pack in &lock.packs {
        validate_pack(pack)?;
    }
    Ok(())
}

fn validate_pack(pack: &UpstreamPack) -> Result<()> {
    validate_pack_id(&pack.id)?;
    Version::parse(&pack.minimum_useful_version)
        .map_err(|_| MediaPackError::InvalidSchema("minimum Useful version".into()))?;
    if pack.version.trim().is_empty()
        || pack.provider.trim().is_empty()
        || pack.license.trim().is_empty()
    {
        return Err(MediaPackError::InvalidSchema("upstream pack facts".into()));
    }
    validate_url(&pack.provider_page_url, "provider page URL")?;
    validate_url(&pack.source_code_url, "source code URL")?;
    validate_url(&pack.archive.url, "archive URL")?;
    validate_basename(&pack.archive.file_name, "archive filename")?;
    validate_sha(&pack.archive.sha256, "archive SHA-256")?;
    if pack.archive.size_bytes == 0 || pack.archive.size_bytes > MAX_ARCHIVE_BYTES {
        return Err(MediaPackError::InvalidSchema("archive size".into()));
    }
    let archive_url = Url::parse(&pack.archive.url)
        .map_err(|_| MediaPackError::InvalidSchema("archive URL".into()))?;
    if archive_url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        != Some(pack.archive.file_name.as_str())
    {
        return Err(MediaPackError::InvalidSchema("archive URL basename".into()));
    }
    validate_provider_binding(pack, &archive_url)?;

    let expected_components: BTreeSet<&str> = match pack.id.as_str() {
        "preview" => BTreeSet::from(["mpv"]),
        "transcode" => BTreeSet::from(["ffmpeg", "ffprobe"]),
        _ => unreachable!(),
    };
    let actual_components: BTreeSet<&str> = pack
        .files
        .iter()
        .filter_map(|file| file.component.as_deref())
        .collect();
    if actual_components != expected_components {
        return Err(MediaPackError::InvalidSchema(
            "upstream component closure".into(),
        ));
    }
    let mut source_paths = BTreeSet::new();
    let mut target_names = BTreeSet::new();
    let mut expanded = 0u64;
    for file in &pack.files {
        validate_archive_path(&file.source_path)?;
        validate_basename(&file.target_name, "target filename")?;
        validate_sha(&file.sha256, "file SHA-256")?;
        if file.size_bytes == 0 || file.size_bytes > MAX_ARCHIVE_BYTES {
            return Err(MediaPackError::InvalidSchema("file size".into()));
        }
        expanded = expanded.saturating_add(file.size_bytes);
        if expanded > MAX_ARCHIVE_BYTES.saturating_mul(2) {
            return Err(MediaPackError::InvalidSchema("expanded size".into()));
        }
        if !source_paths.insert(file.source_path.to_ascii_lowercase())
            || !target_names.insert(file.target_name.to_ascii_lowercase())
        {
            return Err(MediaPackError::InvalidSchema(
                "duplicate upstream file".into(),
            ));
        }
        if let Some(component) = &file.component {
            if file.target_name != format!("{component}.exe") {
                return Err(MediaPackError::InvalidSchema(
                    "component filename mapping".into(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_provider_binding(pack: &UpstreamPack, archive_url: &Url) -> Result<()> {
    let valid = match pack.id.as_str() {
        "preview" => {
            pack.provider_page_url == "https://mpv.io/installation/"
                && archive_url.host_str() == Some("github.com")
                && archive_url
                    .path()
                    .starts_with("/mpv-player/mpv/releases/download/v")
                && pack
                    .source_code_url
                    .starts_with("https://github.com/mpv-player/mpv/tree/v")
        }
        "transcode" => {
            pack.provider_page_url == "https://ffmpeg.org/download.html"
                && archive_url.host_str() == Some("www.gyan.dev")
                && archive_url.path().starts_with("/ffmpeg/builds/packages/")
                && pack
                    .source_code_url
                    .starts_with("https://ffmpeg.org/releases/ffmpeg-")
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(MediaPackError::InvalidSchema(
            "upstream provider binding".into(),
        ))
    }
}

fn validate_pack_id(value: &str) -> Result<()> {
    if matches!(value, "preview" | "transcode") {
        Ok(())
    } else {
        Err(MediaPackError::InvalidSchema("pack id".into()))
    }
}

fn validate_url(value: &str, label: &str) -> Result<()> {
    let url = Url::parse(value).map_err(|_| MediaPackError::InvalidSchema(label.into()))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(MediaPackError::InvalidSchema(label.into()));
    }
    Ok(())
}

fn validate_basename(value: &str, label: &str) -> Result<()> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 180
        || matches!(value, "." | "..")
        || path.file_name().and_then(|item| item.to_str()) != Some(value)
        || value.contains(['/', '\\', ':'])
    {
        return Err(MediaPackError::InvalidSchema(label.into()));
    }
    Ok(())
}

fn validate_archive_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains(['\\', ':', '\0'])
        || value
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(MediaPackError::UnsafePath(value.into()));
    }
    Ok(())
}

fn validate_sha(value: &str, label: &str) -> Result<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(MediaPackError::InvalidSchema(label.into()))
    }
}

fn spec_bytes(pack: &UpstreamPack) -> Result<Vec<u8>> {
    Ok(format!("{}\n", serde_json::to_string_pretty(pack)?).into_bytes())
}

fn spec_sha256(pack: &UpstreamPack) -> Result<String> {
    Ok(sha256_hex(&spec_bytes(pack)?))
}

fn pointer_path(root: &Path, pack_id: &str, previous: bool) -> PathBuf {
    root.join(if previous {
        format!("upstream-current-{pack_id}.previous.json")
    } else {
        format!("upstream-current-{pack_id}.json")
    })
}

fn target_path(root: &Path, pointer: &UpstreamPointer) -> PathBuf {
    root.join("upstream")
        .join(&pointer.spec_sha256)
        .join(&pointer.pack_id)
}

pub fn install_upstream_pack(input: UpstreamInstallInput<'_>) -> Result<()> {
    validate_pack(input.pack)?;
    let current = Version::parse(input.current_useful_version)
        .map_err(|_| MediaPackError::InvalidSchema("current Useful version".into()))?;
    let minimum = Version::parse(&input.pack.minimum_useful_version)
        .map_err(|_| MediaPackError::InvalidSchema("minimum Useful version".into()))?;
    if current < minimum {
        return Err(MediaPackError::IncompatibleVersion {
            current: current.to_string(),
            minimum: minimum.to_string(),
        });
    }
    verify_archive(input.archive_path, &input.pack.archive)?;
    ensure_directory(input.install_root)?;
    let upstream_root = input.install_root.join("upstream");
    ensure_directory(&upstream_root)?;
    let fingerprint = spec_sha256(input.pack)?;
    let pointer = UpstreamPointer {
        schema_version: POINTER_SCHEMA.into(),
        pack_id: input.pack.id.clone(),
        spec_sha256: fingerprint.clone(),
        relative_path: format!("upstream/{fingerprint}/{}", input.pack.id),
    };
    let version_root = upstream_root.join(&fingerprint);
    ensure_directory(&version_root)?;
    let target = version_root.join(&input.pack.id);
    if target.exists() && validate_installed(input.install_root, input.pack, &pointer).is_ok() {
        if read_pointer(input.install_root, &input.pack.id, false)
            .ok()
            .is_some_and(|active| active.relative_path == pointer.relative_path)
        {
            return Err(MediaPackError::AlreadyInstalled(
                target.to_string_lossy().into_owned(),
            ));
        }
        activate_pointer(input.install_root, &pointer)?;
        return Ok(());
    }

    let staging = Builder::new()
        .prefix(".upstream-staging-")
        .tempdir_in(&upstream_root)?;
    let payload = staging.path().join("payload");
    fs::create_dir(&payload)?;
    extract_selected_files(input.archive_path, &payload, input.pack)?;
    fs::write(
        payload.join("UPSTREAM-RUNTIME.json"),
        spec_bytes(input.pack)?,
    )?;
    let receipt = UpstreamReceipt {
        schema_version: RECEIPT_SCHEMA.into(),
        status: "verified".into(),
        pack_id: input.pack.id.clone(),
        spec_sha256: fingerprint,
        archive_url: input.pack.archive.url.clone(),
        archive_sha256: input.pack.archive.sha256.clone(),
    };
    fs::write(
        payload.join("INSTALLED-UPSTREAM.json"),
        format!("{}\n", serde_json::to_string_pretty(&receipt)?),
    )?;

    let damaged_backup = if target.exists() {
        let backup = version_root.join(format!(
            ".damaged-{}-{}",
            input.pack.id,
            uuid::Uuid::new_v4().simple()
        ));
        fs::rename(&target, &backup)?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = fs::rename(&payload, &target) {
        if let Some(backup) = &damaged_backup {
            let _ = fs::rename(backup, &target);
        }
        return Err(error.into());
    }
    activate_pointer(input.install_root, &pointer)
}

fn verify_archive(path: &Path, asset: &UpstreamAsset) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || is_reparse_point(&metadata)
        || !metadata.is_file()
        || metadata.len() != asset.size_bytes
        || sha256_file(path)? != asset.sha256
    {
        return Err(MediaPackError::AssetMismatch("upstream archive".into()));
    }
    Ok(())
}

fn extract_selected_files(
    archive_path: &Path,
    destination: &Path,
    pack: &UpstreamPack,
) -> Result<()> {
    let file = File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let expected: BTreeMap<String, &UpstreamFile> = pack
        .files
        .iter()
        .map(|file| (file.source_path.to_ascii_lowercase(), file))
        .collect();
    let mut seen = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let key = name.to_ascii_lowercase();
        let Some(expected_file) = expected.get(&key) else {
            continue;
        };
        if name != expected_file.source_path
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || !seen.insert(key)
        {
            return Err(MediaPackError::UnsafeArchive(name));
        }
        if entry.size() != expected_file.size_bytes {
            return Err(MediaPackError::AssetMismatch(
                expected_file.target_name.clone(),
            ));
        }
        let target = destination.join(&expected_file.target_name);
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        let mut digest = Sha256::new();
        let mut written = 0u64;
        let mut buffer = [0u8; 128 * 1024];
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            written = written.saturating_add(read as u64);
            if written > expected_file.size_bytes {
                return Err(MediaPackError::UnsafeArchive(
                    "selected entry expanded past limit".into(),
                ));
            }
            output.write_all(&buffer[..read])?;
            digest.update(&buffer[..read]);
        }
        output.sync_all()?;
        if written != expected_file.size_bytes
            || hex::encode(digest.finalize()) != expected_file.sha256
        {
            return Err(MediaPackError::AssetMismatch(
                expected_file.target_name.clone(),
            ));
        }
    }
    if seen != expected.keys().cloned().collect() {
        return Err(MediaPackError::UnsafeArchive(
            "selected entry set is incomplete".into(),
        ));
    }
    Ok(())
}

fn pointer_bytes(pointer: &UpstreamPointer) -> Result<Vec<u8>> {
    Ok(format!("{}\n", serde_json::to_string_pretty(pointer)?).into_bytes())
}

fn activate_pointer(root: &Path, pointer: &UpstreamPointer) -> Result<()> {
    let current_path = pointer_path(root, &pointer.pack_id, false);
    if current_path.exists() {
        match read_pointer(root, &pointer.pack_id, false) {
            Ok(old) if old.relative_path != pointer.relative_path => atomic_write(
                &pointer_path(root, &pointer.pack_id, true),
                &pointer_bytes(&old)?,
            )?,
            Ok(_) => {}
            Err(_) => {
                let backup = root.join(format!(
                    ".damaged-upstream-current-{}-{}",
                    pointer.pack_id,
                    uuid::Uuid::new_v4().simple()
                ));
                fs::rename(&current_path, backup)?;
            }
        }
    }
    atomic_write(&current_path, &pointer_bytes(pointer)?)
}

fn read_pointer(root: &Path, pack_id: &str, previous: bool) -> Result<UpstreamPointer> {
    validate_pack_id(pack_id)?;
    let bytes = fs::read(pointer_path(root, pack_id, previous))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_SMALL_ASSET_BYTES {
        return Err(MediaPackError::InvalidSchema(
            "upstream pointer size".into(),
        ));
    }
    let pointer: UpstreamPointer = serde_json::from_slice(&bytes)?;
    if pointer.schema_version != POINTER_SCHEMA
        || pointer.pack_id != pack_id
        || pointer.relative_path != format!("upstream/{}/{pack_id}", pointer.spec_sha256)
    {
        return Err(MediaPackError::InvalidSchema("upstream pointer".into()));
    }
    validate_sha(&pointer.spec_sha256, "upstream pointer spec SHA-256")?;
    Ok(pointer)
}

fn validate_installed(
    root: &Path,
    pack: &UpstreamPack,
    pointer: &UpstreamPointer,
) -> Result<PathBuf> {
    if pointer.spec_sha256 != spec_sha256(pack)? || pointer.pack_id != pack.id {
        return Err(MediaPackError::InvalidSchema(
            "upstream pointer binding".into(),
        ));
    }
    let target = target_path(root, pointer);
    let canonical_root = dunce::canonicalize(root)?;
    let canonical_target = dunce::canonicalize(&target)?;
    if !canonical_target.starts_with(&canonical_root) || !canonical_target.is_dir() {
        return Err(MediaPackError::UnsafePath(
            target.to_string_lossy().into_owned(),
        ));
    }
    let manifest = fs::read(canonical_target.join("UPSTREAM-RUNTIME.json"))?;
    if manifest != spec_bytes(pack)? {
        return Err(MediaPackError::AssetMismatch("upstream manifest".into()));
    }
    let receipt_bytes = fs::read(canonical_target.join("INSTALLED-UPSTREAM.json"))?;
    if receipt_bytes.is_empty() || receipt_bytes.len() as u64 > MAX_SMALL_ASSET_BYTES {
        return Err(MediaPackError::InvalidSchema(
            "upstream receipt size".into(),
        ));
    }
    let receipt: UpstreamReceipt = serde_json::from_slice(&receipt_bytes)?;
    if receipt.schema_version != RECEIPT_SCHEMA
        || receipt.status != "verified"
        || receipt.pack_id != pack.id
        || receipt.spec_sha256 != pointer.spec_sha256
        || receipt.archive_url != pack.archive.url
        || receipt.archive_sha256 != pack.archive.sha256
    {
        return Err(MediaPackError::InvalidSchema(
            "upstream receipt binding".into(),
        ));
    }
    let expected_names: BTreeSet<String> = pack
        .files
        .iter()
        .map(|file| file.target_name.to_ascii_lowercase())
        .chain([
            "upstream-runtime.json".into(),
            "installed-upstream.json".into(),
        ])
        .collect();
    let mut actual_names = BTreeSet::new();
    for entry in fs::read_dir(&canonical_target)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) || !metadata.is_file() {
            return Err(MediaPackError::UnsafePath(
                entry.path().to_string_lossy().into_owned(),
            ));
        }
        let name = entry
            .file_name()
            .to_str()
            .ok_or_else(|| MediaPackError::UnsafePath("non-UTF-8 installed file".into()))?
            .to_ascii_lowercase();
        if !actual_names.insert(name) {
            return Err(MediaPackError::UnsafePath(
                "case-aliased installed file".into(),
            ));
        }
    }
    if actual_names != expected_names {
        return Err(MediaPackError::AssetMismatch(
            "installed file closure".into(),
        ));
    }
    for file in &pack.files {
        let path = canonical_target.join(&file.target_name);
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink()
            || is_reparse_point(&metadata)
            || !metadata.is_file()
            || metadata.len() != file.size_bytes
            || sha256_file(&path)? != file.sha256
        {
            return Err(MediaPackError::AssetMismatch(file.target_name.clone()));
        }
    }
    Ok(canonical_target)
}

pub fn installed_status(root: &Path, pack_id: &str) -> UpstreamInstalledStatus {
    let pack = built_in_pack(pack_id).ok();
    let current_pointer = read_pointer(root, pack_id, false).ok();
    let current = pack.as_ref().and_then(|pack| {
        current_pointer
            .as_ref()
            .filter(|pointer| validate_installed(root, pack, pointer).is_ok())
    });
    let previous = pack.as_ref().and_then(|pack| {
        read_pointer(root, pack_id, true)
            .ok()
            .filter(|pointer| validate_installed(root, pack, pointer).is_ok())
    });
    UpstreamInstalledStatus {
        current_relative_path: current.map(|pointer| pointer.relative_path.clone()),
        previous_available: previous.is_some_and(|previous| {
            current_pointer
                .as_ref()
                .is_none_or(|current| current.relative_path != previous.relative_path)
        }),
        damaged: pointer_path(root, pack_id, false).exists() && current.is_none(),
    }
}

pub fn resolve_installed_component(root: &Path, pack_id: &str, file_name: &str) -> Option<PathBuf> {
    validate_basename(file_name, "component filename").ok()?;
    let pack = built_in_pack(pack_id).ok()?;
    let expected = pack
        .files
        .iter()
        .find(|file| file.component.is_some() && file.target_name == file_name)?;
    let pointer = read_pointer(root, pack_id, false).ok()?;
    let target = validate_installed(root, &pack, &pointer).ok()?;
    Some(target.join(&expected.target_name))
}

pub fn rollback(root: &Path, pack_id: &str) -> Result<()> {
    let pack = built_in_pack(pack_id)?;
    let current = read_pointer(root, pack_id, false).ok();
    let previous = read_pointer(root, pack_id, true)
        .map_err(|_| MediaPackError::NoPrevious(pack_id.into()))?;
    validate_installed(root, &pack, &previous)
        .map_err(|_| MediaPackError::NoPrevious(pack_id.into()))?;
    if current
        .as_ref()
        .is_some_and(|current| current.relative_path == previous.relative_path)
    {
        return Err(MediaPackError::NoPrevious(pack_id.into()));
    }
    atomic_write(
        &pointer_path(root, pack_id, false),
        &pointer_bytes(&previous)?,
    )
}

fn ensure_directory(path: &Path) -> Result<()> {
    let mut cursor = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => cursor.push(component.as_os_str()),
            Component::Normal(part) => {
                cursor.push(part);
                match fs::symlink_metadata(&cursor) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink()
                            || is_reparse_point(&metadata)
                            || !metadata.is_dir()
                        {
                            return Err(MediaPackError::UnsafePath(
                                cursor.to_string_lossy().into_owned(),
                            ));
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        fs::create_dir(&cursor)?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(MediaPackError::UnsafePath(
                    path.to_string_lossy().into_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| MediaPackError::UnsafePath(destination.to_string_lossy().into_owned()))?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    let temporary_path = temporary
        .into_temp_path()
        .keep()
        .map_err(|error| MediaPackError::Io(error.error))?;
    atomic_replace(&temporary_path, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| MediaPackError::Io(std::io::Error::other(error)))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination)?;
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    #[test]
    fn built_in_lock_has_exact_upstream_pack_closure() {
        let lock = built_in_lock().unwrap();
        assert_eq!(lock.packs.len(), 2);
        assert_eq!(built_in_pack("preview").unwrap().provider, "mpv project");
        assert_eq!(built_in_pack("transcode").unwrap().provider, "gyan.dev");
    }

    fn fixture_pack(archive_path: &Path) -> UpstreamPack {
        let mpv = b"verified-mpv";
        let vulkan = b"verified-vulkan";
        let file = File::create(archive_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("mpv.exe", options).unwrap();
        writer.write_all(mpv).unwrap();
        writer.start_file("vulkan-1.dll", options).unwrap();
        writer.write_all(vulkan).unwrap();
        writer.start_file("ignored/readme.txt", options).unwrap();
        writer.write_all(b"ignored").unwrap();
        writer.finish().unwrap();
        UpstreamPack {
            id: "preview".into(),
            version: "0.41.0".into(),
            provider: "mpv project".into(),
            provider_page_url: "https://mpv.io/installation/".into(),
            source_code_url: "https://github.com/mpv-player/mpv/tree/v0.41.0".into(),
            license: "GPLv2+".into(),
            minimum_useful_version: "0.1.0-beta.1".into(),
            archive: UpstreamAsset {
                url: "https://github.com/mpv-player/mpv/releases/download/v0.41.0/fixture.zip"
                    .into(),
                file_name: "fixture.zip".into(),
                sha256: sha256_file(archive_path).unwrap(),
                size_bytes: fs::metadata(archive_path).unwrap().len(),
            },
            files: vec![
                UpstreamFile {
                    component: Some("mpv".into()),
                    source_path: "mpv.exe".into(),
                    target_name: "mpv.exe".into(),
                    sha256: sha256_hex(mpv),
                    size_bytes: mpv.len() as u64,
                },
                UpstreamFile {
                    component: None,
                    source_path: "vulkan-1.dll".into(),
                    target_name: "vulkan-1.dll".into(),
                    sha256: sha256_hex(vulkan),
                    size_bytes: vulkan.len() as u64,
                },
            ],
        }
    }

    #[test]
    fn upstream_install_extracts_only_pinned_files_and_detects_tampering() {
        let downloads = tempfile::tempdir().unwrap();
        let install = tempfile::tempdir().unwrap();
        let archive = downloads.path().join("fixture.zip");
        let pack = fixture_pack(&archive);
        install_upstream_pack(UpstreamInstallInput {
            pack: &pack,
            archive_path: &archive,
            install_root: install.path(),
            current_useful_version: "0.1.0-beta.11",
        })
        .unwrap();
        let resolved =
            resolve_installed_component_for_pack(install.path(), &pack, "mpv.exe").unwrap();
        assert_eq!(fs::read(&resolved).unwrap(), b"verified-mpv");
        assert!(!resolved.parent().unwrap().join("readme.txt").exists());
        fs::write(&resolved, b"tampered-mpv").unwrap();
        assert!(resolve_installed_component_for_pack(install.path(), &pack, "mpv.exe").is_none());
    }

    #[test]
    #[ignore = "requires the two real build-pinned upstream archives"]
    fn real_build_pinned_archives_install_and_resolve() {
        let cases = [
            ("preview", "USEFUL_TEST_MPV_ARCHIVE"),
            ("transcode", "USEFUL_TEST_FFMPEG_ARCHIVE"),
        ];
        for (pack_id, environment_key) in cases {
            let archive = std::env::var_os(environment_key)
                .map(PathBuf::from)
                .unwrap_or_else(|| panic!("{environment_key} is required"));
            let install = tempfile::tempdir().unwrap();
            let pack = built_in_pack(pack_id).unwrap();
            install_upstream_pack(UpstreamInstallInput {
                pack: &pack,
                archive_path: &archive,
                install_root: install.path(),
                current_useful_version: "0.1.0-beta.11",
            })
            .unwrap();
            for file in pack.files.iter().filter(|file| file.component.is_some()) {
                assert!(
                    resolve_installed_component(install.path(), pack_id, &file.target_name)
                        .is_some()
                );
            }
        }
    }

    fn resolve_installed_component_for_pack(
        root: &Path,
        pack: &UpstreamPack,
        file_name: &str,
    ) -> Option<PathBuf> {
        let pointer = read_pointer(root, &pack.id, false).ok()?;
        let target = validate_installed(root, pack, &pointer).ok()?;
        Some(target.join(file_name))
    }
}
