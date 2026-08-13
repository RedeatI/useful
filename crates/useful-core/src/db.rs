//! SQLite 数据库：连接管理、迁移系统、损坏恢复。

use crate::error::CoreError;
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// 迁移定义：版本号单调递增，SQL 在单个事务中执行。
struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_schema",
        sql: r#"
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE tools (
    id          TEXT PRIMARY KEY,           -- 如 com.example.image-converter 或 builtin.video-trim
    kind        TEXT NOT NULL,              -- builtin | web | launcher | worker
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_path   TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    installed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    current_version TEXT
);

CREATE TABLE tool_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id     TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    version     TEXT NOT NULL,
    install_dir TEXT,
    manifest_json TEXT NOT NULL,
    sha256      TEXT,
    installed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(tool_id, version)
);

CREATE TABLE tool_sources (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    public_key  TEXT NOT NULL,              -- Ed25519 hex
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_refreshed_at INTEGER,
    cached_index_json TEXT
);

CREATE TABLE source_packages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   TEXT NOT NULL REFERENCES tool_sources(id) ON DELETE CASCADE,
    package_id  TEXT NOT NULL,
    version     TEXT NOT NULL,
    package_url TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    size        INTEGER NOT NULL,
    changelog   TEXT NOT NULL DEFAULT '',
    permissions_json TEXT NOT NULL DEFAULT '[]',
    min_host_version TEXT NOT NULL DEFAULT '0.1.0',
    platforms_json TEXT NOT NULL DEFAULT '["windows-x64"]',
    UNIQUE(source_id, package_id, version)
);

CREATE TABLE granted_permissions (
    tool_id     TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    permission  TEXT NOT NULL,
    granted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (tool_id, permission)
);

