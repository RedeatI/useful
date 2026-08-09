use serde::Deserialize;
use sha2::Digest;
use std::path::{Path, PathBuf};
use useful_app_lib::commands::trp_sources::{
    install_from_trp_source, rollback_from_trp_source, sync_one,
};
use useful_app_lib::state::AppState;
use useful_core::db::Database;
use useful_core::paths::AppPaths;
use useful_core::registry::{builtin_tools, ToolRegistry};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    source_id: String,
    publisher_key_id: String,
    source_v1: PathBuf,
    source_v2: PathBuf,
    live_source: PathBuf,
    packages: Vec<PluginFixture>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFixture {
    id: String,
    added_permission: Option<String>,
    #[serde(default)]
    initial_permissions: bool,
}

fn copy_dir(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn file_url(path: &Path) -> String {
    reqwest::Url::from_file_path(path)
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

fn setup_state(temp: &Path, fixture: &Fixture) -> AppState {
    let executable_dir = temp.join("portable app");
    std::fs::create_dir_all(&executable_dir).unwrap();
    std::fs::write(executable_dir.join("Useful.exe"), b"stub").unwrap();
    std::fs::write(executable_dir.join("portable.flag"), b"").unwrap();
    let paths = AppPaths::detect(&executable_dir.join("Useful.exe"), None).unwrap();
    paths.ensure_dirs().unwrap();
    let db = Database::open(&paths.db_path).unwrap();
    let discovery = fixture
        .live_source
        .join(".well-known/useful-repository.json");
    let root = fixture.live_source.join("metadata/1.root.json");
    let root_digest = hex::encode(sha2::Sha256::digest(std::fs::read(root).unwrap()));
    db.conn
        .execute(
            "INSERT INTO trp_sources
             (id, kind, discovery_url, display_name, operator, local, enabled, priority,
              profile, root_key_fingerprint, trust_confirmed_at, capabilities_json)
             VALUES (?1, 'tool', ?2, 'Phase 12.1 static', 'Useful Test Publisher',
                     1, 1, 100, 'tuf-v1', ?3, unixepoch(), '{}')",
            rusqlite::params![fixture.source_id, file_url(&discovery), root_digest],
        )
        .unwrap();
    let mut registry = ToolRegistry::new();
    for tool in builtin_tools() {
        registry.register(tool).unwrap();
    }
    AppState::new(paths, db, registry)
}

fn current_version(state: &AppState, tool_id: &str) -> String {
    state
        .db
        .lock()
        .unwrap()
        .conn
        .query_row(
            "SELECT current_version FROM tools WHERE id=?1",
            [tool_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn granted_permissions(state: &AppState, tool_id: &str) -> Vec<String> {
    let db = state.db.lock().unwrap();
    let mut statement = db
        .conn
        .prepare("SELECT permission FROM granted_permissions WHERE tool_id=?1 ORDER BY permission")
        .unwrap();
    statement
        .query_map([tool_id], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[tokio::test]
async fn three_plugins_install_update_permission_and_rollback() {
    let Ok(fixture_path) = std::env::var("USEFUL_PLUGIN_LIFECYCLE_FIXTURE") else {
        eprintln!("USEFUL_PLUGIN_LIFECYCLE_FIXTURE 未设置，权威 test:plugins 会提供该夹具");
        return;
    };
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(fixture_path).unwrap()).unwrap();
    if fixture.live_source.exists() {
        std::fs::remove_dir_all(&fixture.live_source).unwrap();
    }
    copy_dir(&fixture.source_v1, &fixture.live_source);

    let temporary = tempfile::tempdir().unwrap();
    let state = setup_state(temporary.path(), &fixture);
    let first_sync = sync_one(&state, &fixture.source_id).await;
    assert!(first_sync.ok, "v1 同步失败: {:?}", first_sync.message);
    assert_eq!(first_sync.entry_count, fixture.packages.len() as i64);

    for plugin in &fixture.packages {
        let needs_permission = plugin.id == "com.useful.file-hash" || plugin.initial_permissions;
        if needs_permission {
            let error = install_from_trp_source(
                &state,
                &fixture.source_id,
                &fixture.publisher_key_id,
                &plugin.id,
                false,
            )
            .await
            .unwrap_err();
            assert!(error.message.contains("需要确认权限"));
        }
        install_from_trp_source(
            &state,
            &fixture.source_id,
            &fixture.publisher_key_id,
            &plugin.id,
            needs_permission,
        )
        .await
        .unwrap();
        assert_eq!(current_version(&state, &plugin.id), "1.0.0");
    }

    copy_dir(&fixture.source_v2, &fixture.live_source);
    let second_sync = sync_one(&state, &fixture.source_id).await;
    assert!(second_sync.ok, "v2 同步失败: {:?}", second_sync.message);
    assert_eq!(second_sync.entry_count, fixture.packages.len() as i64);

    for plugin in &fixture.packages {
        if plugin.added_permission.is_some() {
            let error = install_from_trp_source(
                &state,
                &fixture.source_id,
                &fixture.publisher_key_id,
                &plugin.id,
                false,
            )
            .await
            .unwrap_err();
            assert!(error.message.contains("需要确认权限"));
        }
        install_from_trp_source(
            &state,
            &fixture.source_id,
            &fixture.publisher_key_id,
            &plugin.id,
            plugin.added_permission.is_some(),
        )
        .await
        .unwrap();
        assert_eq!(current_version(&state, &plugin.id), "1.1.0");
        if let Some(permission) = &plugin.added_permission {
            assert!(granted_permissions(&state, &plugin.id).contains(permission));
        }
    }

    for plugin in &fixture.packages {
        rollback_from_trp_source(&state, &plugin.id, "1.0.0", false)
            .await
            .unwrap();
        assert_eq!(current_version(&state, &plugin.id), "1.0.0");
        if let Some(permission) = &plugin.added_permission {
            assert!(!granted_permissions(&state, &plugin.id).contains(permission));
        }
        let error = rollback_from_trp_source(&state, &plugin.id, "1.0.0", false)
            .await
            .unwrap_err();
        assert!(error.message.contains("必须低于当前版本"));
    }

    let db = state.db.lock().unwrap();
    for plugin in &fixture.packages {
        let (source, publisher): (String, String) = db
            .conn
            .query_row(
                "SELECT source_id, publisher_key_id FROM installed_origins WHERE tool_id=?1",
                [&plugin.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(source, fixture.source_id);
        assert_eq!(publisher, fixture.publisher_key_id);
    }
}
