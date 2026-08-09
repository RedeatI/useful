//! AppUpdateSource 配置：客户端更新专用信任域。
//!
//! 与工具源（trp_sources）字段名刻意不同（updateRootPublicKey / updateFeedUrl），
//! 禁止相互赋值；不从任何工具源继承。对应协议 app-update-source.schema.json。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

/// 本地开发回退公钥。正式 Release workflow 明确拒绝该值。
pub const DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX: &str =
    "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
pub const DEVELOPMENT_UPDATE_FEED_URL_TEMPLATE: &str =
    "https://update.useful.example/feed/{channel}/{platform}-{arch}.json";

const INJECTED_UPDATE_ROOT: Option<&str> = option_env!("USEFUL_UPDATE_ROOT_PUBKEY_HEX");
const INJECTED_UPDATE_FEED: Option<&str> = option_env!("USEFUL_UPDATE_FEED_URL_TEMPLATE");

/// release-profile 本地 QA 只有显式设置此变量为 `1` 才能使用开发信任根。
pub const DEVELOPMENT_UPDATE_TRUST_OPT_IN: bool =
    match option_env!("USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST") {
        Some(value) => bytes_equal(value, "1"),
        None => false,
    };

const fn bytes_equal(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut index = 0;
    while index < left.len() {
        if left[index] != right[index] {
            return false;
        }
        index += 1;
    }
    true
}

const fn bytes_start_with(value: &str, prefix: &str) -> bool {
    let value = value.as_bytes();
    let prefix = prefix.as_bytes();
    if value.len() < prefix.len() {
        return false;
    }
    let mut index = 0;
    while index < prefix.len() {
        if value[index] != prefix[index] {
            return false;
        }
        index += 1;
    }
    true
}

const fn bytes_contains(value: &str, needle: &str) -> bool {
    let value = value.as_bytes();
    let needle = needle.as_bytes();
    if needle.is_empty() {
        return true;
    }
    let mut start = 0;
    while start + needle.len() <= value.len() {
        let mut index = 0;
        while index < needle.len() && value[start + index] == needle[index] {
            index += 1;
        }
        if index == needle.len() {
            return true;
        }
        start += 1;
    }
    false
}

const fn valid_key_hex(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 64 {
        return false;
    }
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_hexdigit() {
            return false;
        }
        index += 1;
    }
    true
}

const fn bytes_equal_ignore_ascii_case(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut index = 0;
    while index < left.len() {
        if !left[index].eq_ignore_ascii_case(&right[index]) {
            return false;
        }
        index += 1;
    }
    true
}

const fn bytes_are_all_zero(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'0' {
            return false;
        }
        index += 1;
    }
    true
}

const fn valid_production_update_root(value: &str) -> bool {
    valid_key_hex(value)
        && !bytes_equal_ignore_ascii_case(value, DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX)
        && !bytes_are_all_zero(value)
}

const fn valid_production_update_feed_template(value: &str) -> bool {
    bytes_start_with(value, "https://")
        && !bytes_equal(value, DEVELOPMENT_UPDATE_FEED_URL_TEMPLATE)
        && bytes_contains(value, "{channel}")
        && bytes_contains(value, "{platform}")
        && bytes_contains(value, "{arch}")
}

/// 两个 production 信任参数必须成对注入并通过编译期信任门；只注入一项或使用
/// 开发/占位信任材料都会在编译期失败。
pub const PRODUCTION_UPDATE_CONFIGURED: bool = match (INJECTED_UPDATE_ROOT, INJECTED_UPDATE_FEED) {
    (Some(key), Some(feed)) => {
        valid_production_update_root(key) && valid_production_update_feed_template(feed)
    }
    _ => false,
};

