//! 工具源管理命令：添加/列出/启停/删除/刷新/指纹，以及商店目录聚合与权限差异。
//!
//! URL 策略：默认仅 HTTPS；开发者模式才允许 localhost / HTTP / file，UI 显示显著警告。
//! 源索引使用 Ed25519 验签；已添加源的公钥被“钉住”，刷新时换钥直接拒绝。

use super::{CmdError, CmdResult};
use crate::state::AppState;
use serde::Serialize;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use tauri::State;
use useful_plugin::signing::public_key_fingerprint;
use useful_plugin::source::SourceIndex;

/// 源索引大小上限（防炸弹）。
const MAX_INDEX_SIZE: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub url: String,
    pub public_key: String,
    pub fingerprint: String,
    pub enabled: bool,
    pub last_refreshed_at: Option<i64>,
    pub package_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopPackage {
    pub source_id: String,
    pub id: String,
    pub version: String,
    pub size: u64,
    pub changelog: String,
    pub category: String,
    pub permissions: Vec<String>,
    pub min_host_version: String,
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub downgrade: bool,
    pub pinned: bool,
}

/// 读取开发者模式设置。
pub(crate) fn developer_mode_enabled(state: &AppState) -> bool {
    let Ok(db) = state.db.lock() else {
        return false;
    };
    db.conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'developerMode'",
            [],
            |r| r.get::<_, String>(0),
        )
        .map(|v| v == "true")
        .unwrap_or(false)
}

/// 校验 URL 策略，失败时返回用户可读错误。
pub(crate) fn check_url_policy(url: &str, developer_mode: bool) -> Result<(), CmdError> {
    useful_repository_client::network::validate_url(url, developer_mode)
        .map(|_| ())
        .map_err(|error| CmdError::from(format!("URL 被网络安全策略拒绝: {error}")))
}

/// 将标准 file URL 转换为当前平台的绝对路径，并保留 URL 百分号解码语义。
pub(crate) fn file_url_path(url: &str) -> Result<Option<PathBuf>, CmdError> {
    if !url.starts_with("file://") {
        return Ok(None);
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| CmdError::from(format!("本地文件 URL 无效: {error}")))?;
    parsed
        .to_file_path()
        .map(Some)
        .map_err(|_| CmdError::from("本地文件 URL 必须表示当前平台的绝对路径"))
}

/// 拉取 URL 字节（支持开发者模式下 file://）。带大小上限。
pub(crate) async fn pinned_client_for_url(
    url: &reqwest::Url,
    allow_local: bool,
) -> Result<reqwest::Client, CmdError> {
    let host = url
        .host_str()
        .ok_or_else(|| CmdError::from("网络 URL 缺少主机"))?
        .to_string();
    let literal_host = host.trim_start_matches('[').trim_end_matches(']');
    let port = url
        .port_or_known_default()
        .ok_or_else(|| CmdError::from("网络 URL 缺少端口"))?;
    let local_destination = useful_repository_client::discovery::is_local_url(url.as_str());
    let ips: Vec<IpAddr> = if let Ok(ip) = literal_host.parse() {
        vec![ip]
    } else {
        let lookup_host = host.clone();
        tokio::task::spawn_blocking(move || {
            (lookup_host.as_str(), port)
                .to_socket_addrs()
                .map(|iter| iter.map(|addr| addr.ip()).collect::<Vec<_>>())
        })
        .await
        .map_err(|error| CmdError::from(format!("DNS 解析任务异常: {error}")))?
        .map_err(|error| CmdError::from(format!("DNS 解析失败: {error}")))?
    };
    let ips = useful_repository_client::network::validate_resolved_addresses(
        ips,
        allow_local && local_destination,
    )
    .map_err(|error| CmdError::from(format!("目标地址被网络安全策略拒绝: {error}")))?;
    let addresses: Vec<SocketAddr> = ips
        .into_iter()
        .map(|ip| SocketAddr::new(ip, port))
        .collect();
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // A proxy could resolve the original hostname again and defeat the
        // audited/pinned address set.
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30));
    if literal_host.parse::<IpAddr>().is_err() {
        builder = builder.resolve_to_addrs(&host, &addresses);
    }
    builder
        .build()
        .map_err(|error| CmdError::from(format!("创建固定解析 HTTP 客户端失败: {error}")))
}

