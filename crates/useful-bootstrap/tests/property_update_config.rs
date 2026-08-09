//! Property 测试：AppUpdateSource 配置的信任边界（Section 八 fuzz 目标 "配置文件"）。
//!
//! 客户端更新根是独立信任域（退出条件 6）。核心不变量：
//! - `load_or_official` 对任意字节绝不 panic（fail closed）；
//! - **官方身份不可伪造**：production 注入存在时，`is_official()` 才可能由公钥匹配产生，
//!   与 isDefaultOfficial / URL / 警告确认等任何可篡改字段无关；
//! - **警告门不可绕过**：任何非官方根若无 warningAcknowledgedAt，validate() 必拒绝，
//!   无论 isDefaultOfficial 为何（防本地写入布尔位静默换根）；
//! - isDefaultOfficial=true 但公钥非官方 → 矛盾，必拒绝。

use proptest::prelude::*;
use useful_bootstrap::config::{
    load_or_official, AppUpdateSource, OFFICIAL_UPDATE_ROOT_PUBKEY_HEX,
    PRODUCTION_UPDATE_CONFIGURED,
};

fn hex64() -> impl Strategy<Value = String> {
    prop::collection::vec(0u8..16, 64).prop_map(|v| {
        v.into_iter()
            .map(|n| char::from_digit(n as u32, 16).unwrap())
            .collect()
    })
}

fn source(
    key: String,
    is_default_official: bool,
    ack: Option<String>,
    https: bool,
) -> AppUpdateSource {
    AppUpdateSource {
        kind: "app-update".into(),
        update_feed_url: if https {
            "https://update.example/feed.json".into()
        } else {
            "http://update.example/feed.json".into()
        },
        update_root_public_key: key,
        channel: "stable".into(),
        is_default_official,
        warning_acknowledged_at: ack,
    }
}

proptest! {
    /// 任意字节当作更新源配置加载：绝不 panic，只允许 Err 或合法配置。
    #[test]
    fn load_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..8192)) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("app-update-source.json");
        std::fs::write(&p, &bytes).unwrap();
        let _ = load_or_official(&p);
    }

    /// production 注入存在时 is_official() 只由公钥字节决定；开发回退永不冒充官方。
    #[test]
    fn is_official_depends_only_on_key(
        key in hex64(),
        flag in any::<bool>(),
        has_ack in any::<bool>(),
        https in any::<bool>(),
    ) {
        let ack = has_ack.then(|| "2026-07-30T00:00:00Z".to_string());
        let c = source(key.clone(), flag, ack, https);
        let expected = PRODUCTION_UPDATE_CONFIGURED
            && key.eq_ignore_ascii_case(OFFICIAL_UPDATE_ROOT_PUBKEY_HEX);
        prop_assert_eq!(c.is_official(), expected);
    }

    /// production 中官方密钥大小写变体仍被认作官方；开发构建不得冒充官方。
    #[test]
    fn official_key_case_insensitive(flag in any::<bool>()) {
        let c = source(OFFICIAL_UPDATE_ROOT_PUBKEY_HEX.to_uppercase(), flag, None, true);
        prop_assert_eq!(c.is_official(), PRODUCTION_UPDATE_CONFIGURED);
        if PRODUCTION_UPDATE_CONFIGURED {
            prop_assert!(c.validate().is_ok());
        } else {
            prop_assert!(c.validate().is_err());
        }
    }

    /// 警告门不可绕过：非官方根 + 无 ack → validate 必拒绝，与 isDefaultOfficial 无关。
    #[test]
    fn non_official_without_ack_always_rejected(
        key in hex64(),
        flag in any::<bool>(),
    ) {
        prop_assume!(!key.eq_ignore_ascii_case(OFFICIAL_UPDATE_ROOT_PUBKEY_HEX));
        let c = source(key, flag, None, true);
        prop_assert!(
            c.validate().is_err(),
            "非官方根无警告确认竟通过（isDefaultOfficial={flag}）"
        );
    }

    /// isDefaultOfficial=true 但公钥非官方 → 矛盾，必拒绝（防伪造官方身份）。
    #[test]
    fn spoofed_official_default_always_rejected(
        key in hex64(),
        has_ack in any::<bool>(),
    ) {
        prop_assume!(!key.eq_ignore_ascii_case(OFFICIAL_UPDATE_ROOT_PUBKEY_HEX));
        let ack = has_ack.then(|| "2026-07-30T00:00:00Z".to_string());
        let c = source(key, true, ack, true);
        prop_assert!(c.validate().is_err(), "伪造官方默认身份竟通过验证");
        prop_assert!(!c.is_official());
    }

    /// 非官方根 + 已确认警告 + isDefaultOfficial=false → 合法（正常换源路径）。
    #[test]
    fn acknowledged_custom_source_accepted(key in hex64()) {
        prop_assume!(!key.eq_ignore_ascii_case(OFFICIAL_UPDATE_ROOT_PUBKEY_HEX));
        let c = source(key, false, Some("2026-07-30T00:00:00Z".into()), true);
        prop_assert!(c.validate().is_ok());
        prop_assert!(!c.is_official(), "自定义源绝不显示官方身份");
    }
}
