//! TUF 风格 metadata 验证链（客户端侧）。
//!
//! 通过 `TrustBackend` trait 隔离具体实现：`BuiltinTufBackend` 为 6C 内置实现，
//! 后续可替换为通过 TUF conformance 的第三方 crate 而不影响调用方。
//! 密码学原语全部来自 ed25519-dalek / sha2（绝不自行实现）；本模块只实现
//! TUF 规则：阈值签名、过期、回滚防护、hash+length 钉住、root 轮换链、
//! consistent snapshot。所有失败一律 fail closed。

use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// 单个 metadata 文件大小上限。
pub const MAX_METADATA_SIZE: usize = 8 * 1024 * 1024;
const SPEC_VERSION: &str = "1.0.0";

#[derive(Debug, thiserror::Error)]
pub enum TufError {
    #[error("metadata 结构非法: {0}")]
    Malformed(String),
    #[error("{0}: 签名不足（{1}/{2}）——拒绝")]
    ThresholdNotMet(String, u32, u32),
    #[error("{0}: metadata 已过期（{1}）——拒绝（防冻结攻击）")]
    Expired(String, String),
    #[error("{0}: 摘要或长度不符——拒绝")]
    HashMismatch(String),
    #[error("{0}: 版本不符——拒绝（防回滚）")]
    VersionMismatch(String),
    #[error("{0}: metadata 版本从 {1} 回滚到 {2}——拒绝")]
    Rollback(String, u64, u64),
    #[error("缺少 metadata: {0}")]
    Missing(String),
    #[error("超出限制: {0}")]
    LimitExceeded(String),
}

/// metadata 文件提供者（目录、HTTP 缓存或内存均可实现）。
pub trait MetadataSource {
    fn get(&self, name: &str) -> Option<Vec<u8>>;
}

impl MetadataSource for BTreeMap<String, Vec<u8>> {
    fn get(&self, name: &str) -> Option<Vec<u8>> {
        BTreeMap::get(self, name).cloned()
    }
}

/// 目录形式的 metadata 源（metadata/ 子目录）。
pub struct DirSource(pub std::path::PathBuf);

impl MetadataSource for DirSource {
    fn get(&self, name: &str) -> Option<Vec<u8>> {
        // 文件名只允许受控字符，防路径穿越
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        {
            return None;
        }
        std::fs::read(self.0.join(name)).ok()
    }
}

/// 已验证的 target 条目。
#[derive(Debug, Clone)]
pub struct TargetInfo {
    pub length: u64,
    pub sha256: String,
    pub custom: Option<Value>,
}

/// 验证链输出。
#[derive(Debug)]
pub struct VerifiedTuf {
    pub root_version: u64,
    pub timestamp_version: u64,
    pub snapshot_version: u64,
    pub targets_version: u64,
    pub root_sha256: String,
    pub timestamp_sha256: String,
    pub snapshot_sha256: String,
    pub targets_sha256: String,
    /// 文件名 → 制品信息（consistent 路径为 `<sha256>.<文件名>`）。
    pub targets: BTreeMap<String, TargetInfo>,
}

/// 信任后端抽象：隔离具体 TUF 实现。
pub trait TrustBackend {
    fn verify(
        &self,
        src: &dyn MetadataSource,
        trusted_root: &[u8],
        now_rfc3339: &str,
    ) -> Result<VerifiedTuf, TufError>;
}

/// 6C 内置实现。
pub struct BuiltinTufBackend;

// ---------- canonical JSON（OLPC，与 CLI cjson.mjs 一致） ----------

fn canonical_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out.push('"');
}

/// OLPC canonical JSON 序列化（TUF 签名输入）。仅允许整数。
pub fn canonical_json(v: &Value) -> Result<String, TufError> {
    let mut out = String::new();
    write_canonical(&mut out, v)?;
    Ok(out)
}

fn write_canonical(out: &mut String, v: &Value) -> Result<(), TufError> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if n.is_f64() {
                return Err(TufError::Malformed("canonical JSON 仅允许整数".into()));
            }
            out.push_str(&n.to_string());
        }
        Value::String(s) => canonical_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(out, item)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_string(out, k);
                out.push(':');
                write_canonical(out, &map[*k])?;
            }
            out.push('}');
        }
    }
    Ok(())
}

// ---------- 结构解析 ----------

#[derive(Debug, Deserialize)]
struct TufDoc {
    signatures: Vec<TufSignature>,
    signed: Value,
}

#[derive(Debug, Deserialize)]
struct TufSignature {
    keyid: String,
    sig: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RoleDef {
    keyids: Vec<String>,
    threshold: u32,
}

fn parse_doc(name: &str, bytes: &[u8]) -> Result<TufDoc, TufError> {
    if bytes.len() > MAX_METADATA_SIZE {
        return Err(TufError::LimitExceeded(format!("{name} 超过大小上限")));
    }
    serde_json::from_slice(bytes).map_err(|e| TufError::Malformed(format!("{name}: {e}")))
}

fn signed_str<'a>(signed: &'a Value, key: &str, ctx: &str) -> Result<&'a str, TufError> {
    signed
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| TufError::Malformed(format!("{ctx}: 缺少 {key}")))
}

