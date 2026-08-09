//! MediaPack trusted-catalog validation, signed install, pointer activation, and rollback.
//!
//! Production trust is supplied by the application build. This module never accepts a key from
//! renderer input and never contains a fallback or development key.

use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tempfile::{Builder, NamedTempFile};
use thiserror::Error;
use url::Url;

pub const CATALOG_SCHEMA: &str = "useful.media-pack-catalog.v1";
pub const CATALOG_SIGNATURE_DOMAIN: &str = "useful-media-pack-catalog-v1";
pub const PACK_SCHEMA: &str = "useful.media-pack.v1";
pub const PACK_SIGNATURE_DOMAIN: &str = "useful-media-pack-v1";
pub const STATEMENT_SCHEMA: &str = "useful.media-pack-signing-statement.v1";
pub const MAX_CATALOG_BYTES: usize = 512 * 1024;
pub const MAX_CATALOG_VALIDITY_SECONDS: i64 = 31 * 24 * 60 * 60;
pub const MAX_SMALL_ASSET_BYTES: u64 = 1024 * 1024;
pub const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum MediaPackError {
    #[error("MediaPack trust configuration is unavailable")]
    TrustUnavailable,
    #[error("MediaPack signature verification failed")]
    BadSignature,
    #[error("MediaPack schema is invalid: {0}")]
    InvalidSchema(String),
    #[error("MediaPack asset verification failed: {0}")]
    AssetMismatch(String),
    #[error("MediaPack archive is unsafe: {0}")]
    UnsafeArchive(String),
    #[error("MediaPack path is unsafe: {0}")]
    UnsafePath(String),
    #[error("MediaPack is incompatible with Useful {current}; requires {minimum}")]
    IncompatibleVersion { current: String, minimum: String },
    #[error("MediaPack version is already installed: {0}")]
    AlreadyInstalled(String),
    #[error("No previous MediaPack is available for {0}")]
    NoPrevious(String),
    #[error("MediaPack I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("MediaPack JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("MediaPack ZIP failed: {0}")]
    Zip(#[from] zip::result::ZipError),
}

pub type Result<T> = std::result::Result<T, MediaPackError>;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaPackCatalog {
    pub schema_version: String,
    pub signature_domain: String,
    pub expires_at_unix: i64,
    pub packs: Vec<CatalogPack>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogPack {
    pub id: String,
    pub archive: CatalogAsset,
    pub manifest: CatalogAsset,
    pub statement: CatalogAsset,
    pub statement_signature_hex: String,
    pub corresponding_source: CatalogAsset,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogAsset {
    pub url: String,
    pub file_name: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackManifest {
    schema_version: String,
    distribution_status: String,
    signature_domain: String,
    pack_id: String,
    platform: String,
    arch: String,
    runtime_lock_sha256: String,
    minimum_useful_version: String,
    corresponding_source_required: bool,
    components: Vec<PackComponent>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackComponent {
    name: String,
    version: String,
    source_url: String,
    archive_sha256: String,
    extracted_file: String,
    extracted_sha256: String,
    size_bytes: u64,
    license: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SigningStatement {
    schema_version: String,
    signature_domain: String,
    pack_id: String,
    platform: String,
    arch: String,
    runtime_lock_sha256: String,
    minimum_useful_version: String,
    manifest_sha256: String,
    archive_file: String,
    archive_sha256: String,
    archive_size_bytes: u64,
    corresponding_source_asset_id: String,
    corresponding_source_asset_sha256: String,
    corresponding_source_asset_size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentPointer {
    pub schema_version: String,
    pub pack_id: String,
    pub runtime_lock_sha256: String,
    pub relative_path: String,
    pub media_pack_public_key_fingerprint: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledReceipt {
    schema_version: String,
    status: String,
    pack_id: String,
    runtime_lock_sha256: String,
    archive_sha256: String,
    corresponding_source_asset_id: String,
    corresponding_source_asset_sha256: String,
    media_pack_public_key_fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPackStatus {
    pub pack_id: String,
    pub current_relative_path: Option<String>,
    pub previous_available: bool,
    pub damaged: bool,
}

pub struct InstallInput<'a> {
    pub pack: &'a CatalogPack,
    pub public_key_hex: &'a str,
    pub archive_path: &'a Path,
    pub manifest_bytes: &'a [u8],
    pub statement_bytes: &'a [u8],
    pub install_root: &'a Path,
    pub current_useful_version: &'a str,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn parse_public_key(public_key_hex: &str) -> Result<VerifyingKey> {
    if !is_lower_hex(public_key_hex, 64) || public_key_hex.bytes().all(|byte| byte == b'0') {
        return Err(MediaPackError::TrustUnavailable);
    }
    let bytes = hex::decode(public_key_hex).map_err(|_| MediaPackError::TrustUnavailable)?;
    let raw: [u8; 32] = bytes
        .try_into()
        .map_err(|_| MediaPackError::TrustUnavailable)?;
    VerifyingKey::from_bytes(&raw).map_err(|_| MediaPackError::TrustUnavailable)
}

fn verify_detached(bytes: &[u8], signature_hex: &str, key: &VerifyingKey) -> Result<()> {
    if !is_lower_hex(signature_hex.trim(), 128) {
        return Err(MediaPackError::BadSignature);
    }
    let raw = hex::decode(signature_hex.trim()).map_err(|_| MediaPackError::BadSignature)?;
    let signature: [u8; 64] = raw.try_into().map_err(|_| MediaPackError::BadSignature)?;
    key.verify_strict(bytes, &Signature::from_bytes(&signature))
        .map_err(|_| MediaPackError::BadSignature)
}

pub fn verify_catalog(
    bytes: &[u8],
    signature_hex: &str,
    public_key_hex: &str,
    now_unix: i64,
) -> Result<MediaPackCatalog> {
    if bytes.is_empty() || bytes.len() > MAX_CATALOG_BYTES {
        return Err(MediaPackError::InvalidSchema("catalog byte budget".into()));
    }
    let key = parse_public_key(public_key_hex)?;
    verify_detached(bytes, signature_hex, &key)?;
    let catalog: MediaPackCatalog = serde_json::from_slice(bytes)?;
    if catalog.schema_version != CATALOG_SCHEMA
        || catalog.signature_domain != CATALOG_SIGNATURE_DOMAIN
    {
        return Err(MediaPackError::InvalidSchema("catalog identity".into()));
    }
    if catalog.expires_at_unix <= now_unix
        || catalog.expires_at_unix > now_unix.saturating_add(MAX_CATALOG_VALIDITY_SECONDS)
    {
        return Err(MediaPackError::InvalidSchema(
            "catalog expiry window".into(),
        ));
    }
    let mut ids = BTreeSet::new();
    for pack in &catalog.packs {
        validate_pack_id(&pack.id)?;
        if !ids.insert(pack.id.as_str()) {
            return Err(MediaPackError::InvalidSchema("duplicate pack id".into()));
        }
        validate_asset(&pack.archive, MAX_ARCHIVE_BYTES)?;
        validate_asset(&pack.manifest, MAX_SMALL_ASSET_BYTES)?;
        validate_asset(&pack.statement, MAX_SMALL_ASSET_BYTES)?;
        validate_asset(&pack.corresponding_source, u64::MAX)?;
        if !is_lower_hex(&pack.statement_signature_hex, 128) {
            return Err(MediaPackError::InvalidSchema("statement signature".into()));
        }
    }
    if ids != BTreeSet::from(["preview", "transcode"]) {
        return Err(MediaPackError::InvalidSchema(
            "catalog must contain preview and transcode exactly".into(),
        ));
    }
    Ok(catalog)
}

fn validate_pack_id(value: &str) -> Result<()> {
    if matches!(value, "preview" | "transcode") {
        Ok(())
    } else {
        Err(MediaPackError::InvalidSchema("unknown pack id".into()))
    }
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_sha(value: &str, label: &str) -> Result<()> {
    if is_lower_hex(value, 64) {
        Ok(())
    } else {
        Err(MediaPackError::InvalidSchema(label.into()))
    }
}

fn validate_basename(value: &str, label: &str) -> Result<()> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 160
        || matches!(value, "." | "..")
        || path.file_name().and_then(|item| item.to_str()) != Some(value)
        || value.contains(['/', '\\', ':'])
    {
        return Err(MediaPackError::InvalidSchema(label.into()));
    }
    Ok(())
}

fn validate_https(value: &str, label: &str) -> Result<()> {
    let url = Url::parse(value).map_err(|_| MediaPackError::InvalidSchema(label.into()))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(MediaPackError::InvalidSchema(label.into()));
    }
    Ok(())
}

fn validate_asset(asset: &CatalogAsset, maximum: u64) -> Result<()> {
    validate_https(&asset.url, "asset URL")?;
    validate_basename(&asset.file_name, "asset basename")?;
    validate_sha(&asset.sha256, "asset SHA-256")?;
    if asset.size_bytes == 0 || asset.size_bytes > maximum {
        return Err(MediaPackError::InvalidSchema("asset size".into()));
    }
    let url =
        Url::parse(&asset.url).map_err(|_| MediaPackError::InvalidSchema("asset URL".into()))?;
    if url.path_segments().and_then(|mut parts| parts.next_back()) != Some(asset.file_name.as_str())
    {
        return Err(MediaPackError::InvalidSchema("asset URL basename".into()));
    }
    Ok(())
}

fn verify_catalog_asset_bytes(asset: &CatalogAsset, bytes: &[u8], label: &str) -> Result<()> {
    if bytes.len() as u64 != asset.size_bytes || sha256_hex(bytes) != asset.sha256 {
        return Err(MediaPackError::AssetMismatch(label.into()));
    }
    Ok(())
}

fn verify_catalog_asset_file(asset: &CatalogAsset, path: &Path, label: &str) -> Result<()> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != asset.size_bytes {
        return Err(MediaPackError::AssetMismatch(label.into()));
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    let mut read_total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        read_total = read_total.saturating_add(read as u64);
        if read_total > asset.size_bytes {
            return Err(MediaPackError::AssetMismatch(label.into()));
        }
        digest.update(&buffer[..read]);
    }
    if read_total != asset.size_bytes || hex::encode(digest.finalize()) != asset.sha256 {
        return Err(MediaPackError::AssetMismatch(label.into()));
    }
    Ok(())
}

fn damaged_backup_path(parent: &Path, label: &str) -> PathBuf {
    parent.join(format!(
        ".damaged-{label}-{}",
        uuid::Uuid::new_v4().simple()
    ))
}

pub fn install_verified_pack(input: InstallInput<'_>) -> Result<CurrentPointer> {
    validate_pack_id(&input.pack.id)?;
    let key = parse_public_key(input.public_key_hex)?;
    verify_catalog_asset_file(&input.pack.archive, input.archive_path, "archive")?;
    verify_catalog_asset_bytes(&input.pack.manifest, input.manifest_bytes, "manifest")?;
    verify_catalog_asset_bytes(&input.pack.statement, input.statement_bytes, "statement")?;
    verify_detached(
        input.statement_bytes,
        &input.pack.statement_signature_hex,
        &key,
    )?;

    let statement: SigningStatement = serde_json::from_slice(input.statement_bytes)?;
    let manifest: PackManifest = serde_json::from_slice(input.manifest_bytes)?;
    validate_statement(&statement, input.pack, &manifest)?;
    validate_manifest(&manifest, &input.pack.id)?;

    let current = Version::parse(input.current_useful_version)
        .map_err(|_| MediaPackError::InvalidSchema("current Useful version".into()))?;
    let minimum = Version::parse(&statement.minimum_useful_version)
        .map_err(|_| MediaPackError::InvalidSchema("minimum Useful version".into()))?;
    if current < minimum {
        return Err(MediaPackError::IncompatibleVersion {
            current: current.to_string(),
            minimum: minimum.to_string(),
        });
    }

    ensure_directory(input.install_root)?;
    let lock_root = input.install_root.join(&manifest.runtime_lock_sha256);
    ensure_directory(&lock_root)?;
    let target = lock_root.join(&manifest.pack_id);
    let fingerprint = sha256_hex(
        &hex::decode(input.public_key_hex).map_err(|_| MediaPackError::TrustUnavailable)?,
    );
    let pointer = CurrentPointer {
        schema_version: "useful.media-pack-current.v1".into(),
        pack_id: manifest.pack_id.clone(),
        runtime_lock_sha256: manifest.runtime_lock_sha256.clone(),
        relative_path: format!("{}/{}", manifest.runtime_lock_sha256, manifest.pack_id),
        media_pack_public_key_fingerprint: fingerprint.clone(),
    };
    if target.exists() && validate_installed_payload(input.install_root, &pointer).is_ok() {
        let already_active = read_pointer(input.install_root, &manifest.pack_id, false)
            .ok()
            .is_some_and(|current| current.relative_path == pointer.relative_path);
        if already_active {
            return Err(MediaPackError::AlreadyInstalled(
                target.to_string_lossy().into_owned(),
            ));
        }
        activate_pointer(input.install_root, &pointer)?;
        return Ok(pointer);
    }

    let staging = Builder::new()
        .prefix(".staging-")
        .tempdir_in(input.install_root)?;
    let payload = staging.path().join("payload");
    fs::create_dir(&payload)?;
    extract_closed_archive(
        input.archive_path,
        &payload,
        &manifest,
        input.manifest_bytes,
    )?;

    fs::write(
        payload.join("MEDIA-PACK-SIGNING.json"),
        input.statement_bytes,
    )?;
    fs::write(
        payload.join("MEDIA-PACK-SIGNATURE.hex"),
        format!("{}\n", input.pack.statement_signature_hex),
    )?;
    let receipt = InstalledReceipt {
        schema_version: "useful.media-pack-installed.v1".into(),
        status: "verified".into(),
        pack_id: manifest.pack_id.clone(),
        runtime_lock_sha256: manifest.runtime_lock_sha256.clone(),
        archive_sha256: statement.archive_sha256.clone(),
        corresponding_source_asset_id: statement.corresponding_source_asset_id.clone(),
        corresponding_source_asset_sha256: statement.corresponding_source_asset_sha256.clone(),
        media_pack_public_key_fingerprint: fingerprint.clone(),
    };
    fs::write(
        payload.join("INSTALLED.json"),
        format!("{}\n", serde_json::to_string_pretty(&receipt)?),
    )?;
    let damaged_backup = if target.exists() {
        let backup = damaged_backup_path(&lock_root, &manifest.pack_id);
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

    activate_pointer(input.install_root, &pointer)?;
    Ok(pointer)
}

fn validate_statement(
    statement: &SigningStatement,
    pack: &CatalogPack,
    manifest: &PackManifest,
) -> Result<()> {
    if statement.schema_version != STATEMENT_SCHEMA
        || statement.signature_domain != PACK_SIGNATURE_DOMAIN
        || statement.pack_id != pack.id
        || statement.platform != "windows"
        || statement.arch != "x64"
        || statement.runtime_lock_sha256 != manifest.runtime_lock_sha256
        || statement.minimum_useful_version != manifest.minimum_useful_version
        || statement.manifest_sha256 != pack.manifest.sha256
        || statement.archive_file != pack.archive.file_name
        || statement.archive_sha256 != pack.archive.sha256
        || statement.archive_size_bytes != pack.archive.size_bytes
        || statement.corresponding_source_asset_id != pack.corresponding_source.file_name
        || statement.corresponding_source_asset_sha256 != pack.corresponding_source.sha256
        || statement.corresponding_source_asset_size_bytes != pack.corresponding_source.size_bytes
    {
        return Err(MediaPackError::InvalidSchema(
            "signed statement binding".into(),
        ));
    }
    validate_sha(&statement.runtime_lock_sha256, "runtime lock SHA-256")?;
    Ok(())
}

fn validate_manifest(manifest: &PackManifest, expected_pack: &str) -> Result<()> {
    if manifest.schema_version != PACK_SCHEMA
        || manifest.distribution_status != "unsigned-candidate"
        || manifest.signature_domain != PACK_SIGNATURE_DOMAIN
        || manifest.pack_id != expected_pack
        || manifest.platform != "windows"
        || manifest.arch != "x64"
        || !manifest.corresponding_source_required
    {
        return Err(MediaPackError::InvalidSchema(
            "pack manifest identity".into(),
        ));
    }
    validate_sha(&manifest.runtime_lock_sha256, "runtime lock SHA-256")?;
    Version::parse(&manifest.minimum_useful_version)
        .map_err(|_| MediaPackError::InvalidSchema("minimum Useful version".into()))?;
    let expected: BTreeSet<&str> = match expected_pack {
        "preview" => BTreeSet::from(["mpv"]),
        "transcode" => BTreeSet::from(["ffmpeg", "ffprobe"]),
        _ => return Err(MediaPackError::InvalidSchema("pack id".into())),
    };
    let actual: BTreeSet<&str> = manifest
        .components
        .iter()
        .map(|item| item.name.as_str())
        .collect();
    if actual != expected || actual.len() != manifest.components.len() {
        return Err(MediaPackError::InvalidSchema(
            "pack component closure".into(),
        ));
    }
    let mut total_extracted = 0u64;
    for component in &manifest.components {
        validate_basename(&component.extracted_file, "component filename")?;
        validate_sha(&component.extracted_sha256, "component SHA-256")?;
        validate_sha(&component.archive_sha256, "component archive SHA-256")?;
        validate_https(&component.source_url, "component source URL")?;
        total_extracted = total_extracted.saturating_add(component.size_bytes);
        if component.version.is_empty()
            || component.license.is_empty()
            || component.size_bytes == 0
            || component.size_bytes > MAX_ARCHIVE_BYTES
            || total_extracted > MAX_ARCHIVE_BYTES
        {
            return Err(MediaPackError::InvalidSchema("component facts".into()));
        }
        let expected_file = format!("{}.exe", component.name);
        if component.extracted_file != expected_file {
            return Err(MediaPackError::InvalidSchema(
                "component filename mapping".into(),
            ));
        }
    }
    Ok(())
}

fn extract_closed_archive(
    archive_path: &Path,
    destination: &Path,
    manifest: &PackManifest,
    manifest_bytes: &[u8],
) -> Result<()> {
    let file = File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let root = format!("Useful-Media-Pack-{}-windows-x64/", manifest.pack_id);
    let mut expected = BTreeMap::new();
    expected.insert("MEDIA-PACK.json".to_string(), None);
    expected.insert("UNSIGNED-CANDIDATE.txt".to_string(), None);
    for component in &manifest.components {
        expected.insert(
            component.extracted_file.clone(),
            Some((component.size_bytes, component.extracted_sha256.as_str())),
        );
    }
    let mut seen = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(MediaPackError::UnsafeArchive(entry.name().into()));
        }
        let name = entry.name().to_string();
        let relative = name
            .strip_prefix(&root)
            .ok_or_else(|| MediaPackError::UnsafeArchive(name.clone()))?;
        validate_basename(relative, "ZIP entry")?;
        let fact = expected
            .get(relative)
            .ok_or_else(|| MediaPackError::UnsafeArchive(name.clone()))?;
        if !seen.insert(relative.to_string()) {
            return Err(MediaPackError::UnsafeArchive("duplicate entry".into()));
        }
        let maximum = fact.map(|item| item.0).unwrap_or(MAX_SMALL_ASSET_BYTES);
        if entry.size() > maximum {
            return Err(MediaPackError::UnsafeArchive("entry size".into()));
        }
        let target = destination.join(relative);
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
            if written > maximum {
                return Err(MediaPackError::UnsafeArchive(
                    "entry expanded past limit".into(),
                ));
            }
            output.write_all(&buffer[..read])?;
            digest.update(&buffer[..read]);
        }
        output.sync_all()?;
        let hash = hex::encode(digest.finalize());
        match fact {
            Some((size, expected_hash)) if written == *size && hash == *expected_hash => {}
            Some(_) => return Err(MediaPackError::AssetMismatch(relative.into())),
            None if relative == "MEDIA-PACK.json"
                && written as usize == manifest_bytes.len()
                && hash == sha256_hex(manifest_bytes) => {}
            None if relative == "UNSIGNED-CANDIDATE.txt" && written > 0 => {}
            None => return Err(MediaPackError::AssetMismatch(relative.into())),
        }
    }
    if seen != expected.keys().cloned().collect() {
        return Err(MediaPackError::UnsafeArchive("incomplete entry set".into()));
    }
    Ok(())
}

fn ensure_directory(path: &Path) -> Result<()> {
    let mut cursor = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => cursor.push(component.as_os_str()),
            Component::Normal(part) => {
                cursor.push(part);
                match fs::symlink_metadata(&cursor) {
                    Ok(metadata) => validate_directory_metadata(&cursor, &metadata)?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        fs::create_dir(&cursor)?;
                        let metadata = fs::symlink_metadata(&cursor)?;
                        validate_directory_metadata(&cursor, &metadata)?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(MediaPackError::UnsafePath(
                    path.to_string_lossy().into_owned(),
                ))
            }
        }
    }
    Ok(())
}

fn validate_directory_metadata(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() || is_reparse_point(metadata) {
        return Err(MediaPackError::UnsafePath(
            path.to_string_lossy().into_owned(),
        ));
    }
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

fn pointer_path(root: &Path, pack_id: &str, previous: bool) -> PathBuf {
    root.join(if previous {
        format!("current-{pack_id}.previous.json")
    } else {
        format!("current-{pack_id}.json")
    })
}

fn pointer_bytes(pointer: &CurrentPointer) -> Result<Vec<u8>> {
    Ok(format!("{}\n", serde_json::to_string_pretty(pointer)?).into_bytes())
}

fn activate_pointer(root: &Path, pointer: &CurrentPointer) -> Result<()> {
    let current_path = pointer_path(root, &pointer.pack_id, false);
    if current_path.exists() {
        match read_pointer(root, &pointer.pack_id, false) {
            Ok(old) => atomic_write(
                &pointer_path(root, &pointer.pack_id, true),
                &pointer_bytes(&old)?,
            )?,
            Err(_) => {
                let backup = damaged_backup_path(root, &format!("current-{}", pointer.pack_id));
                fs::rename(&current_path, backup)?;
            }
        }
    }
    atomic_write(&current_path, &pointer_bytes(pointer)?)
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
    atomic_replace(&temporary_path, destination)?;
    Ok(())
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

pub fn read_pointer(root: &Path, pack_id: &str, previous: bool) -> Result<CurrentPointer> {
    validate_pack_id(pack_id)?;
    let bytes = fs::read(pointer_path(root, pack_id, previous))?;
    if bytes.is_empty() || bytes.len() > 16 * 1024 {
        return Err(MediaPackError::InvalidSchema("current pointer size".into()));
    }
    let pointer: CurrentPointer = serde_json::from_slice(&bytes)?;
    validate_pointer(root, &pointer, pack_id)?;
    Ok(pointer)
}

fn validate_pointer(root: &Path, pointer: &CurrentPointer, expected_pack: &str) -> Result<()> {
    if pointer.schema_version != "useful.media-pack-current.v1"
        || pointer.pack_id != expected_pack
        || !is_lower_hex(&pointer.runtime_lock_sha256, 64)
        || !is_lower_hex(&pointer.media_pack_public_key_fingerprint, 64)
        || pointer.relative_path != format!("{}/{}", pointer.runtime_lock_sha256, expected_pack)
    {
        return Err(MediaPackError::InvalidSchema("current pointer".into()));
    }
    let target = root.join(&pointer.runtime_lock_sha256).join(expected_pack);
    let canonical_root = dunce::canonicalize(root)?;
    let canonical_target = dunce::canonicalize(&target)?;
    if !canonical_target.starts_with(&canonical_root) || !canonical_target.is_dir() {
        return Err(MediaPackError::UnsafePath(
            target.to_string_lossy().into_owned(),
        ));
    }
    let installed = canonical_target.join("INSTALLED.json");
    if !installed.is_file() {
        return Err(MediaPackError::InvalidSchema(
            "installed receipt missing".into(),
        ));
    }
    Ok(())
}

fn read_installed_manifest(
    root: &Path,
    pointer: &CurrentPointer,
) -> Result<(PathBuf, PackManifest)> {
    let target = root
        .join(&pointer.runtime_lock_sha256)
        .join(&pointer.pack_id);
    let canonical_root = dunce::canonicalize(root)?;
    let canonical_target = dunce::canonicalize(&target)?;
    if !canonical_target.starts_with(&canonical_root) || !canonical_target.is_dir() {
        return Err(MediaPackError::UnsafePath(
            target.to_string_lossy().into_owned(),
        ));
    }

    let manifest_bytes = fs::read(canonical_target.join("MEDIA-PACK.json"))?;
    if manifest_bytes.is_empty() || manifest_bytes.len() as u64 > MAX_SMALL_ASSET_BYTES {
        return Err(MediaPackError::InvalidSchema(
            "installed manifest size".into(),
        ));
    }
    let manifest: PackManifest = serde_json::from_slice(&manifest_bytes)?;
    validate_manifest(&manifest, &pointer.pack_id)?;
    if manifest.runtime_lock_sha256 != pointer.runtime_lock_sha256 {
        return Err(MediaPackError::InvalidSchema(
            "installed manifest pointer binding".into(),
        ));
    }

    let receipt_bytes = fs::read(canonical_target.join("INSTALLED.json"))?;
    if receipt_bytes.is_empty() || receipt_bytes.len() as u64 > MAX_SMALL_ASSET_BYTES {
        return Err(MediaPackError::InvalidSchema(
            "installed receipt size".into(),
        ));
    }
    let receipt: InstalledReceipt = serde_json::from_slice(&receipt_bytes)?;
    if receipt.schema_version != "useful.media-pack-installed.v1"
        || receipt.status != "verified"
        || receipt.pack_id != pointer.pack_id
        || receipt.runtime_lock_sha256 != pointer.runtime_lock_sha256
        || receipt.media_pack_public_key_fingerprint != pointer.media_pack_public_key_fingerprint
    {
        return Err(MediaPackError::InvalidSchema(
            "installed receipt binding".into(),
        ));
    }
    validate_sha(&receipt.archive_sha256, "installed archive SHA-256")?;
    validate_basename(
        &receipt.corresponding_source_asset_id,
        "installed source asset id",
    )?;
    validate_sha(
        &receipt.corresponding_source_asset_sha256,
        "installed source SHA-256",
    )?;
    Ok((canonical_target, manifest))
}

fn validate_installed_component(target: &Path, component: &PackComponent) -> Result<PathBuf> {
    let path = target.join(&component.extracted_file);
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink()
        || is_reparse_point(&metadata)
        || !metadata.is_file()
        || metadata.len() != component.size_bytes
    {
        return Err(MediaPackError::AssetMismatch(component.name.clone()));
    }
    let canonical = dunce::canonicalize(&path)?;
    if !canonical.starts_with(target) || sha256_file(&canonical)? != component.extracted_sha256 {
        return Err(MediaPackError::AssetMismatch(component.name.clone()));
    }
    Ok(canonical)
}

fn validate_installed_payload(root: &Path, pointer: &CurrentPointer) -> Result<()> {
    let (target, manifest) = read_installed_manifest(root, pointer)?;
    for component in &manifest.components {
        validate_installed_component(&target, component)?;
    }
    Ok(())
}

pub fn installed_status(root: &Path, pack_id: &str) -> InstalledPackStatus {
    let current_pointer = read_pointer(root, pack_id, false).ok();
    let current = current_pointer
        .as_ref()
        .filter(|pointer| validate_installed_payload(root, pointer).is_ok());
    let previous = read_pointer(root, pack_id, true)
        .ok()
        .filter(|pointer| validate_installed_payload(root, pointer).is_ok());
    InstalledPackStatus {
        pack_id: pack_id.to_string(),
        current_relative_path: current.map(|item| item.relative_path.clone()),
        previous_available: previous.is_some_and(|previous| {
            current_pointer
                .as_ref()
                .is_none_or(|current| current.relative_path != previous.relative_path)
        }),
        damaged: pointer_path(root, pack_id, false).exists() && current.is_none(),
    }
}

pub fn rollback(root: &Path, pack_id: &str) -> Result<CurrentPointer> {
    let current = read_pointer(root, pack_id, false).ok();
    let previous = read_pointer(root, pack_id, true)
        .map_err(|_| MediaPackError::NoPrevious(pack_id.to_string()))?;
    validate_installed_payload(root, &previous)
        .map_err(|_| MediaPackError::NoPrevious(pack_id.to_string()))?;
    if current
        .as_ref()
        .is_some_and(|current| current.relative_path == previous.relative_path)
    {
        return Err(MediaPackError::NoPrevious(pack_id.to_string()));
    }
    atomic_write(
        &pointer_path(root, pack_id, false),
        &pointer_bytes(&previous)?,
    )?;
    Ok(previous)
}

pub fn resolve_installed_component(root: &Path, pack_id: &str, file_name: &str) -> Option<PathBuf> {
    validate_basename(file_name, "component filename").ok()?;
    let pointer = read_pointer(root, pack_id, false).ok()?;
    let (target, manifest) = read_installed_manifest(root, &pointer).ok()?;
    let component = manifest
        .components
        .iter()
        .find(|component| component.extracted_file == file_name)?;
    validate_installed_component(&target, component).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use zip::write::SimpleFileOptions;

    fn asset(name: &str, bytes: &[u8]) -> CatalogAsset {
        CatalogAsset {
            url: format!("https://downloads.example.test/{name}"),
            file_name: name.into(),
            sha256: sha256_hex(bytes),
            size_bytes: bytes.len() as u64,
        }
    }

    #[test]
    fn catalog_requires_exact_signed_preview_and_transcode_set() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let make_pack = |id: &str| CatalogPack {
            id: id.into(),
            archive: asset(&format!("{id}.zip"), b"archive"),
            manifest: asset(&format!("{id}.manifest.json"), b"manifest"),
            statement: asset(&format!("{id}.statement.json"), b"statement"),
            statement_signature_hex: "11".repeat(64),
            corresponding_source: asset(&format!("{id}-source.zip"), b"source"),
        };
        let catalog = MediaPackCatalog {
            schema_version: CATALOG_SCHEMA.into(),
            signature_domain: CATALOG_SIGNATURE_DOMAIN.into(),
            expires_at_unix: 1_902_000_000,
            packs: vec![make_pack("preview"), make_pack("transcode")],
        };
        let bytes = serde_json::to_vec(&catalog).unwrap();
        let signature = hex::encode(key.sign(&bytes).to_bytes());
        let public = hex::encode(key.verifying_key().to_bytes());
        let verified = verify_catalog(&bytes, &signature, &public, 1_900_000_000).unwrap();
        assert_eq!(verified.packs.len(), 2);

        let mut long_lived = catalog.clone();
        long_lived.expires_at_unix = 1_903_000_000;
        let long_lived_bytes = serde_json::to_vec(&long_lived).unwrap();
        let long_lived_signature = hex::encode(key.sign(&long_lived_bytes).to_bytes());
        assert!(verify_catalog(
            &long_lived_bytes,
            &long_lived_signature,
            &public,
            1_900_000_000,
        )
        .is_err());

        let mut tampered = bytes.clone();
        tampered.push(b' ');
        assert!(matches!(
            verify_catalog(&tampered, &signature, &public, 1_900_000_000),
            Err(MediaPackError::BadSignature)
        ));
        assert!(verify_catalog(&bytes, &signature, &public, 1_903_000_000).is_err());
    }

    fn build_preview_fixture(
        root: &Path,
        key: &SigningKey,
        label: &str,
        lock_sha: &str,
    ) -> (CatalogPack, PathBuf, Vec<u8>, Vec<u8>, Vec<u8>) {
        let component_bytes = format!("verified-mpv-{label}\n").into_bytes();
        let manifest_value = json!({
            "schemaVersion": PACK_SCHEMA,
            "distributionStatus": "unsigned-candidate",
            "signatureDomain": PACK_SIGNATURE_DOMAIN,
            "packId": "preview",
            "platform": "windows",
            "arch": "x64",
            "runtimeLockSha256": lock_sha,
            "minimumUsefulVersion": "0.1.0-beta.1",
            "correspondingSourceRequired": true,
            "components": [{
                "name": "mpv",
                "version": label,
                "sourceUrl": "https://sources.example.test/mpv.7z",
                "archiveSha256": "44".repeat(32),
                "extractedFile": "mpv.exe",
                "extractedSha256": sha256_hex(&component_bytes),
                "sizeBytes": component_bytes.len(),
                "license": "GPLv2+"
            }]
        });
        let manifest_bytes = format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest_value).unwrap()
        )
        .into_bytes();
        let archive_name = format!("preview-{label}.zip");
        let archive_path = root.join(&archive_name);
        let archive_file = File::create(&archive_path).unwrap();
        let mut writer = zip::ZipWriter::new(archive_file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let prefix = "Useful-Media-Pack-preview-windows-x64/";
        writer
            .start_file(format!("{prefix}MEDIA-PACK.json"), options)
            .unwrap();
        writer.write_all(&manifest_bytes).unwrap();
        writer
            .start_file(format!("{prefix}UNSIGNED-CANDIDATE.txt"), options)
            .unwrap();
        writer.write_all(b"signed statement required\n").unwrap();
        writer
            .start_file(format!("{prefix}mpv.exe"), options)
            .unwrap();
        writer.write_all(&component_bytes).unwrap();
        writer.finish().unwrap();
        let archive_bytes = fs::read(&archive_path).unwrap();
        let source_bytes = format!("corresponding-source-{label}\n").into_bytes();
        let source_name = format!("preview-source-{label}.zip");
        let statement_value = json!({
            "schemaVersion": STATEMENT_SCHEMA,
            "signatureDomain": PACK_SIGNATURE_DOMAIN,
            "packId": "preview",
            "platform": "windows",
            "arch": "x64",
            "runtimeLockSha256": lock_sha,
            "minimumUsefulVersion": "0.1.0-beta.1",
            "manifestSha256": sha256_hex(&manifest_bytes),
            "archiveFile": archive_name,
            "archiveSha256": sha256_hex(&archive_bytes),
            "archiveSizeBytes": archive_bytes.len(),
            "correspondingSourceAssetId": source_name,
            "correspondingSourceAssetSha256": sha256_hex(&source_bytes),
            "correspondingSourceAssetSizeBytes": source_bytes.len()
        });
        let statement_bytes = format!(
            "{}\n",
            serde_json::to_string_pretty(&statement_value).unwrap()
        )
        .into_bytes();
        let signature = hex::encode(key.sign(&statement_bytes).to_bytes());
        let pack = CatalogPack {
            id: "preview".into(),
            archive: asset(&archive_name, &archive_bytes),
            manifest: asset(&format!("preview-{label}.manifest.json"), &manifest_bytes),
            statement: asset(&format!("preview-{label}.statement.json"), &statement_bytes),
            statement_signature_hex: signature,
            corresponding_source: asset(&source_name, &source_bytes),
        };
        (
            pack,
            archive_path,
            manifest_bytes,
            statement_bytes,
            component_bytes,
        )
    }

    #[test]
    fn signed_install_activates_versioned_pack_and_rolls_back_without_deleting_versions() {
        let root = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let public = hex::encode(key.verifying_key().to_bytes());
        let first_lock = "11".repeat(32);
        let second_lock = "22".repeat(32);

        let (first, first_archive, first_manifest, first_statement, first_component) =
            build_preview_fixture(downloads.path(), &key, "v1", &first_lock);
        let first_pointer = install_verified_pack(InstallInput {
            pack: &first,
            public_key_hex: &public,
            archive_path: &first_archive,
            manifest_bytes: &first_manifest,
            statement_bytes: &first_statement,
            install_root: root.path(),
            current_useful_version: "0.1.0-beta.1",
        })
        .unwrap();
        assert_eq!(first_pointer.relative_path, format!("{first_lock}/preview"));
        let first_binary = resolve_installed_component(root.path(), "preview", "mpv.exe").unwrap();
        assert_eq!(fs::read(first_binary).unwrap(), first_component);
        assert!(!installed_status(root.path(), "preview").previous_available);

        let (second, second_archive, second_manifest, second_statement, second_component) =
            build_preview_fixture(downloads.path(), &key, "v2", &second_lock);
        install_verified_pack(InstallInput {
            pack: &second,
            public_key_hex: &public,
            archive_path: &second_archive,
            manifest_bytes: &second_manifest,
            statement_bytes: &second_statement,
            install_root: root.path(),
            current_useful_version: "0.1.0-beta.1",
        })
        .unwrap();
        assert_eq!(
            fs::read(resolve_installed_component(root.path(), "preview", "mpv.exe").unwrap())
                .unwrap(),
            second_component
        );
        assert!(installed_status(root.path(), "preview").previous_available);

        fs::remove_file(resolve_installed_component(root.path(), "preview", "mpv.exe").unwrap())
            .unwrap();
        let damaged = installed_status(root.path(), "preview");
        assert!(damaged.damaged);
        assert!(damaged.current_relative_path.is_none());
        assert!(damaged.previous_available);

        let rolled_back = rollback(root.path(), "preview").unwrap();
        assert_eq!(rolled_back.relative_path, format!("{first_lock}/preview"));
        assert_eq!(
            fs::read(resolve_installed_component(root.path(), "preview", "mpv.exe").unwrap())
                .unwrap(),
            first_component
        );
        assert!(root.path().join(&first_lock).join("preview").is_dir());
        assert!(root.path().join(&second_lock).join("preview").is_dir());
        assert!(!installed_status(root.path(), "preview").previous_available);
    }

    #[test]
    fn damaged_pack_is_retained_and_can_be_repaired_from_verified_assets() {
        let root = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let key = SigningKey::from_bytes(&[11u8; 32]);
        let public = hex::encode(key.verifying_key().to_bytes());
        let lock = "44".repeat(32);
        let (pack, archive, manifest, statement, component) =
            build_preview_fixture(downloads.path(), &key, "repair", &lock);

        install_verified_pack(InstallInput {
            pack: &pack,
            public_key_hex: &public,
            archive_path: &archive,
            manifest_bytes: &manifest,
            statement_bytes: &statement,
            install_root: root.path(),
            current_useful_version: "0.1.0-beta.1",
        })
        .unwrap();
        let installed = resolve_installed_component(root.path(), "preview", "mpv.exe").unwrap();
        fs::write(installed, vec![0u8; component.len()]).unwrap();
        assert!(installed_status(root.path(), "preview").damaged);

        install_verified_pack(InstallInput {
            pack: &pack,
            public_key_hex: &public,
            archive_path: &archive,
            manifest_bytes: &manifest,
            statement_bytes: &statement,
            install_root: root.path(),
            current_useful_version: "0.1.0-beta.1",
        })
        .unwrap();

        let repaired = installed_status(root.path(), "preview");
        assert!(!repaired.damaged);
        assert!(repaired.current_relative_path.is_some());
        assert_eq!(
            fs::read(resolve_installed_component(root.path(), "preview", "mpv.exe").unwrap())
                .unwrap(),
            component
        );
        assert!(fs::read_dir(root.path().join(&lock))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".damaged-preview-")));
    }

    #[test]
    fn install_rejects_tampered_archive_before_activation() {
        let root = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let key = SigningKey::from_bytes(&[10u8; 32]);
        let public = hex::encode(key.verifying_key().to_bytes());
        let lock = "33".repeat(32);
        let (pack, archive, manifest, statement, _) =
            build_preview_fixture(downloads.path(), &key, "tamper", &lock);
        OpenOptions::new()
            .append(true)
            .open(&archive)
            .unwrap()
            .write_all(b"tamper")
            .unwrap();
        assert!(matches!(
            install_verified_pack(InstallInput {
                pack: &pack,
                public_key_hex: &public,
                archive_path: &archive,
                manifest_bytes: &manifest,
                statement_bytes: &statement,
                install_root: root.path(),
                current_useful_version: "0.1.0-beta.1",
            }),
            Err(MediaPackError::AssetMismatch(_))
        ));
        assert!(!root.path().join("current-preview.json").exists());
    }
}