const _: () = match (INJECTED_UPDATE_ROOT, INJECTED_UPDATE_FEED) {
    (Some(key), Some(feed)) => {
        assert!(
            valid_key_hex(key),
            "USEFUL_UPDATE_ROOT_PUBKEY_HEX must be exactly 64 hexadecimal characters"
        );
        assert!(
            valid_production_update_root(key),
            "USEFUL_UPDATE_ROOT_PUBKEY_HEX must not use the development or all-zero update root"
        );
        assert!(
            valid_production_update_feed_template(feed),
            "USEFUL_UPDATE_FEED_URL_TEMPLATE must be an HTTPS template distinct from the development default and containing channel, platform, and arch placeholders"
        );
    }
    (None, None) => {
        assert!(
            cfg!(debug_assertions) || DEVELOPMENT_UPDATE_TRUST_OPT_IN,
            "release-profile builds require injected Useful update key/feed; local QA may explicitly set USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST=1"
        );
    }
    _ => panic!(
        "USEFUL_UPDATE_ROOT_PUBKEY_HEX and USEFUL_UPDATE_FEED_URL_TEMPLATE must be injected together"
    ),
};

/// 官方预置的客户端更新根公钥（Ed25519 hex）。
///
/// 正式构建由 Release environment 通过只读的编译期变量注入公钥；私钥始终离线，绝不进入
/// 仓库或 CI。本地开发未注入时使用可识别的开发回退值，并由正式发布门禁拒绝。
pub const OFFICIAL_UPDATE_ROOT_PUBKEY_HEX: &str = match INJECTED_UPDATE_ROOT {
    Some(value) => value,
    None => DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX,
};

/// 官方更新 feed 模板。正式 Release workflow 会注入真实 HTTPS 模板；本地开发模板
/// 不能作为 production 编译期注入值，完整 URL/保留域规则仍由发布门禁验证。
pub const OFFICIAL_UPDATE_FEED_URL_TEMPLATE: &str = match INJECTED_UPDATE_FEED {
    Some(value) => value,
    None => DEVELOPMENT_UPDATE_FEED_URL_TEMPLATE,
};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("读取配置失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("配置解析失败: {0}")]
    Parse(String),
    #[error("配置非法: {0}")]
    Invalid(String),
}

/// 客户端更新源配置（update/app-update-source.json）。
/// kind 固定 app-update；工具源的 SourceDefinition 无法反序列化为本类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppUpdateSource {
    pub kind: String,
    /// 更新 feed 地址（必须 HTTPS；官方默认源除本地开发外同样要求）。
    pub update_feed_url: String,
    /// 客户端更新根公钥（Ed25519 hex，64 字符）。与工具源信任根完全分离。
    pub update_root_public_key: String,
    /// 接收的客户端更新通道。stable / beta / nightly 三者隔离。
    #[serde(default = "default_update_channel")]
    pub channel: String,
    /// 是否官方预置默认源。
    pub is_default_official: bool,
    /// 更换为非官方更新源时用户确认单独警告的时间（RFC3339）；官方默认为 None。
    #[serde(default)]
    pub warning_acknowledged_at: Option<String>,
}

impl AppUpdateSource {
    /// 编译时内置更新源。production 注入时是官方源；开发构建则明确标记为开发回退。
    pub fn official_default() -> Self {
        AppUpdateSource {
            kind: "app-update".into(),
            update_feed_url: OFFICIAL_UPDATE_FEED_URL_TEMPLATE.into(),
            update_root_public_key: OFFICIAL_UPDATE_ROOT_PUBKEY_HEX.into(),
            channel: "stable".into(),
            is_default_official: PRODUCTION_UPDATE_CONFIGURED,
            warning_acknowledged_at: None,
        }
    }