fn signed_u64(signed: &Value, key: &str, ctx: &str) -> Result<u64, TufError> {
    signed
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| TufError::Malformed(format!("{ctx}: 缺少 {key}")))
}

fn signed_version(signed: &Value, ctx: &str) -> Result<u64, TufError> {
    let version = signed_u64(signed, "version", ctx)?;
    if version == 0 {
        return Err(TufError::Malformed(format!("{ctx}: version 必须为正整数")));
    }
    Ok(version)
}

/// root.signed 中的 keys（keyid → 公钥 hex）。
fn root_keys(root_signed: &Value) -> Result<BTreeMap<String, String>, TufError> {
    let keys = root_signed
        .get("keys")
        .and_then(Value::as_object)
        .ok_or_else(|| TufError::Malformed("root: 缺少 keys".into()))?;
    let mut out = BTreeMap::new();
    for (keyid, k) in keys {
        let keytype = k.get("keytype").and_then(Value::as_str).unwrap_or("");
        if keytype != "ed25519" {
            return Err(TufError::Malformed(format!("不支持的 keytype: {keytype}")));
        }
        let public = k
            .pointer("/keyval/public")
            .and_then(Value::as_str)
            .ok_or_else(|| TufError::Malformed("key 缺少 keyval.public".into()))?;
        out.insert(keyid.clone(), public.to_string());
    }
    Ok(out)
}