CREATE TABLE shortcuts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id     TEXT NOT NULL,
    lnk_path    TEXT NOT NULL UNIQUE,
    icon_path   TEXT,
    target_exe  TEXT NOT NULL,
    args        TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE downloads (
    id          TEXT PRIMARY KEY,           -- uuid
    url         TEXT NOT NULL,
    dest_path   TEXT NOT NULL,
    total_bytes INTEGER,
    received_bytes INTEGER NOT NULL DEFAULT 0,
    sha256_expected TEXT,
    status      TEXT NOT NULL DEFAULT 'pending', -- pending|downloading|verifying|installing|done|failed|cancelled
    error       TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE recent_tools (
    tool_id     TEXT PRIMARY KEY,
    last_used_at INTEGER NOT NULL,
    use_count   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE favorites (
    tool_id     TEXT PRIMARY KEY,
    added_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cache_entries (
    key         TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,              -- thumbnail | probe | icon | source-index
    file_path   TEXT,
    meta_json   TEXT,
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_access INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_cache_last_access ON cache_entries(last_access);
CREATE INDEX idx_source_packages_pkg ON source_packages(package_id);
"#,
    },
    Migration {
        version: 2,
        name: "tool_pin_and_package_category",
        sql: r#"
ALTER TABLE tools ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_packages ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE downloads ADD COLUMN package_id TEXT;
ALTER TABLE downloads ADD COLUMN version TEXT;
"#,
    },
    Migration {
        version: 3,
        name: "trp_multi_source",
        sql: r#"
-- Phase 6B：TRP v1 多源数据模型。与第一轮 tool_sources（Ed25519 索引源）并存，
-- TRP 源以 discovery + 信任根指纹为身份，官方性仅由预置根指纹匹配决定（不入库）。
CREATE TABLE trp_sources (
    id            TEXT PRIMARY KEY,           -- discovery 自报 sourceId（仅作本地键，不构成官方身份）
    kind          TEXT NOT NULL DEFAULT 'tool', -- tool | mirror（无 app-update：客户端更新源是独立信任域）
    discovery_url TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    operator      TEXT NOT NULL DEFAULT '',
    local         INTEGER NOT NULL DEFAULT 0, -- localhost/file 本地或开发源标记
    enabled       INTEGER NOT NULL DEFAULT 1,
    priority      INTEGER NOT NULL DEFAULT 100, -- 数值越小优先级越高
    profile       TEXT NOT NULL DEFAULT 'tuf-v1',
    root_key_fingerprint TEXT NOT NULL,       -- 用户确认后钉住的信任根指纹
    trust_confirmed_at   INTEGER NOT NULL,
    capabilities_json    TEXT NOT NULL DEFAULT '{}',
    last_sync_at         INTEGER,
    last_sync_status     TEXT NOT NULL DEFAULT 'never', -- never | ok | failed
    last_sync_error      TEXT,
    last_sync_duration_ms INTEGER
);

-- 每源目录缓存；主键含 publisher_key_id：同名不同发布者不合并。
CREATE TABLE trp_catalog_cache (
    source_id        TEXT NOT NULL REFERENCES trp_sources(id) ON DELETE CASCADE,
    publisher_key_id TEXT NOT NULL,
    tool_id          TEXT NOT NULL,
    name             TEXT NOT NULL,
    summary          TEXT NOT NULL DEFAULT '',
    license          TEXT NOT NULL DEFAULT '',
    latest_stable    TEXT,
    latest_stable_digest TEXT,
    access_mode      TEXT NOT NULL DEFAULT 'free',
    is_native_worker INTEGER NOT NULL DEFAULT 0,
    entry_json       TEXT NOT NULL,           -- 完整目录条目（详情页/更新评估用）
    updated_at       TEXT,
    PRIMARY KEY (source_id, publisher_key_id, tool_id)
);
CREATE INDEX idx_trp_catalog_tool ON trp_catalog_cache(tool_id);
CREATE INDEX idx_trp_catalog_name ON trp_catalog_cache(name);

-- InstalledOrigin = SourceId + PublisherKeyId + ToolId：来源固定与发布者固定的依据。
CREATE TABLE installed_origins (
    tool_id          TEXT PRIMARY KEY,
    source_id        TEXT NOT NULL,
    publisher_key_id TEXT NOT NULL,
    installed_version TEXT NOT NULL,
    artifact_sha256  TEXT NOT NULL,
    channel          TEXT NOT NULL DEFAULT 'stable',
    manifest_digest  TEXT NOT NULL,
    installed_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    last_checked_at  INTEGER
);
"#,
    },
    Migration {
        version: 4,
        name: "source_accounts",
        sql: r#"
-- Phase 8：每源独立 SourceAccount。仅存元信息与凭据引用；
-- Access/Refresh Token 绝不明文入 SQLite（由 DPAPI/凭据管理器保管，见 dpapi_store）。
CREATE TABLE source_accounts (
    source_id            TEXT PRIMARY KEY,   -- 每源一个账户；跨源隔离
    account_id           TEXT NOT NULL,
    display_name         TEXT NOT NULL DEFAULT '',
    credential_reference TEXT NOT NULL,      -- 指向凭据存储的引用，非令牌本体
    scopes_json          TEXT NOT NULL DEFAULT '[]',
    expires_at           INTEGER NOT NULL DEFAULT 0,
    last_authenticated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
"#,
    },
    Migration {
        version: 5,
        name: "action_level_state",
        sql: r#"
-- Phase 12：action 级收藏与最近使用。以稳定 action ID 为键。
-- 与顶级 favorites/recent_tools 并存，不相互干扰。
CREATE TABLE action_favorites (
    action_id   TEXT PRIMARY KEY,
    added_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE action_recent (
    action_id     TEXT PRIMARY KEY,
    last_used_at  INTEGER NOT NULL,
    use_count     INTEGER NOT NULL DEFAULT 1
);
"#,
    },
    Migration {
        version: 6,
        name: "agent_profiles_and_navigation_pins",
        sql: r#"
-- AI-5：Agent profile 是独立、版本化的本地配置，不是插件 manifest，
-- 也不改变 artifact/publisher 信任链。仅保存通过 IPC 二次边界校验的 canonical JSON。
CREATE TABLE agent_profiles (
    profile_id   TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE agent_profile_state (
    singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_profile_id TEXT REFERENCES agent_profiles(profile_id) ON DELETE SET NULL
);
INSERT INTO agent_profile_state (singleton, active_profile_id) VALUES (1, NULL);

-- 快捷访问 pin 与 favorites/recent/action_favorites/action_recent 保持独立，迁移不丢旧状态。
CREATE TABLE navigation_pins (
    item_id    TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    pinned_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
"#,
    },
    Migration {
        version: 7,
        name: "trp_tuf_rollback_state",
        sql: r#"
-- Persist the last fully verified top-level TUF versions per source. Catalog
-- refresh is intentionally not allowed to write these columns.
ALTER TABLE trp_sources ADD COLUMN last_tuf_root_version INTEGER NOT NULL DEFAULT 0 CHECK (last_tuf_root_version >= 0);
ALTER TABLE trp_sources ADD COLUMN last_tuf_timestamp_version INTEGER NOT NULL DEFAULT 0 CHECK (last_tuf_timestamp_version >= 0);
ALTER TABLE trp_sources ADD COLUMN last_tuf_snapshot_version INTEGER NOT NULL DEFAULT 0 CHECK (last_tuf_snapshot_version >= 0);
ALTER TABLE trp_sources ADD COLUMN last_tuf_targets_version INTEGER NOT NULL DEFAULT 0 CHECK (last_tuf_targets_version >= 0);
ALTER TABLE trp_sources ADD COLUMN last_tuf_root_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE trp_sources ADD COLUMN last_tuf_timestamp_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE trp_sources ADD COLUMN last_tuf_snapshot_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE trp_sources ADD COLUMN last_tuf_targets_sha256 TEXT NOT NULL DEFAULT '';
"#,
    },
    Migration {
        version: 8,
        name: "download_error_codes",
        sql: r#"
-- Stable machine-readable failure code for Source Center download records.
-- Human-readable error text remains separate and may be localized later.
ALTER TABLE downloads ADD COLUMN error_code TEXT;
"#,
    },
    Migration {
        version: 9,
        name: "trp_source_delivery_type",
        sql: r#"
-- Client-observed transport shape, not a provider trust assertion. Public
-- S3-compatible buckets are static HTTPS from the client's perspective.
ALTER TABLE trp_sources ADD COLUMN delivery_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (delivery_type IN ('unknown', 'static-https', 'dynamic'));
"#,
    },
];

/// 打开数据库并应用迁移。若文件损坏则备份后重建，返回是否发生了重建。
pub struct Database {
    pub conn: Connection,
    pub recovered: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrpTufVersions {
    pub root: u64,
    pub timestamp: u64,
    pub snapshot: u64,
    pub targets: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrpTufState {
    pub versions: TrpTufVersions,
    pub root_sha256: String,
    pub timestamp_sha256: String,
    pub snapshot_sha256: String,
    pub targets_sha256: String,
}

impl Database {
    pub fn open(db_path: &Path) -> Result<Database, CoreError> {
        match Self::try_open(db_path) {
            Ok(conn) => Ok(Database {
                conn,
                recovered: false,
            }),
            Err(e) if is_corruption(&e) => {
                tracing::error!("数据库损坏，开始备份并重建: {e}");
                backup_corrupted(db_path)?;
                let conn = Self::try_open(db_path)?;
                Ok(Database {
                    conn,
                    recovered: true,
                })
            }
            Err(e) => Err(e),
        }
    }

    fn try_open(db_path: &Path) -> Result<Connection, CoreError> {
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // 完整性快速检查——失败视为损坏
        let ok: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if ok != "ok" {
            return Err(CoreError::DbCorrupted(ok));
        }
        migrate(&conn)?;
        Ok(conn)
    }

    /// 尝试以只读方式打开（供“恢复”流程读取旧数据）。
    pub fn open_read_only(db_path: &Path) -> Result<Connection, CoreError> {
        Ok(Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?)
    }

    pub fn schema_version(&self) -> Result<i64, CoreError> {
        current_version(&self.conn)
    }

    pub fn trp_tuf_versions(&self, source_id: &str) -> Result<TrpTufVersions, CoreError> {
        Ok(self.trp_tuf_state(source_id)?.versions)
    }

    pub fn trp_tuf_state(&self, source_id: &str) -> Result<TrpTufState, CoreError> {
        self.conn
            .query_row(
                "SELECT last_tuf_root_version, last_tuf_timestamp_version,
                        last_tuf_snapshot_version, last_tuf_targets_version,
                        last_tuf_root_sha256, last_tuf_timestamp_sha256,
                        last_tuf_snapshot_sha256, last_tuf_targets_sha256
                 FROM trp_sources WHERE id = ?1",
                [source_id],
                |row| {
                    Ok(TrpTufState {
                        versions: TrpTufVersions {
                            root: row.get::<_, i64>(0)? as u64,
                            timestamp: row.get::<_, i64>(1)? as u64,
                            snapshot: row.get::<_, i64>(2)? as u64,
                            targets: row.get::<_, i64>(3)? as u64,
                        },
                        root_sha256: row.get(4)?,
                        timestamp_sha256: row.get(5)?,
                        snapshot_sha256: row.get(6)?,
                        targets_sha256: row.get(7)?,
                    })
                },
            )
            .map_err(CoreError::from)
    }

    /// Atomically compare and advance all four accepted TUF versions. No
    /// column changes when one role is a rollback or a SQL operation fails.
    pub fn accept_trp_tuf_state(
        &self,
        source_id: &str,
        expected_discovery_url: &str,
        expected_root_fingerprint: &str,
        candidate: &TrpTufState,
    ) -> Result<(), CoreError> {
        self.conn.execute_batch("BEGIN IMMEDIATE;")?;
        match self.accept_trp_tuf_state_in_transaction(
            source_id,
            expected_discovery_url,
            expected_root_fingerprint,
            candidate,
        ) {
            Ok(()) => match self.conn.execute_batch("COMMIT;") {
                Ok(()) => Ok(()),
                Err(error) => {
                    let _ = self.conn.execute_batch("ROLLBACK;");
                    Err(CoreError::from(error))
                }
            },
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    /// Compare and advance TUF state inside an already-open SQLite write
    /// transaction. Callers use this to commit trust state together with the
    /// installed tool, permissions and InstalledOrigin record.
    pub fn accept_trp_tuf_state_in_transaction(
        &self,
        source_id: &str,
        expected_discovery_url: &str,
        expected_root_fingerprint: &str,
        candidate: &TrpTufState,
    ) -> Result<(), CoreError> {
        let candidate_versions = candidate.versions;
        let values = [
            candidate_versions.root,
            candidate_versions.timestamp,
            candidate_versions.snapshot,
            candidate_versions.targets,
        ];
        if values.iter().any(|value| *value > i64::MAX as u64) {
            return Err(CoreError::TrustState("TUF 版本超出 SQLite 整数范围".into()));
        }
        for digest in [
            &candidate.root_sha256,
            &candidate.timestamp_sha256,
            &candidate.snapshot_sha256,
            &candidate.targets_sha256,
        ] {
            if digest.len() != 64
                || digest
                    .bytes()
                    .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
            {
                return Err(CoreError::TrustState(
                    "TUF metadata 摘要必须为 canonical lowercase SHA-256".into(),
                ));
            }
        }
        let last = self.trp_tuf_state(source_id)?;
        for (role, old, new, old_digest, new_digest) in [
            (
                "root",
                last.versions.root,
                candidate_versions.root,
                &last.root_sha256,
                &candidate.root_sha256,
            ),
            (
                "timestamp",
                last.versions.timestamp,
                candidate_versions.timestamp,
                &last.timestamp_sha256,
                &candidate.timestamp_sha256,
            ),
            (
                "snapshot",
                last.versions.snapshot,
                candidate_versions.snapshot,
                &last.snapshot_sha256,
                &candidate.snapshot_sha256,
            ),
            (
                "targets",
                last.versions.targets,
                candidate_versions.targets,
                &last.targets_sha256,
                &candidate.targets_sha256,
            ),
        ] {
            if new < old {
                return Err(CoreError::TrustState(format!(
                    "{role} metadata 从 {old} 回滚到 {new}"
                )));
            }
            if old != 0 && new == old && new_digest != old_digest {
                return Err(CoreError::TrustState(format!(
                    "{role} metadata 同版本摘要发生变化"
                )));
            }
        }
        let changed = self.conn.execute(
            "UPDATE trp_sources SET
                    last_tuf_root_version=?2,
                    last_tuf_timestamp_version=?3,
                    last_tuf_snapshot_version=?4,
                    last_tuf_targets_version=?5,
                    last_tuf_root_sha256=?6,
                    last_tuf_timestamp_sha256=?7,
                    last_tuf_snapshot_sha256=?8,
                    last_tuf_targets_sha256=?9
                 WHERE id=?1
                   AND discovery_url=?10
                   AND root_key_fingerprint=?11
                   AND enabled=1
                   AND last_tuf_root_version<=?2
                   AND last_tuf_timestamp_version<=?3
                   AND last_tuf_snapshot_version<=?4
                   AND last_tuf_targets_version<=?5",
            rusqlite::params![
                source_id,
                candidate_versions.root as i64,
                candidate_versions.timestamp as i64,
                candidate_versions.snapshot as i64,
                candidate_versions.targets as i64,
                candidate.root_sha256,
                candidate.timestamp_sha256,
                candidate.snapshot_sha256,
                candidate.targets_sha256,
                expected_discovery_url,
                expected_root_fingerprint,
            ],
        )?;
        if changed != 1 {
            return Err(CoreError::TrustState(
                "源不存在、身份已变化或并发验证已接受更高版本".into(),
            ));
        }
        Ok(())
    }
}

fn is_corruption(e: &CoreError) -> bool {
    match e {
        CoreError::DbCorrupted(_) => true,
        CoreError::Db(rusqlite::Error::SqliteFailure(err, _)) => matches!(
            err.code,
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
        ),
        _ => false,
    }
}

/// 损坏数据库不覆盖原文件：带时间戳重命名备份。
fn backup_corrupted(db_path: &Path) -> Result<(), CoreError> {
    if db_path.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = db_path.with_extension(format!("corrupted.{ts}.bak"));
        std::fs::rename(db_path, &backup)?;
        // WAL / SHM 一并移开
        for ext in ["db-wal", "db-shm"] {
            let side = db_path.with_extension(ext);
            if side.exists() {
                let _ = std::fs::rename(&side, backup.with_extension(format!("{ext}.bak")));
            }
        }
        tracing::warn!("已备份损坏数据库到 {}", backup.display());
    }
    Ok(())
}

fn current_version(conn: &Connection) -> Result<i64, CoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        );",
    )?;
    let v: Option<i64> = conn.query_row("SELECT MAX(version) FROM migrations", [], |r| r.get(0))?;
    Ok(v.unwrap_or(0))
}

fn migrate(conn: &Connection) -> Result<(), CoreError> {
    let mut version = current_version(conn)?;
    for m in MIGRATIONS {
        if m.version <= version {
            continue;
        }
        conn.execute_batch("BEGIN;")?;
        let apply = || -> Result<(), CoreError> {
            conn.execute_batch(m.sql)?;
            conn.execute(
                "INSERT INTO migrations (version, name) VALUES (?1, ?2)",
                rusqlite::params![m.version, m.name],
            )?;
            Ok(())
        };
        match apply() {
            Ok(()) => {
                conn.execute_batch("COMMIT;")?;
                version = m.version;
                tracing::info!("迁移已应用: v{} {}", m.version, m.name);
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(CoreError::Migration(format!(
                    "迁移 v{} {} 失败: {e}",
                    m.version, m.name
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tuf_state(versions: TrpTufVersions, digest_seed: u64) -> TrpTufState {
        let digest = format!("{digest_seed:064x}");
        TrpTufState {
            versions,
            root_sha256: digest.clone(),
            timestamp_sha256: digest.clone(),
            snapshot_sha256: digest.clone(),
            targets_sha256: digest,
        }
    }

    #[test]
    fn migrations_apply_and_are_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("useful.db");
        let db = Database::open(&db_path).unwrap();
        assert!(!db.recovered);
        assert_eq!(db.schema_version().unwrap(), 9);
        drop(db);
        // 再次打开不报错、版本不变
        let db = Database::open(&db_path).unwrap();
        assert_eq!(db.schema_version().unwrap(), 9);
        // 所有要求的表都存在
        for table in [
            "settings",
            "tools",
            "tool_versions",
            "tool_sources",
            "source_packages",
            "granted_permissions",
            "shortcuts",
            "downloads",
            "recent_tools",
            "favorites",
            "cache_entries",
            "migrations",
            "trp_sources",
            "trp_catalog_cache",
            "installed_origins",
            "source_accounts",
            "action_favorites",
            "action_recent",
            "agent_profiles",
            "agent_profile_state",
            "navigation_pins",
        ] {
            let n: i64 = db
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "缺少表 {table}");
        }
        let error_code_columns: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('downloads') WHERE name='error_code'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            error_code_columns, 1,
            "downloads.error_code migration missing"
        );
        let delivery_type_columns: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('trp_sources') WHERE name='delivery_type'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            delivery_type_columns, 1,
            "trp_sources.delivery_type migration missing"
        );
    }

    #[test]
    fn corrupted_db_is_backed_up_not_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("useful.db");
        std::fs::write(&db_path, b"this is not a sqlite database at all!!").unwrap();
        let db = Database::open(&db_path).unwrap();
        assert!(db.recovered);
        // 原始损坏文件被保留为备份
        let backups: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("corrupted"))
            .collect();
        assert_eq!(backups.len(), 1);
    }

    #[test]
    fn v5_database_migrates_to_latest_without_losing_existing_action_state() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("useful.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            INSERT INTO migrations (version, name) VALUES
                (1, 'initial_schema'), (2, 'tool_pin_and_package_category'),
                (3, 'trp_multi_source'), (4, 'source_accounts'), (5, 'action_level_state');
            CREATE TABLE action_favorites (
                action_id TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL DEFAULT (unixepoch()),
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE action_recent (
                action_id TEXT PRIMARY KEY,
                last_used_at INTEGER NOT NULL,
                use_count INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE trp_sources (id TEXT PRIMARY KEY);
            CREATE TABLE downloads (id TEXT PRIMARY KEY);
            INSERT INTO action_favorites (action_id) VALUES ('builtin.utilities.base64');
            INSERT INTO action_recent (action_id, last_used_at) VALUES ('builtin.utilities.json', 1);
            "#,
        )
        .unwrap();
        drop(conn);

        let db = Database::open(&db_path).unwrap();
        assert_eq!(db.schema_version().unwrap(), 9);
        let favorite: String = db
            .conn
            .query_row("SELECT action_id FROM action_favorites", [], |row| {
                row.get(0)
            })
            .unwrap();
        let recent: String = db
            .conn
            .query_row("SELECT action_id FROM action_recent", [], |row| row.get(0))
            .unwrap();
        assert_eq!(favorite, "builtin.utilities.base64");
        assert_eq!(recent, "builtin.utilities.json");
    }

    #[test]
    fn v7_adds_zeroed_per_source_tuf_rollback_state_idempotently() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("useful.db");
        let db = Database::open(&db_path).unwrap();
        db.conn
            .execute(
                "INSERT INTO trp_sources
                 (id, discovery_url, display_name, root_key_fingerprint, trust_confirmed_at)
                 VALUES ('source.test', 'https://example.test/discovery', 'Test', 'aa', 1)",
                [],
            )
            .unwrap();
        let versions: (i64, i64, i64, i64) = db
            .conn
            .query_row(
                "SELECT last_tuf_root_version, last_tuf_timestamp_version,
                        last_tuf_snapshot_version, last_tuf_targets_version
                 FROM trp_sources WHERE id = 'source.test'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(versions, (0, 0, 0, 0));
        let digests: (String, String, String, String) = db
            .conn
            .query_row(
                "SELECT last_tuf_root_sha256, last_tuf_timestamp_sha256,
                        last_tuf_snapshot_sha256, last_tuf_targets_sha256
                 FROM trp_sources WHERE id = 'source.test'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            digests,
            (String::new(), String::new(), String::new(), String::new())
        );
        drop(db);
        assert_eq!(
            Database::open(&db_path).unwrap().schema_version().unwrap(),
            9
        );
    }

    #[test]
    fn tuf_replay_failure_does_not_partially_advance_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(&tmp.path().join("useful.db")).unwrap();
        db.conn
            .execute(
                "INSERT INTO trp_sources
             (id, discovery_url, display_name, root_key_fingerprint, trust_confirmed_at)
             VALUES ('source.test', 'https://example.test/discovery', 'Test', 'aa', 1)",
                [],
            )
            .unwrap();
        let accepted_versions = TrpTufVersions {
            root: 3,
            timestamp: 8,
            snapshot: 7,
            targets: 6,
        };
        let accepted = tuf_state(accepted_versions, 1);
        db.accept_trp_tuf_state(
            "source.test",
            "https://example.test/discovery",
            "aa",
            &accepted,
        )
        .unwrap();
        let replay_versions = TrpTufVersions {
            timestamp: 7,
            targets: 99,
            ..accepted_versions
        };
        assert!(db
            .accept_trp_tuf_state(
                "source.test",
                "https://example.test/discovery",
                "aa",
                &tuf_state(replay_versions, 2)
            )
            .is_err());
        assert_eq!(db.trp_tuf_state("source.test").unwrap(), accepted);
        assert!(
            db.accept_trp_tuf_state(
                "source.test",
                "https://example.test/discovery",
                "aa",
                &tuf_state(accepted_versions, 9)
            )
            .is_err(),
            "same version with a different digest must be rejected"
        );
    }

    #[test]
    fn concurrent_tuf_acceptance_finishes_at_componentwise_newest_state() {
        use std::sync::{Arc, Barrier};

        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("useful.db");
        let db = Database::open(&db_path).unwrap();
        db.conn
            .execute(
                "INSERT INTO trp_sources
             (id, discovery_url, display_name, root_key_fingerprint, trust_confirmed_at)
             VALUES ('source.test', 'https://example.test/discovery', 'Test', 'aa', 1)",
                [],
            )
            .unwrap();
        drop(db);
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for version in [2, 3] {
            let path = db_path.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                let db = Database::open(&path).unwrap();
                db.conn
                    .busy_timeout(std::time::Duration::from_secs(2))
                    .unwrap();
                barrier.wait();
                db.accept_trp_tuf_state(
                    "source.test",
                    "https://example.test/discovery",
                    "aa",
                    &tuf_state(
                        TrpTufVersions {
                            root: version,
                            timestamp: version,
                            snapshot: version,
                            targets: version,
                        },
                        version,
                    ),
                )
            }));
        }
        for handle in handles {
            let _ = handle.join().unwrap();
        }
        assert_eq!(
            Database::open(&db_path)
                .unwrap()
                .trp_tuf_versions("source.test")
                .unwrap(),
            TrpTufVersions {
                root: 3,
                timestamp: 3,
                snapshot: 3,
                targets: 3
            }
        );

        let db = Database::open(&db_path).unwrap();
        db.conn
            .execute(
                "UPDATE trp_sources SET enabled=0 WHERE id='source.test'",
                [],
            )
            .unwrap();
        assert!(db
            .accept_trp_tuf_state(
                "source.test",
                "https://example.test/discovery",
                "aa",
                &tuf_state(
                    TrpTufVersions {
                        root: 4,
                        timestamp: 4,
                        snapshot: 4,
                        targets: 4
                    },
                    4
                )
            )
            .is_err());
    }

    #[test]
    fn tuf_state_participates_in_callers_transaction_and_identity_cas() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(&tmp.path().join("useful.db")).unwrap();
        db.conn
            .execute(
                "INSERT INTO trp_sources
                 (id, discovery_url, display_name, root_key_fingerprint, trust_confirmed_at)
                 VALUES ('source.test', 'https://example.test/discovery', 'Test', 'aa', 1)",
                [],
            )
            .unwrap();
        let candidate = tuf_state(
            TrpTufVersions {
                root: 2,
                timestamp: 2,
                snapshot: 2,
                targets: 2,
            },
            2,
        );

        db.conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
        db.accept_trp_tuf_state_in_transaction(
            "source.test",
            "https://example.test/discovery",
            "aa",
            &candidate,
        )
        .unwrap();
        db.conn.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(
            db.trp_tuf_versions("source.test").unwrap(),
            TrpTufVersions {
                root: 0,
                timestamp: 0,
                snapshot: 0,
                targets: 0,
            }
        );
        assert!(db
            .accept_trp_tuf_state(
                "source.test",
                "https://other.example/discovery",
                "aa",
                &candidate,
            )
            .is_err());
        assert_eq!(db.trp_tuf_versions("source.test").unwrap().root, 0);
    }
}
