//! useful-bootstrap.exe：便携客户端更新引导器入口。
//!
//! 用法：
//!   useful-bootstrap check   从 AppUpdateSource feed 检查并下载更新到 pending/
//!   useful-bootstrap apply   验证并应用 pending 更新（默认命令）
//!   useful-bootstrap status  显示更新源与 pending 状态
//!
//! 退出码：0 成功/无更新；1 失败（旧版本保持可用）。

#[cfg(windows)]
use std::io::Read;
#[cfg(windows)]
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;

#[cfg(windows)]
use useful_bootstrap::apply::{
    apply_update, cleanup_backups, ensure_app_exited, extract_payload, rollback,
};
#[cfg(windows)]
use useful_bootstrap::config::{
    is_allowed_update_url, load_or_official, PRODUCTION_UPDATE_CONFIGURED,
};
#[cfg(windows)]
use useful_bootstrap::manifest::{parse_manifest, verify_update, MAX_UPDATE_SIZE};

#[cfg(windows)]
const APP_EXE: &str = "Useful.exe";
#[cfg(windows)]
const KEEP_BACKUPS: usize = 3;
#[cfg(windows)]
const MAX_UPDATE_REDIRECTS: usize = 5;

#[cfg(windows)]
fn app_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 当前已安装版本：app_root/update/current-version.txt（客户端每次启动写入）；
/// 缺失时按 0.0.0（任何合法更新都可应用）。
#[cfg(windows)]
fn current_version(root: &Path) -> String {
    std::fs::read_to_string(root.join("update/current-version.txt"))
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| semver::Version::parse(s).is_ok())
        .unwrap_or_else(|| "0.0.0".into())
}

#[cfg(windows)]
fn cmd_status(root: &Path) -> i32 {
    let cfg = match load_or_official(&root.join("update/app-update-source.json")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[bootstrap] 更新源配置错误: {e}");
            return 1;
        }
    };
    println!("[bootstrap] 更新源模板: {}", cfg.update_feed_url);
    println!("[bootstrap] 当前 feed: {}", cfg.resolved_feed_url());
    println!("[bootstrap] 更新通道: {}", cfg.channel);
    println!("[bootstrap] 官方源: {}", cfg.is_official());
    println!(
        "[bootstrap] 开发更新信任: {}",
        !PRODUCTION_UPDATE_CONFIGURED
    );
    println!("[bootstrap] 根指纹: {}", cfg.root_fingerprint());
    println!("[bootstrap] 当前版本: {}", current_version(root));
    println!(
        "[bootstrap] pending: {}",
        root.join("update/pending/update-manifest.json").exists()
    );
    0
}

/// feed 格式：{"schemaVersion":1,"version":"x.y.z","payloadUrl":"https://...","manifest":{...}}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(windows)]
struct Feed {
    schema_version: u32,
    manifest: useful_bootstrap::UpdateManifest,
    payload_url: String,
}

#[cfg(windows)]
fn download_bounded(
    client: &reqwest::blocking::Client,
    url: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    if !is_allowed_update_url(url) {
        return Err("URL 必须为 HTTPS（本地开发回环除外）".into());
    }
    let response = client.get(url).send().map_err(|error| error.to_string())?;
    if !is_allowed_update_url(response.url().as_str()) {
        return Err("重定向后的 URL 不符合更新传输策略".into());
    }
    response
        .error_for_status_ref()
        .map_err(|error| error.to_string())?;
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(format!("响应超过 {max_bytes} 字节上限"));
    }
    let mut bytes = Vec::new();
    response
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("响应超过 {max_bytes} 字节上限"));
    }
    Ok(bytes)
}

#[cfg(windows)]
fn validate_update_redirect(url: &str, previous_urls: usize) -> Result<(), &'static str> {
    if !is_allowed_update_url(url) {
        return Err("重定向目标不符合更新传输策略");
    }
    // reqwest 的 previous 列表包含初始请求，因此长度超过上限时才是第 N+1 次重定向。
    if previous_urls > MAX_UPDATE_REDIRECTS {
        return Err("更新重定向次数超过上限");
    }
    Ok(())
}