fn role_def(root_signed: &Value, role: &str) -> Result<RoleDef, TufError> {
    let v = root_signed
        .pointer(&format!("/roles/{role}"))
        .ok_or_else(|| TufError::Malformed(format!("root: 缺少角色 {role}")))?;
    serde_json::from_value(v.clone()).map_err(|e| TufError::Malformed(format!("角色 {role}: {e}")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TufVersions {
    pub root: u64,
    pub timestamp: u64,
    pub snapshot: u64,
    pub targets: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TufMetadataState {
    pub versions: TufVersions,
    pub root_sha256: String,
    pub timestamp_sha256: String,
    pub snapshot_sha256: String,
    pub targets_sha256: String,
}

impl VerifiedTuf {
    pub fn versions(&self) -> TufVersions {
        TufVersions {
            root: self.root_version,
            timestamp: self.timestamp_version,
            snapshot: self.snapshot_version,
            targets: self.targets_version,
        }
    }

    pub fn metadata_state(&self) -> TufMetadataState {
        TufMetadataState {
            versions: self.versions(),
            root_sha256: self.root_sha256.clone(),
            timestamp_sha256: self.timestamp_sha256.clone(),
            snapshot_sha256: self.snapshot_sha256.clone(),
            targets_sha256: self.targets_sha256.clone(),
        }
    }
}

pub fn ensure_monotonic_versions(
    last: TufVersions,
    candidate: TufVersions,
) -> Result<(), TufError> {
    for (role, old, new) in [
        ("root", last.root, candidate.root),
        ("timestamp", last.timestamp, candidate.timestamp),
        ("snapshot", last.snapshot, candidate.snapshot),
        ("targets", last.targets, candidate.targets),
    ] {
        if new < old {
            return Err(TufError::Rollback(role.into(), old, new));
        }
    }
    Ok(())
}

/// Root metadata is itself attacker-controlled input.  Reject semantically
/// impossible role definitions before using any threshold in a trust decision.
fn validate_root_roles(
    root_signed: &Value,
    keys: &BTreeMap<String, String>,
) -> Result<(), TufError> {
    for role_name in ["root", "timestamp", "snapshot", "targets"] {
        let role = role_def(root_signed, role_name)?;
        if role.keyids.is_empty() {
            return Err(TufError::Malformed(format!(
                "root: 角色 {role_name} 的 keyids 不能为空"
            )));
        }
        let unique: BTreeSet<&str> = role.keyids.iter().map(String::as_str).collect();
        if unique.len() != role.keyids.len() {
            return Err(TufError::Malformed(format!(
                "root: 角色 {role_name} 含重复 keyid"
            )));
        }
        if let Some(unknown) = unique.iter().find(|keyid| !keys.contains_key(**keyid)) {
            return Err(TufError::Malformed(format!(
                "root: 角色 {role_name} 引用了未知 keyid {unknown}"
            )));
        }
        if role.threshold == 0 || role.threshold as usize > unique.len() {
            return Err(TufError::Malformed(format!(
                "root: 角色 {role_name} 的 threshold {} 超出授权唯一密钥数 {}",
                role.threshold,
                unique.len()
            )));
        }
    }
    Ok(())
}

/// Parse the deliberately narrow TUF timestamp profile used by Useful:
/// exactly `YYYY-MM-DDTHH:MM:SSZ`.  Offsets, fractions, leap seconds and
/// normalization of invalid dates are rejected instead of reinterpreted.
fn parse_canonical_utc_seconds(value: &str) -> Result<i64, TufError> {
    let b = value.as_bytes();
    if b.len() != 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'Z'
        || b.iter()
            .enumerate()
            .any(|(i, c)| !matches!(i, 4 | 7 | 10 | 13 | 16 | 19) && !c.is_ascii_digit())
    {
        return Err(TufError::Malformed(format!(
            "expires 不是 canonical UTC RFC3339 秒精度: {value}"
        )));
    }
    let number = |start: usize, end: usize| -> i64 {
        b[start..end]
            .iter()
            .fold(0, |n, digit| n * 10 + i64::from(digit - b'0'))
    };
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let hour = number(11, 13);
    let minute = number(14, 16);
    let second = number(17, 19);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&month)
        || day < 1
        || day > month_days[(month - 1) as usize]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(TufError::Malformed(format!(
            "expires 日期或时间分量非法: {value}"
        )));
    }
    // Gregorian civil date -> days from Unix epoch. With a four-digit year,
    // every intermediate and final value is comfortably inside i64.
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let yoe = adjusted_year.rem_euclid(400);
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * adjusted_month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Ok(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

// ---------- 验签 ----------

fn verify_signature(public_hex: &str, message: &[u8], sig_hex: &str) -> bool {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let Ok(pk_bytes) = hex::decode(public_hex) else {
        return false;
    };
    let Ok(pk_arr) = <[u8; 32]>::try_from(pk_bytes.as_slice()) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk_arr) else {
        return false;
    };
    let Ok(sig_bytes) = hex::decode(sig_hex) else {
        return false;
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes.as_slice()) else {
        return false;
    };
    vk.verify(message, &Signature::from_bytes(&sig_arr)).is_ok()
}

/// 验证单个角色文档：类型、spec 版本、阈值签名（keyid 去重）、过期。
fn verify_role_doc(
    doc: &TufDoc,
    keys: &BTreeMap<String, String>,
    role: &RoleDef,
    expected_type: &str,
    now_rfc3339: &str,
    check_expiry: bool,
) -> Result<Value, TufError> {
    let signed = &doc.signed;
    let t = signed_str(signed, "_type", expected_type)?;
    if t != expected_type {
        return Err(TufError::Malformed(format!(
            "{expected_type}: _type 不符（{t}）"
        )));
    }
    if signed_str(signed, "spec_version", expected_type)? != SPEC_VERSION {
        return Err(TufError::Malformed(format!(
            "{expected_type}: spec_version 不支持"
        )));
    }
    let message = canonical_json(signed)?;
    let mut seen: Vec<&str> = Vec::new();
    let mut valid = 0u32;
    for s in &doc.signatures {
        if !role.keyids.iter().any(|k| k == &s.keyid) || seen.contains(&s.keyid.as_str()) {
            continue;
        }
        let Some(public_hex) = keys.get(&s.keyid) else {
            continue;
        };
        if verify_signature(public_hex, message.as_bytes(), &s.sig) {
            seen.push(&s.keyid);
            valid += 1;
        }
    }
    if valid < role.threshold {
        return Err(TufError::ThresholdNotMet(
            expected_type.into(),
            valid,
            role.threshold,
        ));
    }
    if check_expiry {
        let expires = signed_str(signed, "expires", expected_type)?;
        let expires_instant = parse_canonical_utc_seconds(expires)?;
        let now_instant = parse_canonical_utc_seconds(now_rfc3339).map_err(|_| {
            TufError::Malformed(format!(
                "调用方当前时间不是 canonical UTC RFC3339: {now_rfc3339}"
            ))
        })?;
        if expires_instant <= now_instant {
            return Err(TufError::Expired(expected_type.into(), expires.into()));
        }
    }
    Ok(signed.clone())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// 校验 snapshot/timestamp 的 meta 条目（hash + length）。
fn check_meta_entry(name: &str, bytes: &[u8], entry: &Value) -> Result<u64, TufError> {
    let length = signed_u64(entry, "length", name)?;
    let sha = entry
        .pointer("/hashes/sha256")
        .and_then(Value::as_str)
        .ok_or_else(|| TufError::Malformed(format!("{name}: 缺少 hashes.sha256")))?;
    if bytes.len() as u64 != length || !sha256_hex(bytes).eq_ignore_ascii_case(sha) {
        return Err(TufError::HashMismatch(name.into()));
    }
    signed_version(entry, name)
}

impl TrustBackend for BuiltinTufBackend {
    /// 完整验证链：信任锚 root → root 轮换链（新旧双阈值）→ timestamp →
    /// snapshot（hash/length/版本）→ targets → 输出 target 清单。
    fn verify(
        &self,
        src: &dyn MetadataSource,
        trusted_root: &[u8],
        now_rfc3339: &str,
    ) -> Result<VerifiedTuf, TufError> {
        // 1) 信任锚（调用方持有的 1.root.json 字节，来源于用户确认时钉住的指纹）
        let anchor = parse_doc("root", trusted_root)?;
        let mut root_sha256 = sha256_hex(trusted_root);
        let mut keys = root_keys(&anchor.signed)?;
        validate_root_roles(&anchor.signed, &keys)?;
        let mut root_role = role_def(&anchor.signed, "root")?;
        // An expired trusted root may still authorize a recovery chain. TUF
        // root expiry is enforced only after the complete consecutive chain
        // has passed both the old and new root thresholds.
        let mut root_signed =
            verify_role_doc(&anchor, &keys, &root_role, "root", now_rfc3339, false)?;
        if root_signed.get("consistent_snapshot") != Some(&Value::Bool(true)) {
            return Err(TufError::Malformed(
                "root: 必须启用 consistent_snapshot".into(),
            ));
        }

        // 2) root 轮换链
        let mut version = signed_version(&root_signed, "root")?;
        loop {
            let next_version = version
                .checked_add(1)
                .ok_or_else(|| TufError::Malformed("root: version 溢出".into()))?;
            let name = format!("{next_version}.root.json");
            let Some(bytes) = src.get(&name) else { break };
            let next = parse_doc(&name, &bytes)?;
            // 旧 root 阈值
            verify_role_doc(&next, &keys, &root_role, "root", now_rfc3339, false)?;
            // 新 root 自身阈值
            let next_keys = root_keys(&next.signed)?;
            validate_root_roles(&next.signed, &next_keys)?;
            let next_role = role_def(&next.signed, "root")?;
            root_signed =
                verify_role_doc(&next, &next_keys, &next_role, "root", now_rfc3339, false)?;
            if root_signed.get("consistent_snapshot") != Some(&Value::Bool(true)) {
                return Err(TufError::Malformed(
                    "轮换后的 root 必须继续启用 consistent_snapshot".into(),
                ));
            }
            if signed_version(&root_signed, "root")? != next_version {
                return Err(TufError::VersionMismatch("root".into()));
            }
            keys = next_keys;
            root_role = next_role;
            root_sha256 = sha256_hex(&bytes);
            version = next_version;
        }
        // Only the final root is authoritative for freeze protection.
        // Signatures were already checked above; apply the strict canonical
        // timestamp parser to the authoritative final root.
        let expires = signed_str(&root_signed, "expires", "root")?;
        let expires_instant = parse_canonical_utc_seconds(expires)?;
        let now_instant = parse_canonical_utc_seconds(now_rfc3339).map_err(|_| {
            TufError::Malformed(format!(
                "调用方当前时间不是 canonical UTC RFC3339: {now_rfc3339}"
            ))
        })?;
        if expires_instant <= now_instant {
            return Err(TufError::Expired("root".into(), expires.into()));
        }

        // 3) timestamp
        let ts_bytes = src
            .get("timestamp.json")
            .ok_or_else(|| TufError::Missing("timestamp.json".into()))?;
        let ts = parse_doc("timestamp", &ts_bytes)?;
        let ts_role = role_def(&root_signed, "timestamp")?;
        let ts_signed = verify_role_doc(&ts, &keys, &ts_role, "timestamp", now_rfc3339, true)?;
        let timestamp_version = signed_version(&ts_signed, "timestamp")?;

        // 4) snapshot（consistent 文件名 + hash/length + 版本一致）
        let snap_entry = ts_signed
            .pointer("/meta/snapshot.json")
            .ok_or_else(|| TufError::Malformed("timestamp: 缺少 snapshot meta".into()))?
            .clone();
        let snap_version = signed_version(&snap_entry, "snapshot")?;
        let snap_name = format!("{snap_version}.snapshot.json");
        let snap_bytes = src
            .get(&snap_name)
            .ok_or_else(|| TufError::Missing(snap_name.clone()))?;
        check_meta_entry("snapshot", &snap_bytes, &snap_entry)?;
        let snap = parse_doc("snapshot", &snap_bytes)?;
        let snap_role = role_def(&root_signed, "snapshot")?;
        let snap_signed = verify_role_doc(&snap, &keys, &snap_role, "snapshot", now_rfc3339, true)?;
        if signed_version(&snap_signed, "snapshot")? != snap_version {
            return Err(TufError::VersionMismatch("snapshot".into()));
        }

        // 5) targets
        let tgt_entry = snap_signed
            .pointer("/meta/targets.json")
            .ok_or_else(|| TufError::Malformed("snapshot: 缺少 targets meta".into()))?
            .clone();
        let tgt_version = signed_version(&tgt_entry, "targets")?;
        let tgt_name = format!("{tgt_version}.targets.json");
        let tgt_bytes = src
            .get(&tgt_name)
            .ok_or_else(|| TufError::Missing(tgt_name.clone()))?;
        check_meta_entry("targets", &tgt_bytes, &tgt_entry)?;
        let tgt = parse_doc("targets", &tgt_bytes)?;
        let tgt_role = role_def(&root_signed, "targets")?;
        let tgt_signed = verify_role_doc(&tgt, &keys, &tgt_role, "targets", now_rfc3339, true)?;
        if signed_version(&tgt_signed, "targets")? != tgt_version {
            return Err(TufError::VersionMismatch("targets".into()));
        }

        // 6) target 清单
        let mut targets = BTreeMap::new();
        let map = tgt_signed
            .get("targets")
            .and_then(Value::as_object)
            .ok_or_else(|| TufError::Malformed("targets: 缺少 targets 表".into()))?;
        for (name, info) in map {
            let length = signed_u64(info, "length", "target")?;
            let sha = info
                .pointer("/hashes/sha256")
                .and_then(Value::as_str)
                .ok_or_else(|| TufError::Malformed(format!("target {name}: 缺少 sha256")))?;
            targets.insert(
                name.clone(),
                TargetInfo {
                    length,
                    sha256: sha.to_lowercase(),
                    custom: info.get("custom").cloned(),
                },
            );
        }
        Ok(VerifiedTuf {
            root_version: version,
            timestamp_version,
            snapshot_version: snap_version,
            targets_version: tgt_version,
            root_sha256,
            timestamp_sha256: sha256_hex(&ts_bytes),
            snapshot_sha256: sha256_hex(&snap_bytes),
            targets_sha256: sha256_hex(&tgt_bytes),
            targets,
        })
    }
}

/// 校验下载到的 target 字节与 TUF 声明一致（安装前的最终依据）。
pub fn verify_target_bytes(info: &TargetInfo, bytes: &[u8]) -> Result<(), TufError> {
    if bytes.len() as u64 != info.length || !sha256_hex(bytes).eq_ignore_ascii_case(&info.sha256) {
        return Err(TufError::HashMismatch("target".into()));
    }
    Ok(())
}

/// 当前 UTC 时间的 RFC3339（秒精度），供验证链比较过期时间。
pub fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // civil-from-days（Howard Hinnant 算法）
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    const NOW: &str = "2026-08-01T00:00:00Z";
    const LATER: &str = "2036-01-01T00:00:00Z";

    struct Key {
        keyid: String,
        public_hex: String,
        sk: SigningKey,
    }

    fn make_key(seed: u8) -> Key {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let public_hex = hex::encode(sk.verifying_key().to_bytes());
        let key_obj = json!({
            "keytype": "ed25519",
            "scheme": "ed25519",
            "keyval": { "public": public_hex }
        });
        let keyid = sha256_hex(canonical_json(&key_obj).unwrap().as_bytes());
        Key {
            keyid,
            public_hex,
            sk,
        }
    }

    fn sign_doc(signed: Value, keys: &[&Key]) -> Vec<u8> {
        let msg = canonical_json(&signed).unwrap();
        let sigs: Vec<Value> = keys
            .iter()
            .map(|k| {
                json!({
                    "keyid": k.keyid,
                    "sig": hex::encode(k.sk.sign(msg.as_bytes()).to_bytes())
                })
            })
            .collect();
        serde_json::to_vec(&json!({ "signatures": sigs, "signed": signed })).unwrap()
    }

    fn root_signed(version: u64, root: &Key, other: &Key) -> Value {
        json!({
            "_type": "root",
            "spec_version": "1.0.0",
            "consistent_snapshot": true,
            "version": version,
            "expires": LATER,
            "keys": {
                root.keyid.clone(): { "keytype": "ed25519", "scheme": "ed25519", "keyval": { "public": root.public_hex } },
                other.keyid.clone(): { "keytype": "ed25519", "scheme": "ed25519", "keyval": { "public": other.public_hex } }
            },
            "roles": {
                "root": { "keyids": [root.keyid], "threshold": 1 },
                "targets": { "keyids": [other.keyid], "threshold": 1 },
                "snapshot": { "keyids": [other.keyid], "threshold": 1 },
                "timestamp": { "keyids": [other.keyid], "threshold": 1 }
            }
        })
    }

    /// 构造一套完整 metadata（root 由 seed 1，其余角色 seed 2 签名）。
    fn build_repo(target_bytes: &[u8]) -> (Vec<u8>, BTreeMap<String, Vec<u8>>, Key, Key) {
        let root = make_key(1);
        let online = make_key(2);
        let root_bytes = sign_doc(root_signed(1, &root, &online), &[&root]);

        let targets_signed = json!({
            "_type": "targets", "spec_version": "1.0.0", "version": 1, "expires": LATER,
            "targets": {
                "tool.useful": {
                    "length": target_bytes.len(),
                    "hashes": { "sha256": sha256_hex(target_bytes) },
                    "custom": { "toolId": "com.x.tool" }
                }
            }
        });
        let targets_doc = sign_doc(targets_signed, &[&online]);
        let snapshot_signed = json!({
            "_type": "snapshot", "spec_version": "1.0.0", "version": 1, "expires": LATER,
            "meta": { "targets.json": {
                "version": 1, "length": targets_doc.len(),
                "hashes": { "sha256": sha256_hex(&targets_doc) }
            } }
        });
        let snapshot_doc = sign_doc(snapshot_signed, &[&online]);
        let timestamp_signed = json!({
            "_type": "timestamp", "spec_version": "1.0.0", "version": 1, "expires": LATER,
            "meta": { "snapshot.json": {
                "version": 1, "length": snapshot_doc.len(),
                "hashes": { "sha256": sha256_hex(&snapshot_doc) }
            } }
        });
        let timestamp_doc = sign_doc(timestamp_signed, &[&online]);

        let mut files = BTreeMap::new();
        files.insert("1.targets.json".to_string(), targets_doc);
        files.insert("1.snapshot.json".to_string(), snapshot_doc);
        files.insert("timestamp.json".to_string(), timestamp_doc);
        (root_bytes, files, root, online)
    }

    #[test]
    fn valid_chain_verifies_and_lists_targets() {
        let (root, files, _, _) = build_repo(b"PAYLOAD");
        let v = BuiltinTufBackend.verify(&files, &root, NOW).unwrap();
        assert_eq!(v.root_version, 1);
        assert_eq!(v.timestamp_version, 1);
        assert_eq!(v.snapshot_version, 1);
        assert_eq!(v.targets_version, 1);
        let t = &v.targets["tool.useful"];
        verify_target_bytes(t, b"PAYLOAD").unwrap();
        // 篡改的 target 字节被拒绝
        assert!(verify_target_bytes(t, b"PAYLOAD-EVIL").is_err());
    }

    #[test]
    fn every_top_level_role_definition_is_semantically_validated() {
        let root = make_key(1);
        let online = make_key(2);
        for role_name in ["root", "timestamp", "snapshot", "targets"] {
            let baseline = root_signed(1, &root, &online);
            let keys = root_keys(&baseline).unwrap();

            let mut empty = baseline.clone();
            empty["roles"][role_name]["keyids"] = json!([]);
            assert!(validate_root_roles(&empty, &keys).is_err(), "{role_name}");

            let keyid = baseline["roles"][role_name]["keyids"][0]
                .as_str()
                .unwrap()
                .to_string();
            let mut duplicate = baseline.clone();
            duplicate["roles"][role_name]["keyids"] = json!([keyid.clone(), keyid]);
            assert!(
                validate_root_roles(&duplicate, &keys).is_err(),
                "{role_name}"
            );

            let mut unknown = baseline.clone();
            unknown["roles"][role_name]["keyids"] = json!(["unknown-key"]);
            assert!(validate_root_roles(&unknown, &keys).is_err(), "{role_name}");

            let mut zero = baseline.clone();
            zero["roles"][role_name]["threshold"] = json!(0);
            assert!(validate_root_roles(&zero, &keys).is_err(), "{role_name}");

            let mut excessive = baseline.clone();
            excessive["roles"][role_name]["threshold"] = json!(2);
            assert!(
                validate_root_roles(&excessive, &keys).is_err(),
                "{role_name}"
            );
        }
    }

    #[test]
    fn expires_accepts_only_canonical_utc_seconds_and_compares_instants() {
        assert_eq!(
            parse_canonical_utc_seconds("1970-01-01T00:00:00Z").unwrap(),
            0
        );
        assert!(parse_canonical_utc_seconds("2028-02-29T23:59:59Z").is_ok());
        for invalid in [
            "2026-08-01T00:00:00+00:00",
            "2026-08-01T08:00:00+08:00",
            "2026-08-01T00:00:00.0Z",
            "2026-8-01T00:00:00Z",
            "2026-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:00:60Z",
            "10000-01-01T00:00:00Z",
        ] {
            assert!(parse_canonical_utc_seconds(invalid).is_err(), "{invalid}");
        }
        let (root, files, _, _) = build_repo(b"PAYLOAD");
        assert!(matches!(
            BuiltinTufBackend.verify(&files, &root, LATER),
            Err(TufError::Expired(_, _))
        ));
    }

    #[test]
    fn persisted_versions_reject_each_role_rollback_but_allow_equal_versions() {
        let last = TufVersions {
            root: 4,
            timestamp: 9,
            snapshot: 8,
            targets: 7,
        };
        assert!(ensure_monotonic_versions(last, last).is_ok());
        for candidate in [
            TufVersions { root: 3, ..last },
            TufVersions {
                timestamp: 8,
                ..last
            },
            TufVersions {
                snapshot: 7,
                ..last
            },
            TufVersions { targets: 6, ..last },
        ] {
            assert!(matches!(
                ensure_monotonic_versions(last, candidate),
                Err(TufError::Rollback(_, _, _))
            ));
        }
    }

    #[test]
    fn tampered_metadata_rejected() {
        let (root, mut files, _, _) = build_repo(b"PAYLOAD");
        // 篡改 targets metadata（未重签）→ snapshot hash 钉住拒绝
        let mut doc: Value = serde_json::from_slice(&files["1.targets.json"]).unwrap();
        doc["signed"]["targets"]["tool.useful"]["hashes"]["sha256"] = json!("ff".repeat(32));
        files.insert("1.targets.json".into(), serde_json::to_vec(&doc).unwrap());
        let err = BuiltinTufBackend.verify(&files, &root, NOW).unwrap_err();
        assert!(matches!(err, TufError::HashMismatch(_)));
    }

    #[test]
    fn attacker_signature_rejected() {
        let (root, mut files, _, _) = build_repo(b"PAYLOAD");
        // 攻击者重签 timestamp（非授权密钥）
        let attacker = make_key(9);
        let doc: Value = serde_json::from_slice(&files["timestamp.json"]).unwrap();
        let resigned = sign_doc(doc["signed"].clone(), &[&attacker]);
        files.insert("timestamp.json".into(), resigned);
        let err = BuiltinTufBackend.verify(&files, &root, NOW).unwrap_err();
        assert!(matches!(err, TufError::ThresholdNotMet(_, 0, 1)));
    }

    #[test]
    fn expired_metadata_rejected_freeze_protection() {
        let (root, files, _, _) = build_repo(b"PAYLOAD");
        let err = BuiltinTufBackend
            .verify(&files, &root, "2099-01-01T00:00:00Z")
            .unwrap_err();
        assert!(matches!(err, TufError::Expired(_, _)));
    }

    #[test]
    fn root_rotation_requires_old_and_new_signatures() {
        let (root_bytes, mut files, old_root, online) = build_repo(b"PAYLOAD");
        let new_root = make_key(3);
        // 合法轮换：旧+新交叉签名
        let v2 = {
            let mut signed = root_signed(2, &new_root, &online);
            signed["keys"][old_root.keyid.clone()] = json!({
                "keytype": "ed25519", "scheme": "ed25519",
                "keyval": { "public": old_root.public_hex }
            });
            signed
        };
        files.insert(
            "2.root.json".into(),
            sign_doc(v2.clone(), &[&old_root, &new_root]),
        );
        let ok = BuiltinTufBackend.verify(&files, &root_bytes, NOW).unwrap();
        assert_eq!(ok.root_version, 2);

        // 新 root 即使交叉签名有效，也不得关闭 consistent snapshots。
        let mut inconsistent = v2.clone();
        inconsistent["consistent_snapshot"] = json!(false);
        files.insert(
            "2.root.json".into(),
            sign_doc(inconsistent, &[&old_root, &new_root]),
        );
        let err = BuiltinTufBackend
            .verify(&files, &root_bytes, NOW)
            .unwrap_err();
        assert!(matches!(err, TufError::Malformed(_)));

        // 伪造轮换：仅新钥签名（无旧 root 授权）→ 拒绝
        files.insert("2.root.json".into(), sign_doc(v2, &[&new_root]));
        let err = BuiltinTufBackend
            .verify(&files, &root_bytes, NOW)
            .unwrap_err();
        assert!(matches!(err, TufError::ThresholdNotMet(_, _, _)));
    }

    #[test]
    fn root_recovery_checks_expiry_only_on_final_root() {
        let (_root_bytes, mut files, old_root, online) = build_repo(b"PAYLOAD");
        let mut expired_anchor = root_signed(1, &old_root, &online);
        expired_anchor["expires"] = json!("2020-01-01T00:00:00Z");
        let expired_anchor = sign_doc(expired_anchor, &[&old_root]);

        let new_root = make_key(3);
        let mut final_signed = root_signed(2, &new_root, &online);
        final_signed["keys"][old_root.keyid.clone()] = json!({
            "keytype": "ed25519", "scheme": "ed25519",
            "keyval": { "public": old_root.public_hex }
        });
        files.insert(
            "2.root.json".into(),
            sign_doc(final_signed.clone(), &[&old_root, &new_root]),
        );
        assert_eq!(
            BuiltinTufBackend
                .verify(&files, &expired_anchor, NOW)
                .unwrap()
                .root_version,
            2
        );

        final_signed["expires"] = json!("2020-01-01T00:00:00Z");
        files.insert(
            "2.root.json".into(),
            sign_doc(final_signed, &[&old_root, &new_root]),
        );
        assert!(matches!(
            BuiltinTufBackend.verify(&files, &expired_anchor, NOW),
            Err(TufError::Expired(role, _)) if role == "root"
        ));
    }

    #[test]
    fn interop_verifies_cli_generated_static_example() {
        // 跨语言互操作：验证 useful source CLI（Node）生成的 repositories/static-example
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("repositories")
            .join("static-example");
        let metadata_dir = repo_root.join("metadata");
        let trusted_root = std::fs::read(metadata_dir.join("1.root.json")).unwrap();
        let src = DirSource(metadata_dir);
        let v = BuiltinTufBackend
            .verify(&src, &trusted_root, &now_rfc3339())
            .unwrap();
        assert_eq!(v.root_version, 1);
        assert_eq!(v.targets.len(), 1);
        // target 文件本体也能通过 hash+length 校验
        let (name, info) = v.targets.iter().next().unwrap();
        let bytes = std::fs::read(
            repo_root
                .join("targets")
                .join(format!("{}.{}", info.sha256, name)),
        )
        .unwrap();
        verify_target_bytes(info, &bytes).unwrap();
        // 篡改字节被拒绝
        let mut evil = bytes.clone();
        evil.push(0);
        assert!(verify_target_bytes(info, &evil).is_err());
    }

    #[test]
    fn now_rfc3339_format_is_lexicographically_comparable() {
        let now = now_rfc3339();
        assert_eq!(now.len(), 20);
        assert!(now.as_str() > "2024-01-01T00:00:00Z");
        assert!(now.as_str() < "2999-01-01T00:00:00Z");
    }

    // ---------- property / fuzz（Section 八 目标 "TUF metadata"） ----------
    use proptest::prelude::*;

    /// 无浮点的任意 JSON 生成器（canonical JSON 仅允许整数）。
    fn arb_intjson() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<i64>().prop_map(|n| json!(n)),
            "[a-zA-Z0-9 ]{0,12}".prop_map(Value::String),
        ];
        leaf.prop_recursive(3, 16, 5, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
                prop::collection::hash_map("[a-z]{1,6}", inner, 0..4)
                    .prop_map(|m| Value::Object(m.into_iter().collect())),
            ]
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        /// canonical_json 对任意（无浮点）JSON 绝不 panic，且幂等
        /// （输出再解析再规范化得同一字符串）——签名输入必须稳定。
        #[test]
        fn canonical_json_idempotent(v in arb_intjson()) {
            let s1 = canonical_json(&v).expect("整数 JSON 应可规范化");
            let reparsed: Value = serde_json::from_str(&s1).unwrap();
            let s2 = canonical_json(&reparsed).unwrap();
            prop_assert_eq!(s1, s2);
        }

        /// 含真实浮点的 JSON 必被拒绝（防签名输入歧义）。
        #[test]
        fn canonical_json_rejects_floats(f in prop::num::f64::NORMAL) {
            let v = json!({ "x": f });
            if v["x"].is_f64() {
                prop_assert!(canonical_json(&v).is_err());
            }
        }

        /// verify 对任意 metadata 源内容 + 任意信任锚绝不 panic（fail closed）。
        #[test]
        fn verify_never_panics(
            files in prop::collection::vec(
                ("[a-z0-9.]{1,20}", prop::collection::vec(any::<u8>(), 0..96)),
                0..6,
            ),
            root in prop::collection::vec(any::<u8>(), 0..160),
        ) {
            let src: BTreeMap<String, Vec<u8>> = files.into_iter().collect();
            let _ = BuiltinTufBackend.verify(&src, &root, NOW);
        }

        /// 从合法链出发，对任意单个 metadata 文件（含信任锚 root）翻转一个字节
        /// → verify 必然失败（TUF 皇冠不变量：任何未重签的篡改都被拒绝）。
        #[test]
        fn any_single_byte_tamper_rejected(
            file_idx in 0usize..4,
            byte_pos in any::<usize>(),
            mask in 1u8..=255,
        ) {
            let (mut root, mut files, _, _) = build_repo(b"PAYLOAD");
            // 合法链先通过
            prop_assert!(BuiltinTufBackend.verify(&files, &root, NOW).is_ok());

            // 0=信任锚 root，1=timestamp，2=snapshot，3=targets
            let names = ["@root", "timestamp.json", "1.snapshot.json", "1.targets.json"];
            let target = names[file_idx];
            let bytes: &mut Vec<u8> = if target == "@root" {
                &mut root
            } else {
                files.get_mut(target).unwrap()
            };
            prop_assume!(!bytes.is_empty());
            let pos = byte_pos % bytes.len();
            bytes[pos] ^= mask;

            prop_assert!(
                BuiltinTufBackend.verify(&files, &root, NOW).is_err(),
                "单字节篡改 {target}@{pos} 竟仍验证通过（签名/哈希钉住被绕过）"
            );
        }
    }
}