/// GET with manual redirects. Every hop is syntax-checked, freshly resolved,
/// fully address-filtered, and then pinned into that hop's reqwest client.
pub(crate) async fn secure_get(
    url: &str,
    allow_local: bool,
) -> Result<reqwest::Response, CmdError> {
    let mut current = useful_repository_client::network::validate_url(url, allow_local)
        .map_err(|error| CmdError::from(format!("URL 被网络安全策略拒绝: {error}")))?;
    for redirects_followed in 0..=useful_repository_client::discovery::MAX_REDIRECTS {
        let client = pinned_client_for_url(&current, allow_local).await?;
        let response = client
            .get(current.clone())
            .send()
            .await
            .map_err(|error| CmdError::from(format!("请求失败: {error}")))?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .ok_or_else(|| CmdError::from("重定向响应缺少 Location"))?
            .to_str()
            .map_err(|_| CmdError::from("重定向 Location 不是合法文本"))?;
        current = useful_repository_client::network::validate_redirect(
            &current,
            location,
            redirects_followed,
            allow_local,
        )
        .map_err(|error| CmdError::from(format!("重定向被网络安全策略拒绝: {error}")))?;
    }
    Err(CmdError::from("重定向次数超限"))
}

pub(crate) async fn fetch_bytes(
    url: &str,
    max_size: u64,
    allow_local: bool,
) -> Result<Vec<u8>, CmdError> {
    useful_repository_client::network::validate_url(url, allow_local)
        .map_err(|error| CmdError::from(format!("URL 被网络安全策略拒绝: {error}")))?;
    if let Some(path) = file_url_path(url)? {
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| CmdError::from(format!("读取本地索引失败: {e}")))?;
        if bytes.len() as u64 > max_size {
            return Err(CmdError::from("索引文件超过大小上限"));
        }
        return Ok(bytes);
    }
    let resp = secure_get(url, allow_local).await?;
    if !resp.status().is_success() {
        return Err(CmdError::from(format!("HTTP 状态异常: {}", resp.status())));
    }
    if let Some(len) = resp.content_length() {
        if len > max_size {
            return Err(CmdError::from("索引文件超过大小上限"));
        }
    }

    let mut bytes: Vec<u8> = Vec::new();
    let mut resp = resp;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| CmdError::from(format!("下载中断: {e}")))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > max_size {
            return Err(CmdError::from("索引文件超过大小上限"));
        }
    }
    Ok(bytes)
}

/// 把验证过的索引写入数据库（tool_sources + source_packages 全量替换）。
fn persist_index(state: &AppState, url: &str, index: &SourceIndex) -> Result<(), CmdError> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let cached = serde_json::to_string(index).map_err(|e| CmdError::from(e.to_string()))?;
    db.conn.execute(
        "INSERT INTO tool_sources (id, name, url, public_key, enabled, last_refreshed_at, cached_index_json)
         VALUES (?1, ?2, ?3, ?4, 1, unixepoch(), ?5)
         ON CONFLICT(id) DO UPDATE SET name=?2, url=?3, last_refreshed_at=unixepoch(), cached_index_json=?5",
        rusqlite::params![index.source_id, index.name, url, index.public_key, cached],
    )?;
    db.conn.execute(
        "DELETE FROM source_packages WHERE source_id = ?1",
        [&index.source_id],
    )?;
    for p in &index.packages {
        db.conn.execute(
            "INSERT INTO source_packages
             (source_id, package_id, version, package_url, sha256, size, changelog, category, permissions_json, min_host_version, platforms_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(source_id, package_id, version) DO UPDATE SET
               package_url=?4, sha256=?5, size=?6, changelog=?7, category=?8, permissions_json=?9, min_host_version=?10, platforms_json=?11",
            rusqlite::params![
                index.source_id,
                p.id,
                p.version,
                p.package_url,
                p.sha256,
                p.size,
                p.changelog,
                p.category,
                serde_json::to_string(&p.permissions).unwrap_or_else(|_| "[]".into()),
                p.min_host_version,
                serde_json::to_string(&p.platforms).unwrap_or_else(|_| "[]".into()),
            ],
        )?;
    }
    Ok(())
}

