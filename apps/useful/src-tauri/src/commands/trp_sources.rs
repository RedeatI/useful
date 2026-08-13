//! TRP v1 源中心命令：预览（指纹确认）→ 添加、启停、优先级、删除、按源同步、多源本地搜索。
//!
//! 安全策略：
//! - 添加分两步：preview 返回根指纹与能力，用户确认后 add 重新拉取并核对（防 TOCTOU）。
//! - discovery 默认仅 HTTPS；127.0.0.1/file 仅开发者模式，且强制标记 local。
//! - 重定向 ≤3 次并禁止 HTTPS→HTTP 降级；discovery/目录均有大小上限。
//! - 官方身份仅由预置根指纹匹配产生（useful_repository_client::trust），不入库、不来自名称。
//! - 同步按源隔离：单个源失败只记入该源状态，绝不影响其他源。

use super::sources::file_url_path;
use super::{CmdError, CmdResult};
use crate::state::{AppState, HOST_VERSION};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, State};
use useful_repository_client::catalog::{
    latest_stable_digest, max_advisory_severity, parse_catalog, CatalogEntry, MAX_CATALOG_SIZE,
};
use useful_repository_client::discovery::{
    parse_discovery, RepositoryDiscovery, MAX_DISCOVERY_SIZE,
};
use useful_repository_client::pinning::{
    evaluate_update, InstalledOrigin, UpdateCandidate, UpdateDecision,
};
use useful_repository_client::publisher::{
    select_unique_publisher_target, PublisherTargetExpectation,
};
use useful_repository_client::search::{filter_items, merge_catalog, CatalogItem, MergedItem};
use useful_repository_client::trust::is_official_root;
use useful_repository_client::tuf::{
    ensure_monotonic_versions, now_rfc3339, verify_target_bytes, BuiltinTufBackend, TrustBackend,
    TufVersions, MAX_METADATA_SIZE,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrpSourcePreview {
    pub source_id: String,
    pub name: String,
    pub description: String,
    pub operator: String,
    pub discovery_url: String,
    pub local: bool,
    pub root_key_fingerprint: String,
    pub capabilities: serde_json::Value,
    /// Client-observed transport shape. S3-compatible public buckets are
    /// intentionally represented as static-https; provider internals are not
    /// a trust signal and cannot be inferred from an HTTPS URL.
    pub delivery_type: String,
    pub requires_auth: bool,
    pub paid_downloads: bool,
    pub native_workers: bool,
    /// 仅由预置根指纹匹配产生；与 source.id / name / URL 无关。
    pub is_official: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrpSourceInfo {
    pub id: String,
    pub kind: String,
    pub discovery_url: String,
    pub display_name: String,
    pub operator: String,
    pub local: bool,
    pub enabled: bool,
    pub priority: i64,
    pub root_key_fingerprint: String,
    pub trust_confirmed_at: i64,
    pub capabilities: serde_json::Value,
    pub delivery_type: String,
    pub last_sync_at: Option<i64>,
    pub last_sync_status: String,
    pub last_sync_error: Option<String>,
    pub last_sync_duration_ms: Option<i64>,
    pub entry_count: i64,
    pub is_official: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrpSyncResult {
    pub source_id: String,
    pub ok: bool,
    pub message: Option<String>,
    pub entry_count: i64,
    pub duration_ms: i64,
}

/// 校验 discovery URL 策略；返回是否为本地/开发源。
fn check_discovery_url(url: &str, developer_mode: bool) -> Result<bool, CmdError> {
    if useful_repository_client::network::validate_url(url, false).is_ok() {
        return Ok(false);
    }
    if useful_repository_client::network::validate_url(url, true).is_ok() {
        if !developer_mode {
            return Err(CmdError::from(
                "本地/开发源（127.0.0.1、file://）仅在开发者模式下允许添加",
            ));
        }
        return Ok(true);
    }
    Err(CmdError::from(
        "软件源 discovery 地址必须为 HTTPS，且目标必须是公开网络地址",
    ))
}

fn canonical_discovery_url(url: &str, developer_mode: bool) -> Result<(bool, String), CmdError> {
    let local = check_discovery_url(url, developer_mode)?;
    let canonical = useful_repository_client::network::validate_url(url, local)
        .map_err(|error| CmdError::from(format!("URL 被网络安全策略拒绝: {error}")))?
        .to_string();
    Ok((local, canonical))
}

/// 拉取字节：限制重定向次数、禁止 HTTPS 降级、限制大小；开发者模式支持 file://。
async fn fetch_bytes_limited(
    url: &str,
    max_size: usize,
    allow_local: bool,
) -> Result<Vec<u8>, CmdError> {
    useful_repository_client::network::validate_url(url, allow_local)
        .map_err(|error| CmdError::from(format!("URL 被网络安全策略拒绝: {error}")))?;
    if let Some(path) = file_url_path(url)? {
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            let code = if e.kind() == std::io::ErrorKind::NotFound {
                "object_missing"
            } else {
                "network"
            };
            CmdError::coded(code, format!("读取本地文件失败: {e}"))
        })?;
        if bytes.len() > max_size {
            return Err(CmdError::coded("size_mismatch", "文件超过大小上限"));
        }
        return Ok(bytes);
    }
    let resp = super::sources::secure_get(url, allow_local)
        .await
        .map_err(|error| CmdError::coded("network", error.message))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(CmdError::coded(
            "object_missing",
            format!("HTTP 状态异常: {}", resp.status()),
        ));
    }
    if !resp.status().is_success() {
        return Err(CmdError::coded(
            "network",
            format!("HTTP 状态异常: {}", resp.status()),
        ));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > max_size {
            return Err(CmdError::coded("size_mismatch", "响应超过大小上限"));
        }
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut resp = resp;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| CmdError::coded("network", format!("下载中断: {e}")))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > max_size {
            return Err(CmdError::coded("size_mismatch", "响应超过大小上限"));
        }
    }
    Ok(bytes)
}

