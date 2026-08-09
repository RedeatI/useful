//! 插件安装管线集成测试：原子安装、回滚、ZIP Slip、哈希、降级、宿主版本。

use std::io::Write;
use std::path::Path;
use useful_plugin::install::{install_useful, InstallOptions};
use useful_plugin::zip_safety::sha256_file;
use zip::write::SimpleFileOptions;

/// 构造一个 .useful 包。`files` 为 (zip内路径, 内容)。
fn make_useful(path: &Path, files: &[(&str, &[u8])]) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default();
    for (name, content) in files {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(content).unwrap();
    }
    zip.finish().unwrap();
}

fn valid_manifest(id: &str, version: &str) -> String {
    format!(
        r#"{{
        "schemaVersion": 1,
        "id": "{id}",
        "name": "测试插件",
        "version": "{version}",
        "description": "集成测试用",
        "icon": "assets/icon.png",
        "entry": {{ "type": "web", "path": "dist/index.html" }},
        "contributes": {{ "sidebar": [{{ "id": "main", "title": "测试", "group": "installed", "order": 1 }}] }},
        "permissions": [],
        "platforms": ["windows-x64"],
        "minHostVersion": "0.1.0"
    }}"#
    )
}

struct Dirs {
    _tmp: tempfile::TempDir,
    staging: std::path::PathBuf,
    plugins: std::path::PathBuf,
    pkgs: std::path::PathBuf,
}

fn setup() -> Dirs {
    let tmp = tempfile::tempdir().unwrap();
    let staging = tmp.path().join("staging");
    let plugins = tmp.path().join("plugins");
    let pkgs = tmp.path().join("pkgs");
    std::fs::create_dir_all(&pkgs).unwrap();
    Dirs {
        _tmp: tmp,
        staging,
        plugins,
        pkgs,
    }
}

#[test]
fn installs_valid_package_atomically() {
    let d = setup();
    let useful = d.pkgs.join("good.useful");
    make_useful(
        &useful,
        &[
            (
                "manifest.json",
                valid_manifest("com.example.good", "1.0.0").as_bytes(),
            ),
            ("dist/index.html", b"<html><body>hi</body></html>"),
            ("assets/icon.png", b"\x89PNG\r\n\x1a\n"),
        ],
    );

    let outcome =
        install_useful(&useful, &d.staging, &d.plugins, &InstallOptions::default()).unwrap();
    assert_eq!(outcome.manifest.id, "com.example.good");
    assert!(outcome.install_dir.join("dist/index.html").exists());
    assert!(outcome
        .install_dir
        .ends_with(Path::new("com.example.good").join("1.0.0")));
    // staging 已清理
    let staging_children: Vec<_> = std::fs::read_dir(&d.staging)
        .map(|rd| rd.filter_map(|e| e.ok()).collect())
        .unwrap_or_default();
    assert!(staging_children.is_empty(), "staging 应被清理");
}

#[test]
fn action_contribution_requires_packaged_plain_spec_file() {
    let d = setup();
    let manifest = valid_manifest("com.example.actions", "1.0.0").replace(
        "\"contributes\": { \"sidebar\":",
        "\"contributes\": { \"actions\": [{\"actionId\": \"com.example.actions.encode\", \"path\": \"actions/encode.json\"}], \"sidebar\":",
    );
    let valid = d.pkgs.join("actions-valid.useful");
    make_useful(
        &valid,
        &[
            ("manifest.json", manifest.as_bytes()),
            ("dist/index.html", b"<html></html>"),
            ("actions/encode.json", b"{}"),
        ],
    );
    let outcome =
        install_useful(&valid, &d.staging, &d.plugins, &InstallOptions::default()).unwrap();
    assert!(outcome.install_dir.join("actions/encode.json").is_file());

    let missing = d.pkgs.join("actions-missing.useful");
    let missing_manifest = manifest.replace("com.example.actions", "com.example.missing");
    make_useful(
        &missing,
        &[
            ("manifest.json", missing_manifest.as_bytes()),
            ("dist/index.html", b"<html></html>"),
        ],
    );
    assert!(install_useful(&missing, &d.staging, &d.plugins, &InstallOptions::default()).is_err());
    assert!(!d.plugins.join("com.example.missing").exists());
}