#[cfg(windows)]
fn cmd_check(root: &Path) -> i32 {
    let cfg = match load_or_official(&root.join("update/app-update-source.json")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[bootstrap] 更新源配置错误: {e}");
            return 1;
        }
    };
    let redirect_policy =
        reqwest::redirect::Policy::custom(|attempt| {
            match validate_update_redirect(attempt.url().as_str(), attempt.previous().len()) {
                Ok(()) => attempt.follow(),
                Err(error) => attempt.error(error),
            }
        });
    let client = match reqwest::blocking::Client::builder()
        .redirect(redirect_policy)
        .timeout(std::time::Duration::from_secs(60))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[bootstrap] HTTP 客户端创建失败: {e}");
            return 1;
        }
    };
    let feed_url = cfg.resolved_feed_url();
    let feed_raw = match download_bounded(&client, &feed_url, 256 * 1024) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[bootstrap] 拉取 feed 失败: {e}");
            return 1;
        }
    };
    let feed: Feed = match serde_json::from_slice(&feed_raw) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[bootstrap] feed 解析失败: {e}");
            return 1;
        }
    };
    if feed.schema_version != 1 {
        eprintln!("[bootstrap] feed schemaVersion 不支持");
        return 1;
    }
    let cur = current_version(root);
    let offered = &feed.manifest.version;
    if semver::Version::parse(offered)
        .ok()
        .zip(semver::Version::parse(&cur).ok())
        .map(|(o, c)| o <= c)
        .unwrap_or(true)
    {
        println!("[bootstrap] 已是最新版本（当前 {cur}）");
        return 0;
    }
    // 下载 payload（HTTPS 由 feed URL 域保障；最终以摘要+签名为准）
    if !is_allowed_update_url(&feed.payload_url) {
        eprintln!("[bootstrap] payloadUrl 必须为 HTTPS");
        return 1;
    }
    let payload = match download_bounded(&client, &feed.payload_url, MAX_UPDATE_SIZE) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[bootstrap] 下载失败: {e}");
            return 1;
        }
    };
    // 落盘前先验证（fail closed：验证失败不留 pending）
    if let Err(e) = verify_update(&feed.manifest, &payload, &cfg.update_root_public_key, &cur) {
        eprintln!("[bootstrap] 更新验证失败，已拒绝: {e}");
        return 1;
    }
    let pending = root.join("update/pending");
    if std::fs::create_dir_all(&pending).is_err() {
        eprintln!("[bootstrap] 创建 pending 目录失败");
        return 1;
    }
    let manifest_json = serde_json::to_vec(&feed.manifest).expect("serialize manifest");
    if std::fs::write(pending.join("update-manifest.json"), manifest_json).is_err()
        || std::fs::write(pending.join("payload.zip"), &payload).is_err()
    {
        eprintln!("[bootstrap] 写入 pending 失败");
        return 1;
    }
    println!("[bootstrap] 已下载更新 {offered} 到 pending/，退出 Useful 后运行 apply");
    0
}

