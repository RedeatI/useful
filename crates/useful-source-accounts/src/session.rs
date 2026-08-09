//! 授权会话：构造授权 URL、校验 loopback 回调、解析令牌响应。

use crate::pkce::{random_urlsafe, PkcePair};
use crate::AccountError;
use serde::Deserialize;

/// 一次登录会话的不可变参数（state/nonce/pkce 在发起时固定，回调时校验）。
#[derive(Debug, Clone)]
pub struct AuthSession {
    pub source_id: String,
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub state: String,
    pub nonce: String,
    pub pkce: PkcePair,
}

/// 判定 redirect_uri 是否为 loopback IP literal（禁止 localhost 主机名）。
pub fn is_loopback_ip_literal(redirect_uri: &str) -> bool {
    // 仅接受 http://127.0.0.1:PORT... 或 http://[::1]:PORT...
    redirect_uri.starts_with("http://127.0.0.1:") || redirect_uri.starts_with("http://[::1]:")
}

impl AuthSession {
    /// 新建会话：随机 state/nonce/pkce。`port` 为本次开启的 loopback 端口。
    pub fn new(
        source_id: &str,
        issuer: &str,
        client_id: &str,
        port: u16,
        scopes: Vec<String>,
    ) -> AuthSession {
        AuthSession {
            source_id: source_id.to_string(),
            issuer: issuer.trim_end_matches('/').to_string(),
            client_id: client_id.to_string(),
            redirect_uri: format!("http://127.0.0.1:{port}/callback"),
            scopes,
            state: random_urlsafe(24),
            nonce: random_urlsafe(24),
            pkce: PkcePair::generate(),
        }
    }

    /// 构造授权端点 URL（GET /oauth/authorize?...）。token 绝不在此。
    pub fn authorize_url(&self) -> Result<String, AccountError> {
        if !is_loopback_ip_literal(&self.redirect_uri) {
            return Err(AccountError::NonLoopbackRedirect);
        }
        let scope = self.scopes.join(" ");
        let q = [
            ("response_type", "code"),
            ("client_id", self.client_id.as_str()),
            ("redirect_uri", self.redirect_uri.as_str()),
            ("code_challenge", self.pkce.challenge.as_str()),
            ("code_challenge_method", self.pkce.method),
            ("state", self.state.as_str()),
            ("nonce", self.nonce.as_str()),
            ("scope", scope.as_str()),
        ];
        let query: Vec<String> = q
            .iter()
            .map(|(k, v)| format!("{}={}", k, urlencode(v)))
            .collect();
        Ok(format!(
            "{}/oauth/authorize?{}",
            self.issuer,
            query.join("&")
        ))
    }

    /// 校验回调参数：state 必须匹配、无 error、含 code。返回授权码。
    pub fn verify_callback(&self, cb: &CallbackParams) -> Result<String, AccountError> {
        if let Some(err) = &cb.error {
            return Err(AccountError::CallbackError(err.clone()));
        }
        if cb.state != self.state {
            return Err(AccountError::StateMismatch);
        }
        match &cb.code {
            Some(c) if !c.is_empty() => Ok(c.clone()),
            _ => Err(AccountError::MissingCode),
        }
    }

    /// 构造令牌交换请求体（application/x-www-form-urlencoded）。
    pub fn token_request_form(&self, code: &str) -> String {
        let fields = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", self.pkce.verifier.as_str()),
            ("redirect_uri", self.redirect_uri.as_str()),
            ("client_id", self.client_id.as_str()),
        ];
        fields
            .iter()
            .map(|(k, v)| format!("{}={}", k, urlencode(v)))
            .collect::<Vec<_>>()
            .join("&")
    }

    /// 校验令牌端点响应的 issuer 一致性（令牌不透明，无法解 iss 时按会话 issuer 记账）。
    pub fn parse_token_response(&self, body: &[u8]) -> Result<TokenResponse, AccountError> {
        let resp: TokenResponse = serde_json::from_slice(body)
            .map_err(|e| AccountError::InvalidTokenResponse(e.to_string()))?;
        if resp.access_token.is_empty() {
            return Err(AccountError::InvalidTokenResponse(
                "缺少 access_token".into(),
            ));
        }
        if !resp.token_type.eq_ignore_ascii_case("bearer") {
            return Err(AccountError::InvalidTokenResponse(format!(
                "token_type 必须为 Bearer，实际 {}",
                resp.token_type
            )));
        }
        Ok(resp)
    }
}