#[test]
fn rejects_zip_slip_and_rolls_back() {
    let d = setup();
    let useful = d.pkgs.join("evil.useful");
    make_useful(
        &useful,
        &[
            (
                "manifest.json",
                valid_manifest("com.example.evil", "1.0.0").as_bytes(),
            ),
            ("dist/index.html", b"<html></html>"),
            ("../../escape.txt", b"pwned"),
        ],
    );
    let err =
        install_useful(&useful, &d.staging, &d.plugins, &InstallOptions::default()).unwrap_err();
    // 完整回滚：不留任何安装目录
    assert!(!d.plugins.join("com.example.evil").exists());
    let staging_empty = std::fs::read_dir(&d.staging)
        .map(|rd| rd.filter_map(|e| e.ok()).count() == 0)
        .unwrap_or(true);
    assert!(staging_empty);
    let msg = err.to_string();
    assert!(msg.contains("回滚"), "应报告回滚: {msg}");
}

#[test]
fn rejects_hash_mismatch() {
    let d = setup();
    let useful = d.pkgs.join("hash.useful");
    make_useful(
        &useful,
        &[
            (
                "manifest.json",
                valid_manifest("com.example.hash", "1.0.0").as_bytes(),
            ),
            ("dist/index.html", b"<html></html>"),
        ],
    );
    let opts = InstallOptions {
        expected_sha256: Some("deadbeef".repeat(8)),
        ..Default::default()
    };
    assert!(install_useful(&useful, &d.staging, &d.plugins, &opts).is_err());
    assert!(!d.plugins.join("com.example.hash").exists());
}

#[test]
fn accepts_correct_hash() {
    let d = setup();
    let useful = d.pkgs.join("hash-ok.useful");
    make_useful(
        &useful,
        &[
            (
                "manifest.json",
                valid_manifest("com.example.hashok", "1.0.0").as_bytes(),
            ),
            ("dist/index.html", b"<html></html>"),
        ],
    );
    let sha = sha256_file(&useful).unwrap();
    let opts = InstallOptions {
        expected_sha256: Some(sha),
        ..Default::default()
    };
    assert!(install_useful(&useful, &d.staging, &d.plugins, &opts).is_ok());
}

#[test]
fn rejects_downgrade_unless_allowed() {
    let d = setup();
    let useful = d.pkgs.join("v1.useful");
    make_useful(
        &useful,
        &[
            (
                "manifest.json",
                valid_manifest("com.example.dg", "1.0.0").as_bytes(),
            ),
            ("dist/index.html", b"<html></html>"),
        ],
    );
    // 已安装 2.0.0，尝试装 1.0.0
    let opts = InstallOptions {
        installed_version: Some("2.0.0".into()),
        allow_downgrade: false,
        ..Default::default()
    };
    assert!(install_useful(&useful, &d.staging, &d.plugins, &opts).is_err());

    let opts_allow = InstallOptions {
        installed_version: Some("2.0.0".into()),
        allow_downgrade: true,
        ..Default::default()
    };
    assert!(install_useful(&useful, &d.staging, &d.plugins, &opts_allow).is_ok());
}

#[test]
fn rejects_host_version_too_low() {
    let d = setup();
    let manifest = valid_manifest("com.example.host", "1.0.0").replace(
        "\"minHostVersion\": \"0.1.0\"",
        "\"minHostVersion\": \"9.0.0\"",
    );
    let useful = d.pkgs.join("host.useful");
    make_useful(
        &useful,
        &[
            ("manifest.json", manifest.as_bytes()),
            ("dist/index.html", b"<html></html>"),
        ],
    );
    let opts = InstallOptions {
        host_version: "0.1.0".into(),
        ..Default::default()
    };
    assert!(install_useful(&useful, &d.staging, &d.plugins, &opts).is_err());
}

#[test]
fn rejects_missing_web_entry_file() {
    let d = setup();
    let useful = d.pkgs.join("noentry.useful");
    // manifest 声明 dist/index.html 但包里没有
    make_useful(
        &useful,
        &[(
            "manifest.json",
            valid_manifest("com.example.noentry", "1.0.0").as_bytes(),
        )],
    );
    assert!(install_useful(&useful, &d.staging, &d.plugins, &InstallOptions::default()).is_err());
    assert!(!d.plugins.join("com.example.noentry").exists());
}

#[test]
fn chinese_filename_package_installs() {
    let d = setup();
    let useful = d.pkgs.join("中文 插件包.useful");
    make_useful(
        &useful,
        &[
            (
                "manifest.json",
                valid_manifest("com.example.zh", "1.0.0").as_bytes(),
            ),
            ("dist/index.html", b"<html>\xe4\xbd\xa0\xe5\xa5\xbd</html>"),
            ("assets/图标 icon.png", b"\x89PNG"),
        ],
    );
    let outcome =
        install_useful(&useful, &d.staging, &d.plugins, &InstallOptions::default()).unwrap();
    assert!(outcome.install_dir.join("assets/图标 icon.png").exists());
}
