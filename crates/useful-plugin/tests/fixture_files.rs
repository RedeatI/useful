//! 针对真实测试夹具文件（fixtures/*.useful）的集成测试。
//!
//! 夹具由 `node scripts/make-fixtures.mjs` 生成。若不存在则跳过（例如未运行生成脚本），
//! 以保证在纯 Rust 环境下测试不会误报失败；CI 会先生成夹具再运行。

use std::path::PathBuf;
use useful_plugin::install::{install_useful, InstallOptions};

fn fixtures_dir() -> Option<PathBuf> {
    // crates/useful-plugin -> 仓库根 fixtures
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("fixtures");
    if dir.exists() {
        Some(dir)
    } else {
        None
    }
}

fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let staging = tmp.path().join("staging");
    let plugins = tmp.path().join("plugins");
    (tmp, staging, plugins)
}

#[test]
fn normal_fixture_installs() {
    let Some(dir) = fixtures_dir() else {
        eprintln!("跳过：未找到 fixtures，运行 `node scripts/make-fixtures.mjs` 生成");
        return;
    };
    let useful = dir.join("normal.useful");
    if !useful.exists() {
        eprintln!("跳过：缺少 normal.useful");
        return;
    }
    let (_tmp, staging, plugins) = setup();
    let outcome = install_useful(&useful, &staging, &plugins, &InstallOptions::default())
        .expect("正常夹具应安装成功");
    assert_eq!(outcome.manifest.id, "com.useful.hello-web");
    assert!(outcome.install_dir.join("index.html").exists());
}

#[test]
fn malicious_path_fixture_rejected() {
    let Some(dir) = fixtures_dir() else {
        return;
    };
    let useful = dir.join("malicious-path.useful");
    if !useful.exists() {
        return;
    }
    let (_tmp, staging, plugins) = setup();
    let result = install_useful(&useful, &staging, &plugins, &InstallOptions::default());
    assert!(result.is_err(), "恶意路径夹具必须被拒绝");
    // 完整回滚：不留安装目录
    assert!(!plugins.join("com.evil.pathtraversal").exists());
    // 不应在 plugins 外产生逃逸文件
    assert!(!plugins.parent().unwrap().join("escape.txt").exists());
}

#[test]
fn corrupt_fixture_rejected() {
    let Some(dir) = fixtures_dir() else {
        return;
    };
    let useful = dir.join("corrupt.useful");
    if !useful.exists() {
        return;
    }
    let (_tmp, staging, plugins) = setup();
    let result = install_useful(&useful, &staging, &plugins, &InstallOptions::default());
    assert!(result.is_err(), "损坏夹具必须被拒绝");
}
