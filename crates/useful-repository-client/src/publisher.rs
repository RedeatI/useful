//! Publisher proof carried inside a source-signed TUF target.
//!
//! The TUF signature binds these fields to the artifact, while this module
//! independently verifies publisher provenance with the public key encoded in
//! the source-scoped `publisherKeyId`. Source/catalog review booleans are never
//! accepted as a substitute for this proof.

use serde_json::Value;

const METHOD: &str = "ed25519";
const PAYLOAD_VERSION: &str = "useful-artifact-v1";

#[derive(Debug, thiserror::Error)]
pub enum PublisherProofError {
    #[error("publisher proof 缺少或字段类型非法: {0}")]
    Missing(&'static str),
    #[error("publisher proof 字段不匹配: {0}")]
    Mismatch(&'static str),
    #[error("publisher proof 仅支持 ed25519；Sigstore/未知方法必须由完整本地验证器处理")]
    UnsupportedMethod,
    #[error("publisher Ed25519 公钥或签名编码非法")]
    InvalidEncoding,
    #[error("publisher Ed25519 签名验证失败")]
    InvalidSignature,
    #[error("没有 TUF target 同时匹配制品摘要与完整 publisher custom")]
    NoMatchingTarget,
    #[error("多个 TUF target 声明了相同的完整制品身份")]
    AmbiguousTarget,
}

/// The complete, caller-authenticated identity that a publisher proof must
/// bind. Keeping these selectors together makes it harder to accidentally
/// verify only a subset of a target's identity.
#[derive(Debug, Clone, Copy)]
pub struct PublisherTargetExpectation<'a> {
    pub publisher_key_id: &'a str,
    pub tool_id: &'a str,
    pub version: &'a str,
    pub channel: &'a str,
    pub platform: &'a str,
    pub arch: &'a str,
    pub artifact_sha256: &'a str,
}

fn required_str<'a>(custom: &'a Value, name: &'static str) -> Result<&'a str, PublisherProofError> {
    custom
        .get(name)
        .and_then(Value::as_str)
        .ok_or(PublisherProofError::Missing(name))
}

pub fn signing_payload(tool_id: &str, version: &str, artifact_sha256: &str) -> Vec<u8> {
    format!(
        "{PAYLOAD_VERSION}\n{tool_id}\n{version}\n{}",
        artifact_sha256.to_ascii_lowercase()
    )
    .into_bytes()
}

/// Verify every identity/digest selector and the independent publisher
/// signature. The caller must already have authenticated `custom` through TUF.
pub fn verify_publisher_target_custom(
    custom: &Value,
    expected: PublisherTargetExpectation<'_>,
) -> Result<(), PublisherProofError> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let publisher_key_id = required_str(custom, "publisherKeyId")?;
    if publisher_key_id != expected.publisher_key_id {
        return Err(PublisherProofError::Mismatch("publisherKeyId"));
    }
    for (field, expected) in [
        ("toolId", expected.tool_id),
        ("version", expected.version),
        ("channel", expected.channel),
        ("platform", expected.platform),
        ("arch", expected.arch),
    ] {
        if required_str(custom, field)? != expected {
            return Err(PublisherProofError::Mismatch(field));
        }
    }
    let artifact_sha256 = required_str(custom, "artifactSha256")?;
    if artifact_sha256.len() != 64
        || artifact_sha256
            .bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
        || expected.artifact_sha256 != expected.artifact_sha256.to_ascii_lowercase()
        || artifact_sha256 != expected.artifact_sha256
    {
        return Err(PublisherProofError::Mismatch("artifactSha256"));
    }
    if custom
        .get("publisherSignatureVerified")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(PublisherProofError::Mismatch("publisherSignatureVerified"));
    }
    if required_str(custom, "publisherSignatureMethod")? != METHOD {
        return Err(PublisherProofError::UnsupportedMethod);
    }
    if required_str(custom, "publisherSignaturePayloadVersion")? != PAYLOAD_VERSION {
        return Err(PublisherProofError::Mismatch(
            "publisherSignaturePayloadVersion",
        ));
    }
    if required_str(custom, "signatureIdentity")? != publisher_key_id {
        return Err(PublisherProofError::Mismatch("signatureIdentity"));
    }

    let public_hex = publisher_key_id
        .strip_prefix("ed25519:")
        .ok_or(PublisherProofError::InvalidEncoding)?;
    let signature_hex = required_str(custom, "publisherSignature")?;
    if public_hex.len() != 64
        || signature_hex.len() != 128
        || public_hex
            .bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
        || signature_hex
            .bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
    {
        return Err(PublisherProofError::InvalidEncoding);
    }
    let public = hex::decode(public_hex).map_err(|_| PublisherProofError::InvalidEncoding)?;
    let public: [u8; 32] = public
        .try_into()
        .map_err(|_| PublisherProofError::InvalidEncoding)?;
    let signature = hex::decode(signature_hex).map_err(|_| PublisherProofError::InvalidEncoding)?;
    let signature: [u8; 64] = signature
        .try_into()
        .map_err(|_| PublisherProofError::InvalidEncoding)?;
    let key =
        VerifyingKey::from_bytes(&public).map_err(|_| PublisherProofError::InvalidEncoding)?;
    key.verify(
        &signing_payload(expected.tool_id, expected.version, artifact_sha256),
        &Signature::from_bytes(&signature),
    )
    .map_err(|_| PublisherProofError::InvalidSignature)
}

