//! PKCE (RFC 7636) S256：code_verifier 与 code_challenge 生成。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// PKCE 对：verifier 保留在客户端，challenge 发送到授权端点。
#[derive(Debug, Clone)]
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
    pub method: &'static str,
}

impl PkcePair {
    /// 生成随机 PKCE 对（S256）。verifier 为 43-128 字符的 base64url 随机串。
    pub fn generate() -> PkcePair {
        let mut buf = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut buf);
        let verifier = URL_SAFE_NO_PAD.encode(buf);
        Self::from_verifier(&verifier)
    }

    /// 由给定 verifier 派生 challenge（供测试固定向量）。
    pub fn from_verifier(verifier: &str) -> PkcePair {
        let digest = Sha256::digest(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(digest);
        PkcePair {
            verifier: verifier.to_string(),
            challenge,
            method: "S256",
        }
    }
}

/// 生成 URL-safe 随机串（用于 state / nonce）。
pub fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s256_challenge_matches_rfc7636_vector() {
        // RFC 7636 附录 B 官方测试向量
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let pair = PkcePair::from_verifier(verifier);
        assert_eq!(
            pair.challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(pair.method, "S256");
    }

    #[test]
    fn generated_pair_is_verifiable() {
        let pair = PkcePair::generate();
        // challenge = base64url(sha256(verifier))
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(pair.verifier.as_bytes()));
        assert_eq!(pair.challenge, expected);
        assert!(pair.verifier.len() >= 43);
    }

    #[test]
    fn state_and_nonce_are_random_and_distinct() {
        let a = random_urlsafe(16);
        let b = random_urlsafe(16);
        assert_ne!(a, b);
        assert!(!a.is_empty());
    }
}
