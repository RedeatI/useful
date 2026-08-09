//! Property 测试：`.useful` 解包与 manifest 解析器（Section 八 fuzz/property 目标）。
//!
//! 覆盖不变量：
//! - 任意字节输入解析器绝不 panic（fail closed，只返回 Err）；
//! - `ensure_safe_relative` 接受的路径必然无穿越、无绝对前缀、无反斜杠；
//! - 安全解压成功时所有落盘文件必然在目标根内（ZIP Slip 不可能）；
//! - 解压后总大小超限必然报 `SizeExceeded`（解压炸弹上限不可绕过）；
//! - 合法 manifest 序列化→再解析 round-trip 等值。

use proptest::prelude::*;
use std::io::Write;
use std::path::Path;
use useful_plugin::manifest::{is_valid_plugin_id, Entry, EntryType, PluginManifest};
use useful_plugin::zip_safety::{
    ensure_safe_relative, extract_zip_safely, read_manifest_bytes, sha256_bytes, verify_sha256,
};
use useful_plugin::PluginError;

// ---------- 路径安全 ----------

/// 路径段生成：混入正常段、`.`、`..`、中文与前后缀变体。
fn path_segment() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-z][a-z0-9_-]{0,8}".prop_map(|s| s),
        Just("..".to_string()),
        Just(".".to_string()),
        Just("..a".to_string()),
        Just("a..".to_string()),
        Just("中文段".to_string()),
    ]
}

/// 路径生成：段拼接 + 少量原始恶意样本。
fn pathish() -> impl Strategy<Value = String> {
    prop_oneof![
        prop::collection::vec(path_segment(), 1..5).prop_map(|segs| segs.join("/")),
        Just("/etc/passwd".to_string()),
        Just("C:/Windows/system32".to_string()),
        Just("C:\\Windows\\x".to_string()),
        Just("dir\\file".to_string()),
        Just("".to_string()),
        Just("./".to_string()),
        Just("a//b".to_string()),
    ]
}

proptest! {
    /// 接受的路径必然是安全相对路径：无 `..` 段、无反斜杠、非绝对、拼接后仍在根内。
    #[test]
    fn accepted_paths_are_always_safe(name in pathish()) {
        // 不变量 0：绝不 panic
        let result = ensure_safe_relative(&name);
        if let Ok(normalized) = result {
            prop_assert!(!name.contains('\\'), "接受了含反斜杠路径: {name}");
            prop_assert!(!Path::new(&name).is_absolute(), "接受了绝对路径: {name}");
            // 归一化结果不含任何 ParentDir/RootDir/Prefix 组件
            for comp in normalized.components() {
                prop_assert!(
                    matches!(comp, std::path::Component::Normal(_)),
                    "归一化结果含非 Normal 组件: {name}"
                );
            }
            // 拼接到虚拟根后必然仍以根为前缀
            let root = Path::new("Z:/safe-root");
            prop_assert!(root.join(&normalized).starts_with(root));
        } else {
            // 拒绝路径必然命中一种已知危险特征或为空/退化路径。
            // 注意：Windows 上 "/etc" 的 is_absolute() 为 false，但产品代码按
            // RootDir 组件拒绝（比 std 更严格），oracle 需覆盖根前缀。
            let has_reason = name.is_empty()
                || name.contains('\\')
                || name.starts_with('/')
                || Path::new(&name).is_absolute()
                || Path::new(&name)
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir))
                || name.split('/').any(|s| s == "..")
                || name.split('/').all(|s| s.is_empty() || s == ".");
            prop_assert!(has_reason, "无明确理由拒绝了路径: {name}");
        }
    }

    /// 含 `..` 段的路径必然被拒绝（正向对偶）。
    #[test]
    fn traversal_segment_always_rejected(
        prefix in prop::collection::vec("[a-z]{1,6}", 0..3),
        suffix in prop::collection::vec("[a-z]{1,6}", 0..3),
    ) {
        let mut segs = prefix;
        segs.push("..".to_string());
        segs.extend(suffix);
        prop_assert!(ensure_safe_relative(&segs.join("/")).is_err());
    }
}

// ---------- .useful 解包（ZIP Slip / 炸弹上限） ----------

