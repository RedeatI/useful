//! TRP 端到端集成测试：以 CLI 生成的 repositories/static-example 为源（file:// 本地源），
//! 走真实命令内核：同步 → TUF 验证 → 下载校验 → 安装 → 来源记录。
//! 覆盖 Phase 6C 验收：客户端可安装示例工具；metadata/制品被篡改后客户端拒绝安装。

use sha2::Digest;
use std::path::{Path, PathBuf};
use useful_app_lib::commands::trp_sources::{install_from_trp_source, sync_one};
use useful_app_lib::state::AppState;
use useful_core::db::Database;
use useful_core::paths::AppPaths;
use useful_core::registry::{builtin_tools, ToolRegistry};

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            std::fs::copy(entry.path(), &to).unwrap();
        }
    }
}

fn file_url(p: &Path) -> String {
    reqwest::Url::from_file_path(p)
        .expect("file URL path must be absolute")
        .to_string()
}

#[test]
fn file_url_preserves_platform_absolute_paths_and_encodes_segments() {
    #[cfg(windows)]
    let path = PathBuf::from(r"C:\Useful URL\源#索引.json");
    #[cfg(unix)]
    let path = PathBuf::from("/Useful URL/源#索引.json");

    let encoded = file_url(&path);
    let parsed = reqwest::Url::parse(&encoded).unwrap();

    assert!(path.is_absolute());
    assert!(encoded.contains("Useful%20URL"));
    assert!(encoded.contains("%23"));
    assert!(encoded.contains("%E6%BA%90%23%E7%B4%A2%E5%BC%95.json"));
    assert_eq!(parsed.fragment(), None);
    assert_eq!(parsed.to_file_path().unwrap(), path);
    #[cfg(windows)]
    assert!(encoded.starts_with("file:///C:/"));
    #[cfg(unix)]
    assert!(encoded.starts_with("file:///Useful%20URL/"));
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(bytes))
}

/// 准备：复制 static-example 到临时目录并把 discovery 的 URL 改写为 file://。
fn setup_source(tmp: &Path) -> (PathBuf, String) {
    let repo_example =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../repositories/static-example");
    let src_dir = tmp.join("source");
    copy_dir(&repo_example, &src_dir);

    let disc_path = src_dir.join(".well-known/useful-repository.json");
    let mut disc: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&disc_path).unwrap()).unwrap();
    disc["repository"]["metadataBaseUrl"] =
        serde_json::json!(format!("{}/", file_url(&src_dir.join("metadata"))));
    disc["repository"]["targetsBaseUrl"] =
        serde_json::json!(format!("{}/", file_url(&src_dir.join("targets"))));
    disc["repository"]["rootUrl"] =
        serde_json::json!(file_url(&src_dir.join("metadata/1.root.json")));
    std::fs::write(&disc_path, serde_json::to_vec_pretty(&disc).unwrap()).unwrap();

    let discovery_url = file_url(&disc_path);
    (src_dir, discovery_url)
}

/// 准备：临时便携 AppState + 已确认信任根的 trp_sources 行。
fn setup_state(tmp: &Path, src_dir: &Path, discovery_url: &str) -> AppState {
    let exe_dir = tmp.join("app");
    std::fs::create_dir_all(&exe_dir).unwrap();
    std::fs::write(exe_dir.join("Useful.exe"), b"stub").unwrap();
    std::fs::write(exe_dir.join("portable.flag"), b"").unwrap();
    let paths = AppPaths::detect(&exe_dir.join("Useful.exe"), None).unwrap();
    paths.ensure_dirs().unwrap();
    let db = Database::open(&paths.db_path).unwrap();

    // 模拟“用户确认根指纹后添加源”：钉住 1.root.json 的摘要
    let root_fp = sha256_hex(&std::fs::read(src_dir.join("metadata/1.root.json")).unwrap());
    db.conn
        .execute(
            "INSERT INTO trp_sources
             (id, kind, discovery_url, display_name, operator, local, enabled, priority,
              profile, root_key_fingerprint, trust_confirmed_at, capabilities_json)
             VALUES ('com.example.static', 'tool', ?1, '静态示例源', 'Example Community',
                     1, 1, 100, 'tuf-v1', ?2, unixepoch(), '{}')",
            rusqlite::params![discovery_url, root_fp],
        )
        .unwrap();

    let mut registry = ToolRegistry::new();
    for t in builtin_tools() {
        registry.register(t).unwrap();
    }
    AppState::new(paths, db, registry)
}