/// Select exactly one target by digest and every authenticated custom field.
/// A repository that supplies duplicate complete bindings is ambiguous and
/// fails closed; map iteration order must never choose the winner.
pub fn select_unique_publisher_target<'a>(
    targets: &'a std::collections::BTreeMap<String, crate::tuf::TargetInfo>,
    expected: PublisherTargetExpectation<'_>,
) -> Result<(&'a str, &'a crate::tuf::TargetInfo), PublisherProofError> {
    let mut selected = None;
    let mut last_error = None;
    for (name, info) in targets
        .iter()
        .filter(|(_, info)| info.sha256 == expected.artifact_sha256)
    {
        let result = info
            .custom
            .as_ref()
            .ok_or(PublisherProofError::Missing("custom"))
            .and_then(|custom| verify_publisher_target_custom(custom, expected));
        match result {
            Ok(()) if selected.is_some() => return Err(PublisherProofError::AmbiguousTarget),
            Ok(()) => selected = Some((name.as_str(), info)),
            Err(error) => last_error = Some(error),
        }
    }
    selected.ok_or_else(|| last_error.unwrap_or(PublisherProofError::NoMatchingTarget))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    fn expected<'a>(
        publisher_key_id: &'a str,
        artifact_sha256: &'a str,
    ) -> PublisherTargetExpectation<'a> {
        PublisherTargetExpectation {
            publisher_key_id,
            tool_id: "com.test.tool",
            version: "1.2.3",
            channel: "stable",
            platform: "windows",
            arch: "x86_64",
            artifact_sha256,
        }
    }

    fn proof() -> (Value, String) {
        let key = SigningKey::from_bytes(&[7; 32]);
        let key_id = format!("ed25519:{}", hex::encode(key.verifying_key().to_bytes()));
        let signature = key.sign(&signing_payload("com.test.tool", "1.2.3", &"ab".repeat(32)));
        (
            json!({
                "publisherKeyId": key_id.clone(),
                "toolId": "com.test.tool",
                "version": "1.2.3",
                "channel": "stable",
                "platform": "windows",
                "arch": "x86_64",
                "artifactSha256": "ab".repeat(32),
                "publisherSignatureVerified": true,
                "publisherSignatureMethod": "ed25519",
                "publisherSignaturePayloadVersion": "useful-artifact-v1",
                "publisherSignature": hex::encode(signature.to_bytes()),
                "signatureIdentity": key_id.clone(),
            }),
            key_id,
        )
    }

    #[test]
    fn independently_verified_bound_ed25519_proof_is_accepted() {
        let (proof, key_id) = proof();
        verify_publisher_target_custom(&proof, expected(&key_id, &"ab".repeat(32))).unwrap();
    }

    #[test]
    fn forged_catalog_flag_or_any_changed_binding_is_rejected() {
        let (baseline, key_id) = proof();
        for field in [
            "publisherKeyId",
            "toolId",
            "version",
            "channel",
            "platform",
            "arch",
            "artifactSha256",
            "publisherSignature",
            "signatureIdentity",
        ] {
            let mut forged = baseline.clone();
            forged[field] = json!(if field == "publisherSignature" {
                "00".repeat(64)
            } else {
                "attacker".to_string()
            });
            assert!(
                verify_publisher_target_custom(&forged, expected(&key_id, &"ab".repeat(32)))
                    .is_err(),
                "{field}"
            );
        }
        let mut unsigned = baseline.clone();
        unsigned["publisherSignatureVerified"] = json!(false);
        assert!(
            verify_publisher_target_custom(&unsigned, expected(&key_id, &"ab".repeat(32))).is_err()
        );
        let mut sigstore = baseline;
        sigstore["publisherSignatureMethod"] = json!("sigstore");
        sigstore["publisherSignature"] = json!("");
        assert!(matches!(
            verify_publisher_target_custom(&sigstore, expected(&key_id, &"ab".repeat(32))),
            Err(PublisherProofError::UnsupportedMethod)
        ));
    }

    #[test]
    fn duplicate_complete_target_bindings_are_rejected() {
        let (proof, key_id) = proof();
        let info = crate::tuf::TargetInfo {
            length: 1,
            sha256: "ab".repeat(32),
            custom: Some(proof),
        };
        let targets = std::collections::BTreeMap::from([
            ("windows-a.useful".into(), info.clone()),
            ("windows-b.useful".into(), info),
        ]);
        assert!(matches!(
            select_unique_publisher_target(&targets, expected(&key_id, &"ab".repeat(32))),
            Err(PublisherProofError::AmbiguousTarget)
        ));
    }
}