/// Fetch a numbered root metadata file. Only an explicit 404 (or a missing
/// local file) terminates the sequential root-update walk; transport, policy
/// and other HTTP failures are not treated as "no newer root".
async fn fetch_optional_root(
    url: &str,
    max_size: usize,
    allow_local: bool,
) -> Result<Option<Vec<u8>>, CmdError> {
    useful_repository_client::network::validate_url(url, allow_local)
        .map_err(|error| CmdError::from(format!("URL 被网络安全策略拒绝: {error}")))?;
    if let Some(path) = file_url_path(url)? {
        return match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() <= max_size => Ok(Some(bytes)),
            Ok(_) => Err(CmdError::from("文件超过大小上限")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(CmdError::from(format!("读取本地文件失败: {error}"))),
        };
    }
    let mut response = super::sources::secure_get(url, allow_local).await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(CmdError::from(format!(
            "HTTP 状态异常: {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > max_size)
    {
        return Err(CmdError::from("响应超过大小上限"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| CmdError::from(format!("下载中断: {error}")))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > max_size {
            return Err(CmdError::from("响应超过大小上限"));
        }
    }
    Ok(Some(bytes))
}

/// 拉取并校验 discovery。
async fn fetch_discovery(url: &str, local: bool) -> Result<RepositoryDiscovery, CmdError> {
    let bytes = fetch_bytes_limited(url, MAX_DISCOVERY_SIZE, local).await?;
    parse_discovery(&bytes, local).map_err(|e| CmdError::from(e.to_string()))
}

async fn verified_discovery_root_fingerprint(
    discovery: &RepositoryDiscovery,
    local: bool,
) -> Result<String, CmdError> {
    let root =
        fetch_bytes_limited(&discovery.repository.root_url, MAX_METADATA_SIZE, local).await?;
    match_discovery_root_fingerprint(&root, &discovery.repository.root_sha256)
}

fn match_discovery_root_fingerprint(root: &[u8], expected: &str) -> Result<String, CmdError> {
    let actual = sha256_hex(root);
    if actual != expected {
        return Err(CmdError::from(
            "rootUrl 内容与 discovery 声明的 rootSha256 不一致",
        ));
    }
    Ok(actual)
}

/// 供 accounts 模块复用（公开包装）。
pub async fn fetch_discovery_pub(url: &str, local: bool) -> Result<RepositoryDiscovery, CmdError> {
    fetch_discovery(url, local).await
}

pub fn check_discovery_url_pub(url: &str, developer_mode: bool) -> Result<(), CmdError> {
    canonical_discovery_url(url, developer_mode).map(|_| ())
}

/// 目录快照地址：动态源用 api.baseUrl，静态源用 discovery 同级目录。
fn catalog_url(discovery_url: &str, d: &RepositoryDiscovery) -> String {
    if let Some(api) = &d.api {
        return format!("{}/catalog/snapshot", api.base_url.trim_end_matches('/'));
    }
    let base = discovery_url
        .trim_end_matches("/.well-known/useful-repository.json")
        .trim_end_matches('/');
    format!("{base}/catalog/snapshot.json")
}

fn capabilities_value(d: &RepositoryDiscovery) -> serde_json::Value {
    serde_json::to_value(&d.capabilities).unwrap_or_else(|_| serde_json::json!({}))
}

fn delivery_type(d: &RepositoryDiscovery) -> &'static str {
    if d.api.is_some() {
        "dynamic"
    } else {
        "static-https"
    }
}

fn source_info_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrpSourceInfo> {
    let fingerprint: String = row.get(8)?;
    let capabilities_json: String = row.get(10)?;
    Ok(TrpSourceInfo {
        id: row.get(0)?,
        kind: row.get(1)?,
        discovery_url: row.get(2)?,
        display_name: row.get(3)?,
        operator: row.get(4)?,
        local: row.get::<_, i64>(5)? != 0,
        enabled: row.get::<_, i64>(6)? != 0,
        priority: row.get(7)?,
        is_official: is_official_root(&fingerprint),
        root_key_fingerprint: fingerprint,
        trust_confirmed_at: row.get(9)?,
        capabilities: serde_json::from_str(&capabilities_json)
            .unwrap_or_else(|_| serde_json::json!({})),
        delivery_type: row.get(11)?,
        last_sync_at: row.get(12)?,
        last_sync_status: row.get(13)?,
        last_sync_error: row.get(14)?,
        last_sync_duration_ms: row.get(15)?,
        entry_count: row.get(16)?,
    })
}

const SOURCE_INFO_SQL: &str = "SELECT s.id, s.kind, s.discovery_url, s.display_name, s.operator,
        s.local, s.enabled, s.priority, s.root_key_fingerprint, s.trust_confirmed_at,
        s.capabilities_json, s.delivery_type, s.last_sync_at, s.last_sync_status, s.last_sync_error,
        s.last_sync_duration_ms,
        (SELECT COUNT(*) FROM trp_catalog_cache c WHERE c.source_id = s.id)
 FROM trp_sources s";

fn get_source_info(state: &AppState, source_id: &str) -> Result<TrpSourceInfo, CmdError> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let sql = format!("{SOURCE_INFO_SQL} WHERE s.id = ?1");
    let info = db.conn.query_row(&sql, [source_id], source_info_row)?;
    Ok(info)
}

/// 第一步：预览。拉取 discovery，返回根指纹与能力供用户确认；不写库。
#[tauri::command]
pub async fn trp_source_preview(
    state: State<'_, AppState>,
    url: String,
) -> CmdResult<TrpSourcePreview> {
    let dev = super::sources::developer_mode_enabled(&state);
    let (local, canonical_url) = canonical_discovery_url(&url, dev)?;
    let d = fetch_discovery(&canonical_url, local).await?;
    let root_fingerprint = verified_discovery_root_fingerprint(&d, local).await?;
    Ok(TrpSourcePreview {
        source_id: d.source.id.clone(),
        name: d.source.name.clone(),
        description: d.source.description.clone(),
        operator: d.source.operator.clone(),
        discovery_url: canonical_url,
        local,
        root_key_fingerprint: root_fingerprint.clone(),
        requires_auth: d.auth.is_some(),
        paid_downloads: d.capabilities.paid_downloads,
        native_workers: d.capabilities.native_workers,
        is_official: is_official_root(&root_fingerprint),
        capabilities: capabilities_value(&d),
        delivery_type: delivery_type(&d).into(),
    })
}

/// 第二步：用户确认指纹后添加。重新拉取并核对 sourceId 与指纹（防 TOCTOU），入库后立即同步。
#[tauri::command]
pub async fn trp_source_add(
    state: State<'_, AppState>,
    url: String,
    expected_source_id: String,
    expected_fingerprint: String,
    kind: Option<String>,
) -> CmdResult<TrpSourceInfo> {
    let dev = super::sources::developer_mode_enabled(&state);
    let (local, canonical_url) = canonical_discovery_url(&url, dev)?;
    let kind = kind.unwrap_or_else(|| "tool".into());
    if kind != "tool" && kind != "mirror" {
        // 结构性保证：TRP 工具源不存在 app-update 类别，客户端更新源是独立信任域
        return Err(CmdError::from("非法源类别：仅允许 tool 或 mirror"));
    }

    let source_lock = source_install_lock(&expected_source_id);
    let source_guard = source_lock.lock_owned().await;
    let d = fetch_discovery(&canonical_url, local).await?;
    let root_fingerprint = verified_discovery_root_fingerprint(&d, local).await?;
    if d.source.id != expected_source_id {
        return Err(CmdError::from(
            "源 ID 与确认时不一致，已拒绝添加（内容可能已被替换）",
        ));
    }
    if root_fingerprint != expected_fingerprint.to_ascii_lowercase() {
        return Err(CmdError::from(
            "根指纹与确认时不一致，已拒绝添加（内容可能已被替换）",
        ));
    }

    {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        let exists: bool = db
            .conn
            .query_row(
                "SELECT 1 FROM trp_sources WHERE id = ?1",
                [&d.source.id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if exists {
            return Err(CmdError::from(format!(
                "源 {} 已存在，请使用同步",
                d.source.id
            )));
        }
        db.conn.execute(
            "INSERT INTO trp_sources
             (id, kind, discovery_url, display_name, operator, local, enabled, priority,
              profile, root_key_fingerprint, trust_confirmed_at, capabilities_json, delivery_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 100, 'tuf-v1', ?7, unixepoch(), ?8, ?9)",
            rusqlite::params![
                d.source.id,
                kind,
                canonical_url,
                d.source.name,
                d.source.operator,
                local as i64,
                root_fingerprint,
                capabilities_value(&d).to_string(),
                delivery_type(&d),
            ],
        )?;
    }

    // 首次同步：失败不回滚添加，只记录该源状态（故障隔离）
    drop(source_guard);
    let _ = sync_one(&state, &d.source.id).await;
    get_source_info(&state, &d.source.id)
}

#[tauri::command]
pub fn trp_source_list(state: State<AppState>) -> CmdResult<Vec<TrpSourceInfo>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let sql = format!("{SOURCE_INFO_SQL} ORDER BY s.priority, s.id");
    let mut stmt = db.conn.prepare(&sql)?;
    let rows = stmt.query_map([], source_info_row)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn trp_source_set_enabled(
    state: State<'_, AppState>,
    source_id: String,
    enabled: bool,
) -> CmdResult<()> {
    let _source_guard = source_install_lock(&source_id).lock_owned().await;
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let n = db.conn.execute(
        "UPDATE trp_sources SET enabled = ?2 WHERE id = ?1",
        rusqlite::params![source_id, enabled as i64],
    )?;
    if n == 0 {
        return Err(CmdError::from("源不存在"));
    }
    Ok(())
}

#[tauri::command]
pub async fn trp_source_set_priority(
    state: State<'_, AppState>,
    source_id: String,
    priority: i64,
) -> CmdResult<()> {
    if !(0..=1000).contains(&priority) {
        return Err(CmdError::from("优先级必须在 0-1000 之间"));
    }
    let _source_guard = source_install_lock(&source_id).lock_owned().await;
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let n = db.conn.execute(
        "UPDATE trp_sources SET priority = ?2 WHERE id = ?1",
        rusqlite::params![source_id, priority],
    )?;
    if n == 0 {
        return Err(CmdError::from("源不存在"));
    }
    Ok(())
}

/// 删除源（目录缓存级联删除；已安装工具不受影响——不实现远程删除本地工具）。
#[tauri::command]
pub async fn trp_source_remove(state: State<'_, AppState>, source_id: String) -> CmdResult<()> {
    let _source_guard = source_install_lock(&source_id).lock_owned().await;
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn
        .execute("DELETE FROM trp_sources WHERE id = ?1", [&source_id])?;
    Ok(())
}

/// 单源同步：重拉 discovery → 核对钉住的根指纹 → 拉取目录 → 事务写缓存。
/// 任何失败只更新该源的状态字段，不向上传播 panic/全局错误。（pub 供集成测试）
pub async fn sync_one(state: &AppState, source_id: &str) -> TrpSyncResult {
    let _source_guard = source_install_lock(source_id).lock_owned().await;
    let started = Instant::now();
    let result = sync_one_inner(state, source_id).await;
    let duration_ms = started.elapsed().as_millis() as i64;
    match result {
        Ok(entry_count) => {
            if let Ok(db) = state.db.lock() {
                let _ = db.conn.execute(
                    "UPDATE trp_sources SET last_sync_at = unixepoch(), last_sync_status = 'ok',
                     last_sync_error = NULL, last_sync_duration_ms = ?2 WHERE id = ?1",
                    rusqlite::params![source_id, duration_ms],
                );
            }
            TrpSyncResult {
                source_id: source_id.to_string(),
                ok: true,
                message: None,
                entry_count,
                duration_ms,
            }
        }
        Err(e) => {
            if let Ok(db) = state.db.lock() {
                let _ = db.conn.execute(
                    "UPDATE trp_sources SET last_sync_at = unixepoch(), last_sync_status = 'failed',
                     last_sync_error = ?2, last_sync_duration_ms = ?3 WHERE id = ?1",
                    rusqlite::params![source_id, e.message, duration_ms],
                );
            }
            TrpSyncResult {
                source_id: source_id.to_string(),
                ok: false,
                message: Some(e.message),
                entry_count: 0,
                duration_ms,
            }
        }
    }
}

async fn sync_one_inner(state: &AppState, source_id: &str) -> Result<i64, CmdError> {
    let (url, pinned_fp, local) = {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        db.conn.query_row(
            "SELECT discovery_url, root_key_fingerprint, local FROM trp_sources WHERE id = ?1",
            [source_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? != 0,
                ))
            },
        )?
    };

    let canonical_url = useful_repository_client::network::validate_url(&url, local)
        .map_err(|error| CmdError::from(format!("已保存源 URL 无效: {error}")))?
        .to_string();
    if canonical_url != url {
        return Err(CmdError::from(
            "已保存源 URL 不是 canonical 形式，请删除后重新确认来源身份",
        ));
    }

    let d = fetch_discovery(&url, local).await?;
    if d.source.id != source_id {
        return Err(CmdError::from("discovery 中的源 ID 与已添加的源不一致"));
    }
    // 信任根钉住：指纹变化必须由用户显式"重新建立信任"，拒绝静默接受
    if !d.repository.root_sha256.eq_ignore_ascii_case(&pinned_fp) {
        return Err(CmdError::from(
            "根指纹发生变化，已拒绝同步（如源确实轮换了密钥，请删除后重新添加以确认新指纹）",
        ));
    }

    let cat_url = catalog_url(&url, &d);
    let bytes = fetch_bytes_limited(&cat_url, MAX_CATALOG_SIZE, local).await?;
    let snap = parse_catalog(&bytes, source_id).map_err(|e| CmdError::from(e.to_string()))?;

    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn.execute_batch("BEGIN;")?;
    let write = || -> Result<(), CmdError> {
        db.conn.execute(
            "UPDATE trp_sources SET capabilities_json = ?2, delivery_type = ?3 WHERE id = ?1",
            rusqlite::params![
                source_id,
                capabilities_value(&d).to_string(),
                delivery_type(&d),
            ],
        )?;
        db.conn.execute(
            "DELETE FROM trp_catalog_cache WHERE source_id = ?1",
            [source_id],
        )?;
        for e in &snap.entries {
            db.conn.execute(
                "INSERT INTO trp_catalog_cache
                 (source_id, publisher_key_id, tool_id, name, summary, license,
                  latest_stable, latest_stable_digest, access_mode, is_native_worker,
                  entry_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                rusqlite::params![
                    source_id,
                    e.identity.publisher_key_id,
                    e.identity.tool_id,
                    e.name,
                    e.summary,
                    e.license,
                    e.latest.stable,
                    latest_stable_digest(e),
                    e.offer.access_mode,
                    e.is_native_worker as i64,
                    serde_json::to_string(e).map_err(|e| CmdError::from(e.to_string()))?,
                    e.updated_at,
                ],
            )?;
        }
        Ok(())
    };
    match write() {
        Ok(()) => {
            db.conn.execute_batch("COMMIT;")?;
            Ok(snap.entries.len() as i64)
        }
        Err(e) => {
            let _ = db.conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn trp_source_sync(
    state: State<'_, AppState>,
    source_id: String,
) -> CmdResult<TrpSyncResult> {
    Ok(sync_one(&state, &source_id).await)
}

/// 同步全部启用源：逐源独立执行并汇总；单源失败不影响其他源。
#[tauri::command]
pub async fn trp_source_sync_all(state: State<'_, AppState>) -> CmdResult<Vec<TrpSyncResult>> {
    let ids: Vec<String> = {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        let mut stmt = db
            .conn
            .prepare("SELECT id FROM trp_sources WHERE enabled = 1 ORDER BY priority, id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let mut results = Vec::with_capacity(ids.len());
    for id in ids {
        results.push(sync_one(&state, &id).await);
    }
    Ok(results)
}

/// 多源本地搜索：默认使用已同步的本地缓存（不把搜索词发给任何源）。
/// 合并规则见 useful_repository_client::search（同名不同发布者不合并；镜像折叠）。
#[tauri::command]
pub fn trp_catalog_search(state: State<AppState>, keyword: String) -> CmdResult<Vec<MergedItem>> {
    if keyword.len() > 256 {
        return Err(CmdError::from("搜索词过长"));
    }
    let items: Vec<CatalogItem> = {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        let mut stmt = db.conn.prepare(
            "SELECT c.source_id, s.priority, c.publisher_key_id, c.tool_id, c.name,
                    c.summary, c.license, c.latest_stable, c.latest_stable_digest,
                    c.access_mode, c.is_native_worker, c.entry_json
             FROM trp_catalog_cache c
             JOIN trp_sources s ON s.id = c.source_id AND s.enabled = 1",
        )?;
        let rows = stmt.query_map([], |r| {
            let entry_json: String = r.get(11)?;
            // 公告来自缓存条目；所有 review/verified 布尔都来自未验证
            // catalog，不能提升客户端验证状态。
            let parsed: Option<CatalogEntry> = serde_json::from_str(&entry_json).ok();
            let advisories = parsed
                .as_ref()
                .map(|entry| entry.advisories.clone())
                .unwrap_or_default();
            Ok(CatalogItem {
                source_id: r.get(0)?,
                source_priority: r.get(1)?,
                publisher_key_id: r.get(2)?,
                tool_id: r.get(3)?,
                name: r.get(4)?,
                summary: r.get(5)?,
                license: r.get(6)?,
                latest_stable: r.get(7)?,
                latest_stable_digest: r.get(8)?,
                access_mode: r.get(9)?,
                is_native_worker: r.get::<_, i64>(10)? != 0,
                // Catalog sync is intentionally not TUF-verified. Its review
                // booleans are display assertions, never client verification
                // state. Install independently verifies both boundaries.
                repository_signature_verified: false,
                publisher_signature_verified: false,
                official_review_passed: false,
                security_scan_passed: false,
                availability: parsed.as_ref().and_then(|entry| entry.availability.clone()),
                advisory_count: advisories.len() as u32,
                max_advisory_severity: max_advisory_severity(&advisories),
            })
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let merged = merge_catalog(items);
    Ok(filter_items(&merged, &keyword))
}

// ---------- TRP 安装与更新（TUF 验证 + 来源/发布者固定） ----------

/// root 轮换链长度上限。
const MAX_ROOT_ROTATIONS: u64 = 32;
const MAX_ROOT_VERSION: u64 = MAX_ROOT_ROTATIONS + 1;

fn bounded_root_candidate(
    version: u64,
    bytes: Option<Vec<u8>>,
) -> Result<Option<Vec<u8>>, CmdError> {
    match bytes {
        Some(_) if version > MAX_ROOT_VERSION => Err(CmdError::from(format!(
            "root 轮换链超过客户端上限 {MAX_ROOT_ROTATIONS}，拒绝不完整恢复"
        ))),
        other => Ok(other),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrpUpdateCheck {
    pub tool_id: String,
    pub installed_version: String,
    pub candidate_version: Option<String>,
    pub decision: Option<UpdateDecision>,
}

struct SourceRow {
    discovery_url: String,
    pinned_fp: String,
    local: bool,
    enabled: bool,
}

fn source_install_lock(source_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(source_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn load_source_row(state: &AppState, source_id: &str) -> Result<SourceRow, CmdError> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let row = db.conn.query_row(
        "SELECT discovery_url, root_key_fingerprint, local, enabled FROM trp_sources WHERE id = ?1",
        [source_id],
        |r| {
            Ok(SourceRow {
                discovery_url: r.get(0)?,
                pinned_fp: r.get(1)?,
                local: r.get::<_, i64>(2)? != 0,
                enabled: r.get::<_, i64>(3)? != 0,
            })
        },
    )?;
    let canonical = useful_repository_client::network::validate_url(&row.discovery_url, row.local)
        .map_err(|error| CmdError::from(format!("已保存源 URL 无效: {error}")))?
        .to_string();
    if canonical != row.discovery_url {
        return Err(CmdError::from(
            "已保存源 URL 不是 canonical 形式，请删除后重新确认来源身份",
        ));
    }
    if row.pinned_fp.len() != 64
        || row
            .pinned_fp
            .bytes()
            .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
    {
        return Err(CmdError::from("已保存源根指纹不是 canonical SHA-256"));
    }
    Ok(row)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// 拉取全套 TUF metadata：1.root.json 必须匹配钉住的根指纹（信任锚），
/// 其余文件只预取；真正的验证由 BuiltinTufBackend 完成（fail closed）。
async fn fetch_tuf_metadata(
    metadata_base: &str,
    pinned_fp: &str,
    allow_local: bool,
) -> Result<(Vec<u8>, BTreeMap<String, Vec<u8>>), CmdError> {
    let base = metadata_base.trim_end_matches('/');
    let fetch = |name: String| async move {
        fetch_bytes_limited(&format!("{base}/{name}"), MAX_METADATA_SIZE, allow_local).await
    };

    let root_bytes = fetch("1.root.json".into()).await?;
    if !sha256_hex(&root_bytes).eq_ignore_ascii_case(pinned_fp) {
        return Err(CmdError::from(
            "源的 1.root.json 与确认时钉住的根指纹不匹配——拒绝安装",
        ));
    }

    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    // TRP v1 discovery has no authenticated "latest root version" hint, so
    // recovery must walk sequentially. Only a real 404 ends the walk; a root
    // beyond the bounded client profile fails closed instead of silently using
    // an older root.
    // Probe one version beyond the accepted chain so a present 33rd rotation
    // fails closed instead of being mistaken for the end of the repository.
    for v in 2..=MAX_ROOT_VERSION + 1 {
        let name = format!("{v}.root.json");
        let url = format!("{base}/{name}");
        match bounded_root_candidate(
            v,
            fetch_optional_root(&url, MAX_METADATA_SIZE, allow_local).await?,
        )? {
            Some(bytes) => {
                files.insert(name, bytes);
            }
            None => break,
        }
    }
    // timestamp → （未验证预解析仅用于确定文件名）snapshot → targets
    let ts_bytes = fetch("timestamp.json".into()).await?;
    let ts: serde_json::Value = serde_json::from_slice(&ts_bytes)
        .map_err(|e| CmdError::from(format!("timestamp 解析失败: {e}")))?;
    let snap_ver = ts
        .pointer("/signed/meta/snapshot.json/version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| CmdError::from("timestamp 缺少 snapshot 版本"))?;
    let snap_name = format!("{snap_ver}.snapshot.json");
    let snap_bytes = fetch(snap_name.clone()).await?;
    let snap: serde_json::Value = serde_json::from_slice(&snap_bytes)
        .map_err(|e| CmdError::from(format!("snapshot 解析失败: {e}")))?;
    let tgt_ver = snap
        .pointer("/signed/meta/targets.json/version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| CmdError::from("snapshot 缺少 targets 版本"))?;
    let tgt_name = format!("{tgt_ver}.targets.json");
    let tgt_bytes = fetch(tgt_name.clone()).await?;

    files.insert("timestamp.json".into(), ts_bytes);
    files.insert(snap_name, snap_bytes);
    files.insert(tgt_name, tgt_bytes);
    Ok((root_bytes, files))
}

/// 从目录条目选出 stable 频道最新、本平台、未撤回的制品。
fn pick_stable_artifact(
    entry: &CatalogEntry,
) -> Result<Option<&useful_repository_client::catalog::ArtifactInfo>, CmdError> {
    let Some(stable) = entry.latest.stable.as_deref() else {
        return Ok(None);
    };
    let mut matches = entry.artifacts.iter().filter(|a| {
        a.channel == "stable"
            && a.version == stable
            && a.platform == "windows"
            && a.arch == "x86_64"
            && !a.withdrawn
    });
    let selected = matches.next();
    if matches.next().is_some() {
        return Err(CmdError::from(
            "目录对 stable/windows/x86_64 声明了多个相同版本制品",
        ));
    }
    Ok(selected)
}

fn pick_stable_artifact_version<'a>(
    entry: &'a CatalogEntry,
    version: &str,
) -> Result<Option<&'a useful_repository_client::catalog::ArtifactInfo>, CmdError> {
    let mut matches = entry.artifacts.iter().filter(|artifact| {
        artifact.channel == "stable"
            && artifact.version == version
            && artifact.platform == "windows"
            && artifact.arch == "x86_64"
            && !artifact.withdrawn
    });
    let selected = matches.next();
    if matches.next().is_some() {
        return Err(CmdError::from(
            "目录对请求的 stable/windows/x86_64 版本声明了多个制品",
        ));
    }
    Ok(selected)
}

fn load_entry(
    state: &AppState,
    source_id: &str,
    publisher_key_id: &str,
    tool_id: &str,
) -> Result<CatalogEntry, CmdError> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let entry_json: String = db.conn.query_row(
        "SELECT entry_json FROM trp_catalog_cache
         WHERE source_id = ?1 AND publisher_key_id = ?2 AND tool_id = ?3",
        rusqlite::params![source_id, publisher_key_id, tool_id],
        |r| r.get(0),
    )?;
    serde_json::from_str(&entry_json).map_err(|e| CmdError::from(format!("目录条目损坏: {e}")))
}

fn load_installed_origin(state: &AppState, tool_id: &str) -> Option<InstalledOrigin> {
    let db = state.db.lock().ok()?;
    db.conn
        .query_row(
            "SELECT source_id, publisher_key_id, tool_id, installed_version, artifact_sha256,
                    channel, manifest_digest
             FROM installed_origins WHERE tool_id = ?1",
            [tool_id],
            |r| {
                Ok(InstalledOrigin {
                    source_id: r.get(0)?,
                    publisher_key_id: r.get(1)?,
                    tool_id: r.get(2)?,
                    installed_version: r.get(3)?,
                    artifact_sha256: r.get(4)?,
                    channel: r.get(5)?,
                    manifest_digest: r.get(6)?,
                })
            },
        )
        .ok()
}

fn granted_permissions(state: &AppState, tool_id: &str) -> Vec<String> {
    let Ok(db) = state.db.lock() else {
        return vec![];
    };
    let Ok(mut stmt) = db
        .conn
        .prepare("SELECT permission FROM granted_permissions WHERE tool_id = ?1")
    else {
        return vec![];
    };
    stmt.query_map([tool_id], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

/// 从 TRP 源安装（或更新）工具：TUF 验证 → 摩根比对 → 下载 → 校验 → 安装 → 记录来源。
/// 更新时强制来源固定 + 发布者固定（evaluate_update，默认拒绝跨源/换钥/降级）。
#[tauri::command]
pub async fn trp_install(
    app: AppHandle,
    state: State<'_, AppState>,
    source_id: String,
    publisher_key_id: String,
    tool_id: String,
    permissions_confirmed: bool,
) -> CmdResult<useful_core::registry::ToolDefinition> {
    install_from_trp_source_version(
        &state,
        &source_id,
        &publisher_key_id,
        &tool_id,
        None,
        permissions_confirmed,
        false,
        Some(app),
    )
    .await
}

/// 安装内核（供命令与集成测试复用）。
pub async fn install_from_trp_source(
    state: &AppState,
    source_id: &str,
    publisher_key_id: &str,
    tool_id: &str,
    permissions_confirmed: bool,
) -> Result<useful_core::registry::ToolDefinition, CmdError> {
    install_from_trp_source_version(
        state,
        source_id,
        publisher_key_id,
        tool_id,
        None,
        permissions_confirmed,
        false,
        None,
    )
    .await
}

async fn install_from_trp_source_version(
    state: &AppState,
    source_id: &str,
    publisher_key_id: &str,
    tool_id: &str,
    target_version: Option<&str>,
    permissions_confirmed: bool,
    allow_downgrade: bool,
    app: Option<AppHandle>,
) -> Result<useful_core::registry::ToolDefinition, CmdError> {
    // Global lock order is tool -> source. Hold both from the first origin
    // read through filesystem, SQLite and registry commit/rollback.
    let _tool_guard = super::plugins::tool_mutation_lock(tool_id)
        .lock_owned()
        .await;
    let _source_guard = source_install_lock(source_id).lock_owned().await;
    let src = load_source_row(state, source_id)?;
    if !src.enabled {
        return Err(CmdError::from("源已禁用"));
    }

    // 1) 目录条目与候选制品
    let entry = load_entry(state, source_id, publisher_key_id, tool_id)?;
    if entry.offer.access_mode != "free" {
        return Err(CmdError::from(
            "非免费制品需要下载授权（DownloadGrant，Phase 8）",
        ));
    }
    if entry.is_native_worker {
        return Err(CmdError::from("公开源禁止安装原生 worker 工具"));
    }
    let artifact = match target_version {
        Some(version) => pick_stable_artifact_version(&entry, version),
        None => pick_stable_artifact(&entry),
    }?
    .ok_or_else(|| CmdError::from("该工具没有可用的 stable 制品（windows/x86_64）"))?
    .clone();

    // 2) 来源固定 / 发布者固定（已安装时）
    let origin = load_installed_origin(state, tool_id);
    let granted = granted_permissions(state, tool_id);
    let added_permissions: Vec<String> = if let Some(origin) = &origin {
        let candidate = UpdateCandidate {
            source_id: source_id.to_string(),
            publisher_key_id: publisher_key_id.to_string(),
            tool_id: tool_id.to_string(),
            version: artifact.version.clone(),
            artifact_sha256: artifact.artifact_sha256.clone(),
            channel: artifact.channel.clone(),
            permissions: artifact.permissions.clone(),
        };
        if allow_downgrade {
            if candidate.source_id != origin.source_id
                || candidate.publisher_key_id != origin.publisher_key_id
                || candidate.tool_id != origin.tool_id
                || candidate.channel != origin.channel
            {
                return Err(CmdError::from("回滚被来源/发布者/频道固定策略拒绝"));
            }
            let current = semver::Version::parse(&origin.installed_version)
                .map_err(|_| CmdError::from("已安装版本不是合法 SemVer"))?;
            let target = semver::Version::parse(&candidate.version)
                .map_err(|_| CmdError::from("回滚目标不是合法 SemVer"))?;
            if target >= current {
                return Err(CmdError::from("回滚目标必须低于当前版本"));
            }
            candidate
                .permissions
                .iter()
                .filter(|permission| !granted.contains(permission))
                .cloned()
                .collect()
        } else {
            match evaluate_update(origin, &candidate, &granted) {
                UpdateDecision::Allow { added_permissions } => added_permissions,
                UpdateDecision::Reject { reason } => {
                    return Err(CmdError::from(format!(
                        "更新被来源/发布者固定策略拒绝: {reason:?}（如需更换来源请使用显式的“迁移工具来源”操作）"
                    )));
                }
            }
        }
    } else {
        artifact.permissions.clone()
    };
    if !added_permissions.is_empty() && !permissions_confirmed {
        return Err(CmdError::from(format!(
            "需要确认权限: {}",
            added_permissions.join(", ")
        )));
    }

    // 3) TUF 验证链（信任锚 = 用户确认时钉住的根指纹）
    let dev = super::sources::developer_mode_enabled(state);
    check_discovery_url(&src.discovery_url, dev || src.local)?;
    let d = fetch_discovery(&src.discovery_url, src.local).await?;
    let (trusted_root, files) =
        fetch_tuf_metadata(&d.repository.metadata_base_url, &src.pinned_fp, src.local).await?;
    let verified = BuiltinTufBackend
        .verify(&files, &trusted_root, &now_rfc3339())
        .map_err(|e| {
            CmdError::coded("signature_invalid", format!("TUF 验证失败，拒绝安装: {e}"))
        })?;
    // Fast replay rejection before downloading the target. The atomic compare
    // and advance happens only after every target/publisher check succeeds.
    {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        let last = db.trp_tuf_versions(source_id)?;
        ensure_monotonic_versions(
            TufVersions {
                root: last.root,
                timestamp: last.timestamp,
                snapshot: last.snapshot,
                targets: last.targets,
            },
            verified.versions(),
        )
        .map_err(|error| CmdError::from(format!("TUF 防回滚状态拒绝安装: {error}")))?;
    }

    // 4) 目录制品必须被 TUF targets 声明（摘要一致）
    let (target_name, target_info) = select_unique_publisher_target(
        &verified.targets,
        PublisherTargetExpectation {
            publisher_key_id,
            tool_id,
            version: &artifact.version,
            channel: &artifact.channel,
            platform: &artifact.platform,
            arch: &artifact.arch,
            artifact_sha256: &artifact.artifact_sha256,
        },
    )
    .map_err(|error| {
        CmdError::coded(
            "signature_invalid",
            format!("发布者独立签名证明无效，拒绝安装: {error}"),
        )
    })?;

    // 5) 下载 target（consistent 路径 <sha256>.<文件名>）并校验 hash+length
    let targets_base = d.repository.targets_base_url.trim_end_matches('/');
    let url = format!("{targets_base}/{}.{target_name}", target_info.sha256);
    let package_limit = useful_plugin::install::InstallOptions::default().max_package_size;
    if target_info.length > package_limit {
        return Err(CmdError::coded(
            "size_mismatch",
            "TUF target 超过插件包大小上限",
        ));
    }
    let target_length = usize::try_from(target_info.length)
        .map_err(|_| CmdError::coded("size_mismatch", "TUF target 长度超出当前平台范围"))?;
    let tracker = app
        .map(|app| {
            super::downloads::TrustedInstallTracker::begin(
                app,
                tool_id,
                &artifact.version,
                &target_info.sha256,
                target_info.length,
            )
        })
        .transpose()?;
    let track = |result: Result<(), CmdError>| {
        if let (Some(tracker), Err(error)) = (&tracker, &result) {
            tracker.fail(error);
        }
        result
    };
    if let Some(tracker) = &tracker {
        track(tracker.progress("downloading", 0))?;
    }
    let bytes = match fetch_bytes_limited(&url, target_length, src.local).await {
        Ok(bytes) => bytes,
        Err(error) => {
            if let Some(tracker) = &tracker {
                tracker.fail(&error);
            }
            return Err(error);
        }
    };
    if let Some(tracker) = &tracker {
        track(tracker.progress("verifying", bytes.len() as u64))?;
    }
    let verify_result = verify_target_bytes(target_info, &bytes).map_err(|e| {
        let message = e.to_string();
        let code = if message.to_ascii_lowercase().contains("length") {
            "size_mismatch"
        } else {
            "signature_invalid"
        };
        CmdError::coded(code, format!("制品校验失败，拒绝安装: {message}"))
    });
    if let Err(error) = verify_result {
        if let Some(tracker) = &tracker {
            tracker.fail(&error);
        }
        return Err(error);
    }

    // 6) 写入 staging 临时文件后走统一安装管线（ZIP 安全/原子安装/失败回滚）
    let prepare_result = std::fs::create_dir_all(&state.paths.staging_dir)
        .map_err(|e| CmdError::from(e.to_string()));
    track(prepare_result)?;
    let tmp_path = state
        .paths
        .staging_dir
        .join(format!("trp-{}.useful", uuid::Uuid::new_v4()));
    let write_result = std::fs::write(&tmp_path, &bytes).map_err(|e| CmdError::from(e.to_string()));
    track(write_result)?;

    if let Some(tracker) = &tracker {
        track(tracker.progress("installing", bytes.len() as u64))?;
    }
    let install_result = (|| -> Result<useful_core::registry::ToolDefinition, CmdError> {
        // manifest 摘要与目录声明一致（防目录/制品不一致）
        let manifest_bytes = useful_plugin::zip_safety::read_manifest_bytes(&tmp_path)
            .map_err(|e| CmdError::from(e.to_string()))?;
        if !sha256_hex(&manifest_bytes).eq_ignore_ascii_case(&artifact.manifest_digest) {
            return Err(CmdError::coded(
                "signature_invalid",
                "包内 manifest 与目录声明的摘要不一致——拒绝安装",
            ));
        }
        let manifest = useful_plugin::manifest::PluginManifest::parse_and_validate(&manifest_bytes)
            .map_err(|e| CmdError::from(e.to_string()))?;
        let mut expected_permissions = artifact.permissions.clone();
        expected_permissions.sort();
        let mut manifest_permissions = manifest.permissions.clone();
        manifest_permissions.sort();
        if manifest.id != tool_id
            || manifest.version != artifact.version
            || manifest_permissions != expected_permissions
        {
            return Err(CmdError::coded(
                "signature_invalid",
                "包内 manifest 与目录工具身份或权限不一致——拒绝安装",
            ));
        }
        let opts = useful_plugin::install::InstallOptions {
            host_version: HOST_VERSION.into(),
            installed_version: origin.as_ref().map(|o| o.installed_version.clone()),
            allow_downgrade,
            expected_sha256: Some(artifact.artifact_sha256.clone()),
            ..Default::default()
        };
        let outcome = useful_plugin::install::install_useful(
            &tmp_path,
            &state.paths.staging_dir,
            &state.paths.plugins_dir,
            &opts,
        )
        .map_err(|e| CmdError::from(e.to_string()))?;
        let metadata = verified.metadata_state();
        let commit = super::plugins::TrpInstallCommit {
            source_id: source_id.to_string(),
            discovery_url: src.discovery_url.clone(),
            root_fingerprint: src.pinned_fp.clone(),
            publisher_key_id: publisher_key_id.to_string(),
            installed_version: artifact.version.clone(),
            artifact_sha256: artifact.artifact_sha256.to_lowercase(),
            channel: artifact.channel.clone(),
            manifest_digest: artifact.manifest_digest.to_lowercase(),
            tuf_state: useful_core::db::TrpTufState {
                versions: useful_core::db::TrpTufVersions {
                    root: metadata.versions.root,
                    timestamp: metadata.versions.timestamp,
                    snapshot: metadata.versions.snapshot,
                    targets: metadata.versions.targets,
                },
                root_sha256: metadata.root_sha256,
                timestamp_sha256: metadata.timestamp_sha256,
                snapshot_sha256: metadata.snapshot_sha256,
                targets_sha256: metadata.targets_sha256,
            },
        };
        super::plugins::persist_installed(state, outcome, Some(&commit))
    })();
    let _ = std::fs::remove_file(&tmp_path);
    if let Some(tracker) = &tracker {
        match &install_result {
            Ok(_) => tracker.complete(),
            Err(error) => tracker.fail(error),
        }
    }
    install_result
}

#[tauri::command]
pub async fn trp_rollback(
    state: State<'_, AppState>,
    tool_id: String,
    target_version: String,
    permissions_confirmed: bool,
) -> CmdResult<useful_core::registry::ToolDefinition> {
    rollback_from_trp_source(&state, &tool_id, &target_version, permissions_confirmed).await
}

pub async fn rollback_from_trp_source(
    state: &AppState,
    tool_id: &str,
    target_version: &str,
    permissions_confirmed: bool,
) -> Result<useful_core::registry::ToolDefinition, CmdError> {
    let origin = load_installed_origin(state, tool_id)
        .ok_or_else(|| CmdError::from("该工具没有 TRP 来源记录"))?;
    install_from_trp_source_version(
        state,
        &origin.source_id,
        &origin.publisher_key_id,
        tool_id,
        Some(target_version),
        permissions_confirmed,
        true,
        None,
    )
    .await
}

/// 检查已安装工具的更新（仅在其固定的来源+发布者内查找，绝不跨源选最高版本）。
#[tauri::command]
pub fn trp_check_update(state: State<AppState>, tool_id: String) -> CmdResult<TrpUpdateCheck> {
    let origin = load_installed_origin(&state, &tool_id)
        .ok_or_else(|| CmdError::from("该工具没有 TRP 来源记录"))?;
    let entry = match load_entry(
        &state,
        &origin.source_id,
        &origin.publisher_key_id,
        &tool_id,
    ) {
        Ok(e) => e,
        Err(_) => {
            return Ok(TrpUpdateCheck {
                tool_id,
                installed_version: origin.installed_version,
                candidate_version: None,
                decision: None,
            })
        }
    };
    let Some(artifact) = pick_stable_artifact(&entry)? else {
        return Ok(TrpUpdateCheck {
            tool_id,
            installed_version: origin.installed_version,
            candidate_version: None,
            decision: None,
        });
    };
    let granted = granted_permissions(&state, &tool_id);
    let candidate = UpdateCandidate {
        source_id: origin.source_id.clone(),
        publisher_key_id: origin.publisher_key_id.clone(),
        tool_id: tool_id.clone(),
        version: artifact.version.clone(),
        artifact_sha256: artifact.artifact_sha256.clone(),
        channel: artifact.channel.clone(),
        permissions: artifact.permissions.clone(),
    };
    let decision = evaluate_update(&origin, &candidate, &granted);
    Ok(TrpUpdateCheck {
        tool_id,
        installed_version: origin.installed_version,
        candidate_version: Some(artifact.version.clone()),
        decision: Some(decision),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_url_prefers_api_base() {
        let d: RepositoryDiscovery = serde_json::from_value(serde_json::json!({
            "schemaVersion": "1.0",
            "source": { "id": "com.example.s", "name": "S", "operator": "Op" },
            "repository": {
                "profile": "tuf-v1",
                "metadataBaseUrl": "https://s.example/metadata/",
                "targetsBaseUrl": "https://s.example/targets/",
                "rootUrl": "https://s.example/metadata/1.root.json",
                "rootSha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
            },
            "api": { "baseUrl": "https://api.s.example/v1/" },
            "capabilities": { "catalog": true }
        }))
        .unwrap();
        assert_eq!(
            catalog_url("https://s.example/.well-known/useful-repository.json", &d),
            "https://api.s.example/v1/catalog/snapshot"
        );
    }

    #[test]
    fn catalog_url_static_falls_back_to_sibling_path() {
        let d: RepositoryDiscovery = serde_json::from_value(serde_json::json!({
            "schemaVersion": "1.0",
            "source": { "id": "com.example.s", "name": "S", "operator": "Op" },
            "repository": {
                "profile": "tuf-v1",
                "metadataBaseUrl": "https://s.example/metadata/",
                "targetsBaseUrl": "https://s.example/targets/",
                "rootUrl": "https://s.example/metadata/1.root.json",
                "rootSha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
            },
            "capabilities": { "catalog": true }
        }))
        .unwrap();
        assert_eq!(
            catalog_url("https://s.example/.well-known/useful-repository.json", &d),
            "https://s.example/catalog/snapshot.json"
        );
        assert_eq!(delivery_type(&d), "static-https");
    }

    #[test]
    fn delivery_type_uses_api_presence_not_provider_claims() {
        let d: RepositoryDiscovery = serde_json::from_value(serde_json::json!({
            "schemaVersion": "1.0",
            "source": { "id": "com.example.s", "name": "S", "operator": "Op" },
            "repository": {
                "profile": "tuf-v1",
                "metadataBaseUrl": "https://s.example/metadata/",
                "targetsBaseUrl": "https://s.example/targets/",
                "rootUrl": "https://s.example/metadata/1.root.json",
                "rootSha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
            },
            "api": { "baseUrl": "https://api.s.example/v1/" },
            "capabilities": { "catalog": true, "staticMirror": true }
        }))
        .unwrap();
        assert_eq!(delivery_type(&d), "dynamic");
    }

    #[test]
    fn non_https_rejected_without_developer_mode() {
        assert!(check_discovery_url("http://evil.example/x.json", false).is_err());
        assert!(check_discovery_url("http://127.0.0.1:8080/x.json", false).is_err());
        // 开发者模式下本地 URL 允许并标记 local
        assert!(check_discovery_url("http://127.0.0.1:8080/x.json", true).unwrap());
        assert!(!check_discovery_url(
            "https://source.example/.well-known/useful-repository.json",
            false
        )
        .unwrap());
    }

    #[test]
    fn discovery_identity_uses_canonical_url_text() {
        let (local, canonical) = canonical_discovery_url(
            "HTTPS://SOURCE.EXAMPLE:443/.well-known/useful-repository.json",
            false,
        )
        .unwrap();
        assert!(!local);
        assert_eq!(
            canonical,
            "https://source.example/.well-known/useful-repository.json"
        );
    }

    #[test]
    fn root_recovery_limit_fails_closed() {
        assert!(bounded_root_candidate(MAX_ROOT_VERSION, Some(vec![1])).is_ok());
        assert!(bounded_root_candidate(MAX_ROOT_VERSION + 1, Some(vec![1])).is_err());
        assert!(bounded_root_candidate(MAX_ROOT_VERSION + 1, None)
            .unwrap()
            .is_none());
    }

    #[test]
    fn discovery_cannot_self_assert_a_different_root_fingerprint() {
        let root = b"authenticated root bytes";
        let digest = sha256_hex(root);
        assert_eq!(
            match_discovery_root_fingerprint(root, &digest).unwrap(),
            digest
        );
        assert!(match_discovery_root_fingerprint(root, &"00".repeat(32)).is_err());
    }
}