const PUBLISHER_QUERY: &str =
    "SELECT publisher_key_id FROM trp_catalog_cache WHERE tool_id = 'com.useful.hello-web'";

#[tokio::test]
async fn full_trp_flow_install_and_tamper_rejection() {
    let tmp = tempfile::tempdir().unwrap();
    let (src_dir, discovery_url) = setup_source(tmp.path());
    let state = setup_state(tmp.path(), &src_dir, &discovery_url);

    // 1) 同步：目录进入本地缓存
    let sync = sync_one(&state, "com.example.static").await;
    assert!(sync.ok, "同步失败: {:?}", sync.message);
    assert_eq!(sync.entry_count, 1);
    let publisher: String = {
        let db = state.db.lock().unwrap();
        db.conn
            .query_row(PUBLISHER_QUERY, [], |r| r.get(0))
            .unwrap()
    };

    // 2) metadata 被篡改 → 拒绝安装（未重签的 timestamp 改动被签名验证拦截）
    let ts_path = src_dir.join("metadata/timestamp.json");
    let ts_orig = std::fs::read(&ts_path).unwrap();
    let mut ts: serde_json::Value = serde_json::from_slice(&ts_orig).unwrap();
    ts["signed"]["expires"] = serde_json::json!("2099-01-01T00:00:00Z");
    std::fs::write(&ts_path, serde_json::to_vec(&ts).unwrap()).unwrap();
    let err = install_from_trp_source(
        &state,
        "com.example.static",
        &publisher,
        "com.useful.hello-web",
        true,
    )
    .await
    .unwrap_err();
    assert!(
        err.message.contains("TUF 验证失败"),
        "意外错误: {}",
        err.message
    );
    std::fs::write(&ts_path, &ts_orig).unwrap();

    // 3) 制品被篡改（同长度换字节）→ 拒绝安装
    let target_name = std::fs::read_dir(src_dir.join("targets"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name();
    let target_path = src_dir.join("targets").join(&target_name);
    let orig = std::fs::read(&target_path).unwrap();
    let mut evil = orig.clone();
    evil[100] ^= 0xff;
    std::fs::write(&target_path, &evil).unwrap();
    let err = install_from_trp_source(
        &state,
        "com.example.static",
        &publisher,
        "com.useful.hello-web",
        true,
    )
    .await
    .unwrap_err();
    assert!(
        err.message.contains("制品校验失败"),
        "意外错误: {}",
        err.message
    );
    std::fs::write(&target_path, &orig).unwrap();

    // 4) 零 native 权限的首次安装无需确认即可成功
    let tool = install_from_trp_source(
        &state,
        "com.example.static",
        &publisher,
        "com.useful.hello-web",
        false,
    )
    .await
    .unwrap();

    // 5) 正常安装：注册表可见 + InstalledOrigin 记录（来源固定依据）
    assert_eq!(tool.id, "com.useful.hello-web");
    {
        let reg = state.registry.lock().unwrap();
        assert!(reg.get("com.useful.hello-web").is_some());
    }
    {
        let db = state.db.lock().unwrap();
        let (src_id, pk): (String, String) = db
            .conn
            .query_row(
                "SELECT source_id, publisher_key_id FROM installed_origins WHERE tool_id = ?1",
                ["com.useful.hello-web"],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(src_id, "com.example.static");
        assert_eq!(pk, publisher);
    }

    // 6) 同版本重复安装 → 被来源/发布者固定策略拒绝（NotAnUpgrade）
    let err = install_from_trp_source(
        &state,
        "com.example.static",
        &publisher,
        "com.useful.hello-web",
        true,
    )
    .await
    .unwrap_err();
    assert!(
        err.message.contains("固定策略拒绝"),
        "意外错误: {}",
        err.message
    );
}