    /// 校验配置合法性。非官方源必须已确认警告。
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.kind != "app-update" {
            return Err(ConfigError::Invalid(format!(
                "kind 必须为 app-update（拒绝工具源类型: {}）",
                self.kind
            )));
        }
        if hex::decode(&self.update_root_public_key)
            .map(|b| b.len() != 32)
            .unwrap_or(true)
        {
            return Err(ConfigError::Invalid(
                "updateRootPublicKey 必须是 32 字节 Ed25519 公钥 hex".into(),
            ));
        }
        if !matches!(self.channel.as_str(), "stable" | "beta" | "nightly") {
            return Err(ConfigError::Invalid(
                "channel 仅允许 stable、beta 或 nightly".into(),
            ));
        }
        if !valid_feed_template(&self.update_feed_url) {
            return Err(ConfigError::Invalid(
                "updateFeedUrl 只允许 {channel}/{platform}/{arch} 占位符".into(),
            ));
        }
        let resolved = self.resolved_feed_url();
        if !is_allowed_update_url(&resolved) {
            return Err(ConfigError::Invalid(
                "updateFeedUrl 必须为 HTTPS（本地开发回环除外）".into(),
            ));
        }
        // 官方身份的唯一真相是公钥字节是否匹配预置根（is_official），
        // 绝不采信 JSON 里的 isDefaultOfficial 布尔位——它可被本地篡改/注入。
        let official = self.is_official();
        let bundled_default = self.is_bundled_default();
        // 反伪造：配置自称官方默认，却不携带官方预置公钥 → 矛盾，fail closed。
        // （否则攻击者可置 isDefaultOfficial=true 以绕过下面的警告确认门。）
        if self.is_default_official && !official {
            return Err(ConfigError::Invalid(
                "isDefaultOfficial=true 但公钥不是官方更新根：拒绝（防伪造官方身份绕过警告门）"
                    .into(),
            ));
        }
        // 任何非官方更新根都必须已确认单独警告——与 isDefaultOfficial 无关。
        if !official && !bundled_default && self.warning_acknowledged_at.is_none() {
            return Err(ConfigError::Invalid(
                "非官方更新源必须先确认单独警告（warningAcknowledgedAt）".into(),
            ));
        }
        Ok(())
    }

    /// 将通道和当前目标写入 feed URL。旧配置没有占位符时追加显式查询参数，
    /// 避免用户切换 beta/nightly 后仍请求同一个 stable feed。
    pub fn resolved_feed_url(&self) -> String {
        let platform = current_platform();
        let arch = current_arch();
        let templated = self
            .update_feed_url
            .replace("{channel}", &self.channel)
            .replace("{platform}", platform)
            .replace("{arch}", arch);
        if templated != self.update_feed_url {
            templated
        } else {
            let separator = if templated.contains('?') { '&' } else { '?' };
            format!(
                "{templated}{separator}channel={}&platform={platform}&arch={arch}",
                self.channel
            )
        }
    }

    /// 根公钥指纹（sha256(pubkey bytes) hex），供 UI 展示与人工比对。
    pub fn root_fingerprint(&self) -> String {
        let raw = hex::decode(&self.update_root_public_key).unwrap_or_default();
        hex::encode(Sha256::digest(&raw))
    }

    /// 是否为官方源：仅由预置公钥字节匹配决定（不看 URL/名称）。
    pub fn is_official(&self) -> bool {
        PRODUCTION_UPDATE_CONFIGURED
            && self
                .update_root_public_key
                .eq_ignore_ascii_case(OFFICIAL_UPDATE_ROOT_PUBKEY_HEX)
    }

    /// 是否为本次二进制内置的完整 key+feed 对；开发回退可据此免除“自定义源”确认，
    /// 但永远不会被展示为官方生产信任。
    pub fn is_bundled_default(&self) -> bool {
        self.update_root_public_key
            .eq_ignore_ascii_case(OFFICIAL_UPDATE_ROOT_PUBKEY_HEX)
            && self.update_feed_url == OFFICIAL_UPDATE_FEED_URL_TEMPLATE
    }
}

/// 更新 URL 必须是有主机的 HTTPS；仅开发回环允许 HTTP。字符串前缀相似的外部主机不算回环。
pub fn is_allowed_update_url(value: &str) -> bool {
    let authority = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"));
    if authority
        .is_none_or(|value| value.is_empty() || value.starts_with('/') || value.starts_with('\\'))
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => matches!(host, "127.0.0.1" | "::1" | "[::1]"),
        _ => false,
    }
}

fn default_update_channel() -> String {
    "stable".into()
}

fn valid_feed_template(value: &str) -> bool {
    let mut rest = value;
    while let Some(open) = rest.find('{') {
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('}') else {
            return false;
        };
        if !matches!(&after_open[..close], "channel" | "platform" | "arch") {
            return false;
        }
        rest = &after_open[close + 1..];
    }
    !rest.contains('}')
}

pub const fn current_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unsupported"
    }
}

pub const fn current_arch() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    {
        "x86_64"
    }
    #[cfg(target_arch = "aarch64")]
    {
        "aarch64"
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        "unsupported"
    }
}