fn source_info_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(SourceInfo, String)> {
    let public_key: String = row.get(3)?;
    let fingerprint = public_key_fingerprint(&public_key).unwrap_or_else(|_| "无效公钥".into());
    Ok((
        SourceInfo {
            id: row.get(0)?,
            name: row.get(1)?,
            url: row.get(2)?,
            fingerprint,
            public_key,
            enabled: row.get::<_, i64>(4)? != 0,
            last_refreshed_at: row.get(5)?,
            package_count: row.get(6)?,
        },
        String::new(),
    ))
}

fn get_source_info(state: &AppState, source_id: &str) -> Result<SourceInfo, CmdError> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let info = db.conn.query_row(
        "SELECT s.id, s.name, s.url, s.public_key, s.enabled, s.last_refreshed_at,
                (SELECT COUNT(*) FROM source_packages sp WHERE sp.source_id = s.id)
         FROM tool_sources s WHERE s.id = ?1",
        [source_id],
        |r| source_info_row(r).map(|(i, _)| i),
    )?;
    Ok(info)
}

/// 添加源：拉取索引 → 验签 →（可选）比对用户提供的公钥 → 入库。
#[tauri::command]
pub async fn source_add(
    state: State<'_, AppState>,
    url: String,
    public_key: Option<String>,
) -> CmdResult<SourceInfo> {
    let dev = developer_mode_enabled(&state);
    check_url_policy(&url, dev)?;

    let bytes = fetch_bytes(&url, MAX_INDEX_SIZE, dev).await?;
    let index = SourceIndex::parse_and_verify(&bytes)
        .map_err(|e| CmdError::from(format!("源索引验证失败: {e}")))?;

    // 用户提供了期望公钥时必须一致（防中间人替换索引+公钥）
    if let Some(expected) = public_key {
        let expected = expected.trim();
        if !expected.is_empty() && !expected.eq_ignore_ascii_case(&index.public_key) {
            return Err(CmdError::from(
                "索引中的公钥与你提供的公钥不一致，已拒绝添加",
            ));
        }
    }

    // 已存在同 ID 源时拒绝重复添加（应走刷新）
    {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        let exists: bool = db
            .conn
            .query_row(
                "SELECT 1 FROM tool_sources WHERE id = ?1",
                [&index.source_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if exists {
            return Err(CmdError::from(format!(
                "源 {} 已存在，请使用刷新",
                index.source_id
            )));
        }
    }

    persist_index(&state, &url, &index)?;
    get_source_info(&state, &index.source_id)
}

/// 刷新源：公钥已钉住，索引换钥即拒绝。
#[tauri::command]
pub async fn source_refresh(
    state: State<'_, AppState>,
    source_id: String,
) -> CmdResult<SourceInfo> {
    let (url, pinned_key) = {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        db.conn.query_row(
            "SELECT url, public_key FROM tool_sources WHERE id = ?1",
            [&source_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )?
    };
    let dev = developer_mode_enabled(&state);
    check_url_policy(&url, dev)?;

    let bytes = fetch_bytes(&url, MAX_INDEX_SIZE, dev).await?;
    let index = SourceIndex::parse_and_verify(&bytes)
        .map_err(|e| CmdError::from(format!("源索引验证失败: {e}")))?;
    if !index.public_key.eq_ignore_ascii_case(&pinned_key) {
        return Err(CmdError::from("源公钥发生变化，已拒绝刷新（可能被替换）"));
    }
    if index.source_id != source_id {
        return Err(CmdError::from("索引中的源 ID 与已添加的源不一致"));
    }

    persist_index(&state, &url, &index)?;
    get_source_info(&state, &source_id)
}

#[tauri::command]
pub fn source_list(state: State<AppState>) -> CmdResult<Vec<SourceInfo>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let mut stmt = db.conn.prepare(
        "SELECT s.id, s.name, s.url, s.public_key, s.enabled, s.last_refreshed_at,
                (SELECT COUNT(*) FROM source_packages sp WHERE sp.source_id = s.id)
         FROM tool_sources s ORDER BY s.id",
    )?;
    let rows = stmt.query_map([], |r| source_info_row(r).map(|(i, _)| i))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn source_set_enabled(
    state: State<AppState>,
    source_id: String,
    enabled: bool,
) -> CmdResult<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let n = db.conn.execute(
        "UPDATE tool_sources SET enabled = ?2 WHERE id = ?1",
        rusqlite::params![source_id, enabled as i64],
    )?;
    if n == 0 {
        return Err(CmdError::from("源不存在"));
    }
    Ok(())
}

#[tauri::command]
pub fn source_remove(state: State<AppState>, source_id: String) -> CmdResult<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn
        .execute("DELETE FROM tool_sources WHERE id = ?1", [&source_id])?;
    Ok(())
}

/// 公钥指纹（供 UI 单独查询）。
#[tauri::command]
pub fn source_fingerprint(public_key: String) -> CmdResult<String> {
    public_key_fingerprint(&public_key).map_err(|e| CmdError::from(e.to_string()))
}

/// 商店目录：启用源的全部包 + 安装状态（版本比较用 semver）。
#[tauri::command]
pub fn shop_catalog(state: State<AppState>) -> CmdResult<Vec<ShopPackage>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let mut stmt = db.conn.prepare(
        "SELECT sp.source_id, sp.package_id, sp.version, sp.size, sp.changelog, sp.category,
                sp.permissions_json, sp.min_host_version,
                t.current_version, COALESCE(t.pinned, 0)
         FROM source_packages sp
         JOIN tool_sources s ON s.id = sp.source_id AND s.enabled = 1
         LEFT JOIN tools t ON t.id = sp.package_id
         ORDER BY sp.package_id, sp.version DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let permissions_json: String = r.get(6)?;
        let version: String = r.get(2)?;
        let installed_version: Option<String> = r.get(8)?;
        let (update_available, downgrade) = match &installed_version {
            Some(inst) => {
                match (
                    semver::Version::parse(&version),
                    semver::Version::parse(inst),
                ) {
                    (Ok(cand), Ok(cur)) => (cand > cur, cand < cur),
                    _ => (false, false),
                }
            }
            None => (false, false),
        };
        Ok(ShopPackage {
            source_id: r.get(0)?,
            id: r.get(1)?,
            version,
            size: r.get::<_, i64>(3)? as u64,
            changelog: r.get(4)?,
            category: r.get(5)?,
            permissions: serde_json::from_str(&permissions_json).unwrap_or_default(),
            min_host_version: r.get(7)?,
            installed_version,
            update_available,
            downgrade,
            pinned: r.get::<_, i64>(9)? != 0,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 权限差异：请求权限相对已授予权限的“新增”部分（更新前必须重新确认）。
#[tauri::command]
pub fn permission_diff(
    state: State<AppState>,
    tool_id: String,
    requested: Vec<String>,
) -> CmdResult<Vec<String>> {
    let granted = {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        let mut stmt = db
            .conn
            .prepare("SELECT permission FROM granted_permissions WHERE tool_id = ?1")?;
        let rows = stmt.query_map([&tool_id], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect::<Vec<String>>()
    };
    Ok(useful_plugin::permissions::added_permissions(
        &granted, &requested,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_round_trip_preserves_native_absolute_path() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("source index.json");
        let url = reqwest::Url::from_file_path(&file).unwrap();
        assert_eq!(file_url_path(url.as_str()).unwrap(), Some(file));
        assert_eq!(
            file_url_path("https://example.test/index.json").unwrap(),
            None
        );
    }

    #[test]
    fn file_url_rejects_non_absolute_or_unrepresentable_paths() {
        assert!(file_url_path("file://").is_err());
    }
}