/// 在临时文件中构造包含任意条目名的 ZIP。
fn build_zip(entries: &[(String, Vec<u8>)]) -> tempfile::NamedTempFile {
    let file = tempfile::NamedTempFile::new().expect("临时文件");
    let mut zip = zip::ZipWriter::new(file.reopen().expect("reopen"));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in entries {
        // 条目名可能非法（这正是测试目标）；写入失败直接跳过该条目
        if zip.start_file(name.as_str(), opts).is_ok() {
            let _ = zip.write_all(content);
        }
    }
    zip.finish().expect("finish zip");
    file
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// 解压要么整体失败，要么所有落盘文件严格在目标根内，绝不 panic。
    #[test]
    fn extraction_never_escapes_dest_root(
        names in prop::collection::vec(pathish(), 1..6),
        content in prop::collection::vec(any::<u8>(), 0..256),
    ) {
        let entries: Vec<(String, Vec<u8>)> =
            names.into_iter().map(|n| (n, content.clone())).collect();
        let archive = build_zip(&entries);
        let workdir = tempfile::tempdir().expect("tempdir");
        let dest = workdir.path().join("out");

        let result = extract_zip_safely(archive.path(), &dest, 1024 * 1024);
        if result.is_ok() {
            // 成功 ⇒ 所有条目名都必须是安全相对路径
            for (name, _) in &entries {
                prop_assert!(
                    ensure_safe_relative(name.trim_end_matches('/')).is_ok(),
                    "解压成功但条目名不安全: {name}"
                );
            }
        }
        // 无论成败：workdir 下除 out 外不得出现任何逃逸文件
        let escaped: Vec<_> = std::fs::read_dir(workdir.path())
            .expect("read workdir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "out")
            .collect();
        prop_assert!(escaped.is_empty(), "检测到逃逸文件: {escaped:?}");
    }

    /// 解压后总大小超限必然返回 SizeExceeded（上限不可绕过）。
    #[test]
    fn uncompressed_limit_is_enforced(
        sizes in prop::collection::vec(1usize..1500, 1..5),
        limit in 256u64..2048,
    ) {
        let entries: Vec<(String, Vec<u8>)> = sizes
            .iter()
            .enumerate()
            .map(|(i, n)| (format!("f{i}.bin"), vec![0xA5u8; *n]))
            .collect();
        let archive = build_zip(&entries);
        let dest = tempfile::tempdir().expect("tempdir");

        let total: u64 = sizes.iter().map(|n| *n as u64).sum();
        let result = extract_zip_safely(archive.path(), dest.path(), limit);
        if total > limit {
            prop_assert!(
                matches!(result, Err(PluginError::SizeExceeded { .. })),
                "总大小 {total} 超限 {limit} 却未拒绝"
            );
        } else {
            prop_assert!(result.is_ok(), "总大小 {total} 未超限 {limit} 却失败");
        }
    }

    /// 任意字节流当作 .useful 读取 manifest：绝不 panic，只允许 Err 或合法字节。
    #[test]
    fn read_manifest_never_panics_on_garbage(bytes in prop::collection::vec(any::<u8>(), 0..2048)) {
        let mut file = tempfile::NamedTempFile::new().expect("临时文件");
        file.write_all(&bytes).expect("写入");
        let _ = read_manifest_bytes(file.path());
    }
}

// ---------- manifest 解析 ----------

fn valid_plugin_id_strategy() -> impl Strategy<Value = String> {
    prop::collection::vec("[a-z][a-z0-9-]{0,8}", 2..5).prop_map(|segs| segs.join("."))
}

fn valid_manifest_strategy() -> impl Strategy<Value = PluginManifest> {
    (
        valid_plugin_id_strategy(),
        "[a-zA-Z0-9 ]{1,64}",
        (0u8..50, 0u8..50, 0u8..50),
        "[a-z]{1,8}",
        prop::option::of(Just("assets/icon.png".to_string())),
    )
        .prop_map(|(id, name, (ma, mi, pa), page, icon)| PluginManifest {
            schema_version: 1,
            id,
            name,
            version: format!("{ma}.{mi}.{pa}"),
            description: String::new(),
            icon,
            entry: Entry {
                entry_type: EntryType::Web,
                path: format!("dist/{page}.html"),
                args: vec![],
            },
            contributes: Default::default(),
            permissions: vec![],
            platforms: vec!["windows-x64".to_string()],
            min_host_version: "0.1.0".to_string(),
        })
}

proptest! {
    /// 任意字节输入 manifest 解析绝不 panic。
    #[test]
    fn manifest_parse_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..2048)) {
        let _ = PluginManifest::parse_and_validate(&bytes);
    }

    /// 任意 JSON 值输入 manifest 解析绝不 panic（覆盖类型混淆分支）。
    #[test]
    fn manifest_parse_never_panics_on_json(
        v in prop::collection::vec(("[a-zA-Z]{1,10}", -1000i64..1000), 0..8)
    ) {
        let obj: serde_json::Map<String, serde_json::Value> = v
            .into_iter()
            .map(|(k, n)| (k, serde_json::json!(n)))
            .collect();
        let bytes = serde_json::to_vec(&serde_json::Value::Object(obj)).unwrap();
        let _ = PluginManifest::parse_and_validate(&bytes);
    }

    /// 合法 manifest 序列化后再解析必然成功且等值（round-trip）。
    #[test]
    fn manifest_roundtrip(m in valid_manifest_strategy()) {
        let bytes = serde_json::to_vec(&m).expect("序列化");
        let parsed = PluginManifest::parse_and_validate(&bytes)
            .map_err(|e| TestCaseError::fail(format!("round-trip 解析失败: {e}")))?;
        prop_assert_eq!(parsed, m);
    }

    /// is_valid_plugin_id 接受的 ID 必然符合文档化语法。
    #[test]
    fn accepted_ids_match_grammar(id in "[a-zA-Z0-9._\\-]{0,20}") {
        if is_valid_plugin_id(&id) {
            prop_assert!(id.len() <= 128);
            let segs: Vec<&str> = id.split('.').collect();
            prop_assert!(segs.len() >= 2);
            for seg in segs {
                prop_assert!(!seg.is_empty());
                prop_assert!(seg.chars().next().unwrap().is_ascii_alphabetic());
                prop_assert!(seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
            }
        }
    }
}

// ---------- 摘要 ----------

proptest! {
    /// sha256_bytes 恒为 64 位小写 hex；verify_sha256 对期望值大小写不敏感。
    #[test]
    fn sha256_output_shape_and_case_insensitive_verify(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
        let digest = sha256_bytes(&bytes);
        prop_assert_eq!(digest.len(), 64);
        prop_assert!(digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));

        let mut file = tempfile::NamedTempFile::new().expect("临时文件");
        file.write_all(&bytes).expect("写入");
        prop_assert!(verify_sha256(file.path(), &digest.to_uppercase()).is_ok());
        // 翻转首字符必然验证失败
        let mut tampered = digest.clone().into_bytes();
        tampered[0] = if tampered[0] == b'0' { b'1' } else { b'0' };
        prop_assert!(verify_sha256(file.path(), std::str::from_utf8(&tampered).unwrap()).is_err());
    }
}