/// 加载配置；文件缺失时返回官方默认。绝不从工具源数据库读取。
pub fn load_or_official(path: &Path) -> Result<AppUpdateSource, ConfigError> {
    if !path.exists() {
        return Ok(AppUpdateSource::official_default());
    }
    let raw = std::fs::read(path)?;
    if raw.len() > 64 * 1024 {
        return Err(ConfigError::Invalid("配置文件过大".into()));
    }
    let mut cfg: AppUpdateSource =
        serde_json::from_slice(&raw).map_err(|e| ConfigError::Parse(e.to_string()))?;
    // 早期开发构建曾把开发回退误写成 isDefaultOfficial=true。仅当 key+feed 仍精确
    // 等于当前内置开发对时，迁移为非官方 bundled default；任何换根/换 feed 仍 fail closed。
    if !PRODUCTION_UPDATE_CONFIGURED && cfg.is_bundled_default() {
        cfg.is_default_official = false;
    }
    cfg.validate()?;
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_default_is_valid_and_reports_trust_mode_honestly() {
        let c = AppUpdateSource::official_default();
        c.validate().unwrap();
        assert!(c.is_bundled_default());
        assert_eq!(c.is_official(), PRODUCTION_UPDATE_CONFIGURED);
        assert_eq!(c.is_default_official, PRODUCTION_UPDATE_CONFIGURED);
        assert_eq!(c.root_fingerprint().len(), 64);
    }

    #[test]
    fn production_root_gate_rejects_development_and_all_zero_keys() {
        assert!(!valid_production_update_root(
            DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX
        ));
        assert!(!valid_production_update_root(
            &DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX.to_ascii_uppercase()
        ));
        assert!(!valid_production_update_root(&"0".repeat(64)));
        assert!(!valid_production_update_root(&"1".repeat(63)));
        assert!(valid_production_update_root(&"1".repeat(64)));
    }

    #[test]
    fn production_feed_gate_rejects_development_and_preserves_structure_checks() {
        assert!(!valid_production_update_feed_template(
            DEVELOPMENT_UPDATE_FEED_URL_TEMPLATE
        ));
        assert!(!valid_production_update_feed_template(
            "http://updates.example-company.com/feed/{channel}/{platform}-{arch}.json"
        ));
        assert!(!valid_production_update_feed_template(
            "https://updates.example-company.com/feed/{channel}/{platform}.json"
        ));
        assert!(valid_production_update_feed_template(
            "https://updates.example-company.com/feed/{channel}/{platform}-{arch}.json"
        ));
    }

    #[test]
    fn tool_source_kind_rejected() {
        // 普通工具源配置不能成为客户端更新源
        let mut c = AppUpdateSource::official_default();
        c.kind = "tool".into();
        assert!(c.validate().is_err());
    }

    #[test]
    fn tool_source_definition_shape_rejected() {
        // 工具源 SourceDefinition 的字段（rootKeyFingerprint 等）无法反序列化：
        // 字段名刻意不同 + deny_unknown_fields，禁止信任域互相赋值。
        let tool_source = r#"{
            "kind": "tool",
            "discoveryUrl": "https://evil.example/.well-known/useful-repository.json",
            "rootKeyFingerprint": "aa"
        }"#;
        assert!(serde_json::from_str::<AppUpdateSource>(tool_source).is_err());
    }

    #[test]
    fn custom_source_requires_warning_ack() {
        let mut c = AppUpdateSource::official_default();
        c.is_default_official = false;
        c.update_root_public_key = "11".repeat(32);
        assert!(c.validate().is_err(), "未确认警告必须拒绝");
        c.warning_acknowledged_at = Some("2026-07-30T00:00:00Z".into());
        c.validate().unwrap();
        assert!(!c.is_official(), "自定义更新源绝不显示官方身份");
    }

    #[test]
    fn https_downgrade_rejected() {
        let mut c = AppUpdateSource::official_default();
        c.update_feed_url = "http://update.example/feed.json".into();
        assert!(c.validate().is_err());
    }

    #[test]
    fn spoofed_default_official_flag_rejected() {
        // 信任边界回归：攻击者本地写入 isDefaultOfficial=true + 自己的根公钥 + 无警告确认。
        // 修复前 validate() 用 JSON 布尔位豁免警告门而通过；修复后必须拒绝，
        // 且攻击者的根绝不显示官方身份（对应退出条件 6：dev/prod 更新根强隔离）。
        let mut c = AppUpdateSource::official_default();
        c.update_root_public_key = "11".repeat(32); // 非官方（攻击者）根
        c.is_default_official = true; // 伪造"官方默认"以试图绕过警告门
        c.warning_acknowledged_at = None;
        assert!(
            c.validate().is_err(),
            "伪造 isDefaultOfficial 竟通过验证（可静默绕过警告门）"
        );
        assert!(!c.is_official(), "攻击者根绝不显示官方身份");
    }

    #[test]
    fn official_key_is_official_regardless_of_flag() {
        // is_official 只由公钥字节决定，与 isDefaultOfficial 无关：
        // 官方密钥即使 isDefaultOfficial=false 仍是官方（且免警告门）。
        let mut c = AppUpdateSource::official_default();
        c.is_default_official = false;
        c.warning_acknowledged_at = None;
        assert_eq!(c.is_official(), PRODUCTION_UPDATE_CONFIGURED);
        c.validate().unwrap();
    }

    #[test]
    fn missing_file_falls_back_to_official() {
        let cfg = load_or_official(Path::new("Z:/nonexistent/app-update-source.json")).unwrap();
        assert!(cfg.is_bundled_default());
        assert_eq!(cfg.is_default_official, PRODUCTION_UPDATE_CONFIGURED);
        assert_eq!(cfg.is_official(), PRODUCTION_UPDATE_CONFIGURED);
    }

    #[test]
    fn legacy_development_default_flag_is_normalized_without_weakening_custom_sources() {
        if PRODUCTION_UPDATE_CONFIGURED {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app-update-source.json");
        let mut cfg = AppUpdateSource::official_default();
        cfg.is_default_official = true;
        std::fs::write(&path, serde_json::to_vec(&cfg).unwrap()).unwrap();
        let loaded = load_or_official(&path).unwrap();
        assert!(loaded.is_bundled_default());
        assert!(!loaded.is_default_official);
        assert!(!loaded.is_official());
    }

    #[test]
    fn update_channel_is_validated_and_defaults_for_old_configs() {
        let mut cfg = AppUpdateSource::official_default();
        cfg.channel = "beta".into();
        cfg.validate().unwrap();
        cfg.channel = "nightly".into();
        cfg.validate().unwrap();
        assert!(cfg.resolved_feed_url().contains("/nightly/"));
        cfg.channel = "canary".into();
        assert!(cfg.validate().is_err());

        let legacy = format!(
            r#"{{"kind":"app-update","updateFeedUrl":"https://update.example/feed.json","updateRootPublicKey":"{}","isDefaultOfficial":true}}"#,
            OFFICIAL_UPDATE_ROOT_PUBKEY_HEX
        );
        let parsed: AppUpdateSource = serde_json::from_str(&legacy).unwrap();
        assert_eq!(parsed.channel, "stable");
        assert!(parsed.resolved_feed_url().contains("channel=stable"));
        assert!(parsed.resolved_feed_url().contains("platform="));
        assert!(parsed.resolved_feed_url().contains("arch="));
    }

    #[test]
    fn feed_template_rejects_unknown_placeholders() {
        let mut cfg = AppUpdateSource::official_default();
        cfg.update_feed_url = "https://update.example/{tenant}/feed.json".into();
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn url_policy_parses_hosts_instead_of_trusting_prefixes() {
        assert!(is_allowed_update_url(
            "https://updates.example.org/feed.json"
        ));
        assert!(is_allowed_update_url("http://127.0.0.1:8080/feed.json"));
        assert!(is_allowed_update_url("http://[::1]:8080/feed.json"));
        assert!(!is_allowed_update_url(
            "http://127.0.0.1.evil.example/feed.json"
        ));
        assert!(!is_allowed_update_url("https:///missing-host"));
        assert!(!is_allowed_update_url("https://user@example.org/feed.json"));
        assert!(!is_allowed_update_url(
            "https://example.org/feed.json#fragment"
        ));
    }
}