/// loopback 回调解析出的查询参数。
#[derive(Debug, Clone, Default)]
pub struct CallbackParams {
    pub code: Option<String>,
    pub state: String,
    pub error: Option<String>,
}

impl CallbackParams {
    /// 从回调请求的 query string 解析（如 "code=abc&state=xyz"）。
    pub fn from_query(query: &str) -> CallbackParams {
        let mut cb = CallbackParams::default();
        for pair in query.split('&') {
            let mut it = pair.splitn(2, '=');
            let k = it.next().unwrap_or("");
            let v = urldecode(it.next().unwrap_or(""));
            match k {
                "code" => cb.code = Some(v),
                "state" => cb.state = v,
                "error" => cb.error = Some(v),
                _ => {}
            }
        }
        cb
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub token_type: String,
    #[serde(default)]
    pub expires_in: i64,
    #[serde(default)]
    pub scope: String,
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> AuthSession {
        AuthSession::new(
            "com.example.src",
            "https://src.example/",
            "useful-desktop",
            51820,
            vec!["profile".into(), "downloads".into()],
        )
    }

    #[test]
    fn authorize_url_has_pkce_state_loopback_and_no_secret() {
        let s = session();
        let url = s.authorize_url().unwrap();
        assert!(url.starts_with("https://src.example/oauth/authorize?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains(&format!("code_challenge={}", s.pkce.challenge)));
        assert!(url.contains(&format!("state={}", s.state)));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A51820%2Fcallback"));
        // 绝不内嵌 client_secret
        assert!(!url.contains("client_secret"));
        assert!(!url.contains("response_type=token")); // 非 implicit
    }

    #[test]
    fn localhost_hostname_redirect_rejected() {
        let mut s = session();
        s.redirect_uri = "http://localhost:51820/callback".into();
        assert!(matches!(
            s.authorize_url(),
            Err(AccountError::NonLoopbackRedirect)
        ));
    }

    #[test]
    fn callback_state_mismatch_rejected() {
        let s = session();
        let cb = CallbackParams {
            code: Some("abc".into()),
            state: "attacker-state".into(),
            error: None,
        };
        assert!(matches!(
            s.verify_callback(&cb),
            Err(AccountError::StateMismatch)
        ));
    }

    #[test]
    fn callback_matching_state_returns_code() {
        let s = session();
        let cb = CallbackParams {
            code: Some("the-code".into()),
            state: s.state.clone(),
            error: None,
        };
        assert_eq!(s.verify_callback(&cb).unwrap(), "the-code");
    }

    #[test]
    fn callback_error_propagated() {
        let s = session();
        let cb = CallbackParams {
            code: None,
            state: s.state.clone(),
            error: Some("access_denied".into()),
        };
        assert!(matches!(
            s.verify_callback(&cb),
            Err(AccountError::CallbackError(_))
        ));
    }

    #[test]
    fn from_query_parses_code_and_state() {
        let cb = CallbackParams::from_query("code=abc123&state=xyz789");
        assert_eq!(cb.code.as_deref(), Some("abc123"));
        assert_eq!(cb.state, "xyz789");
    }

    #[test]
    fn token_form_carries_verifier_not_challenge() {
        let s = session();
        let form = s.token_request_form("the-code");
        assert!(form.contains("grant_type=authorization_code"));
        assert!(form.contains(&format!("code_verifier={}", s.pkce.verifier)));
        assert!(form.contains("code=the-code"));
        assert!(!form.contains("code_challenge")); // 交换用 verifier，不是 challenge
    }

    #[test]
    fn parse_token_response_requires_bearer() {
        let s = session();
        let ok = br#"{"access_token":"at","refresh_token":"rt","token_type":"Bearer","expires_in":3600}"#;
        let resp = s.parse_token_response(ok).unwrap();
        assert_eq!(resp.access_token, "at");
        // 非 Bearer 拒绝
        let bad = br#"{"access_token":"at","token_type":"mac"}"#;
        assert!(s.parse_token_response(bad).is_err());
    }
}