#[cfg(windows)]
fn cmd_apply(root: &Path) -> i32 {
    let pending = root.join("update/pending");
    let manifest_path = pending.join("update-manifest.json");
    if !manifest_path.exists() {
        println!("[bootstrap] 无待应用更新");
        return 0;
    }
    let cfg = match load_or_official(&root.join("update/app-update-source.json")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[bootstrap] 更新源配置错误: {e}");
            return 1;
        }
    };
    let (manifest, payload) = match (
        std::fs::read(&manifest_path)
            .map_err(|e| e.to_string())
            .and_then(|raw| parse_manifest(&raw).map_err(|e| e.to_string())),
        std::fs::read(pending.join("payload.zip")),
    ) {
        (Ok(m), Ok(p)) => (m, p),
        (Err(e), _) => {
            eprintln!("[bootstrap] 清单读取失败: {e}");
            return 1;
        }
        (_, Err(e)) => {
            eprintln!("[bootstrap] payload 读取失败: {e}");
            return 1;
        }
    };
    let cur = current_version(root);
    // 1) 验证（签名/摘要/长度/升级）—— 失败即拒绝，不触碰现有文件
    if let Err(e) = verify_update(&manifest, &payload, &cfg.update_root_public_key, &cur) {
        eprintln!("[bootstrap] 更新验证失败，已拒绝: {e}");
        return 1;
    }
    // 2) 确认 Useful.exe 已退出
    if let Err(e) = ensure_app_exited(&root.join(APP_EXE)) {
        eprintln!("[bootstrap] {e}");
        return 1;
    }
    // 3) 解包到 staging
    let staging = root.join("update/staging");
    let _ = std::fs::remove_dir_all(&staging);
    let files = match extract_payload(&payload, &staging) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[bootstrap] 解包失败: {e}");
            return 1;
        }
    };
    // 4) 备份 + 替换
    let backup_root = root.join("backup");
    let backup_dir = match apply_update(root, &staging, &files, &backup_root, &cur) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[bootstrap] 应用更新失败: {e}");
            return 1;
        }
    };
    // 5) 启动新版本；失败回滚
    match Command::new(root.join(APP_EXE)).spawn() {
        Ok(_) => {
            let _ = std::fs::write(
                root.join("update/current-version.txt"),
                manifest.version.as_bytes(),
            );
            let _ = std::fs::remove_dir_all(&pending);
            let _ = std::fs::remove_dir_all(&staging);
            let removed = cleanup_backups(&backup_root, KEEP_BACKUPS).unwrap_or(0);
            println!(
                "[bootstrap] 更新到 {} 完成（清理 {removed} 个过期备份）",
                manifest.version
            );
            0
        }
        Err(e) => {
            eprintln!("[bootstrap] 新版本启动失败: {e}，开始回滚");
            match rollback(root, &backup_dir) {
                Ok(()) => {
                    eprintln!("[bootstrap] 已回滚到 {cur}，旧版本可正常启动");
                    let _ = Command::new(root.join(APP_EXE)).spawn();
                }
                Err(re) => eprintln!("[bootstrap] {re}"),
            }
            1
        }
    }
}

#[cfg(windows)]
fn main() {
    let root = app_root();
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "apply".into());
    let code = match cmd.as_str() {
        "check" => cmd_check(&root),
        "apply" => cmd_apply(&root),
        "status" => cmd_status(&root),
        other => {
            eprintln!("[bootstrap] 未知命令: {other}（支持 check|apply|status）");
            2
        }
    };
    std::process::exit(code);
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn redirect_policy_rejects_every_disallowed_target() {
        for url in [
            "http://127.0.0.1.evil.example/update.zip",
            "http://example.org/update.zip",
            "ftp://updates.example.org/update.zip",
            "https://user@updates.example.org/update.zip",
            "https://updates.example.org/update.zip#fragment",
        ] {
            assert!(
                validate_update_redirect(url, 1).is_err(),
                "redirect target unexpectedly allowed: {url}"
            );
        }
    }

    #[test]
    fn redirect_policy_allows_only_bounded_compliant_hops() {
        assert!(validate_update_redirect("https://updates.example.org/update.zip", 1).is_ok());
        assert!(validate_update_redirect(
            "https://updates.example.org/update.zip",
            MAX_UPDATE_REDIRECTS
        )
        .is_ok());
        assert!(validate_update_redirect(
            "https://updates.example.org/update.zip",
            MAX_UPDATE_REDIRECTS + 1
        )
        .is_err());
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("[bootstrap] 当前平台尚不支持安全的原子自更新；不会下载、替换或启动任何文件");
    std::process::exit(2);
}
