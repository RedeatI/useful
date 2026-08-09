//! 源账户命令：OAuth2 PKCE 登录、账户查询、登出、权益获取。
//!
//! 登录流程（对应规范 §12）：拉取 discovery.auth → 开 loopback 端口 → 构造授权 URL →
//! 系统默认浏览器 → 等回调（含超时，端口用后即关）→ 校验 state → 换令牌 →
//! DPAPI 存令牌（不入 SQLite）→ 写 source_accounts。凭据按源隔离。

use super::dpapi_store::DpapiTokenStore;
use super::{CmdError, CmdResult};
use crate::state::AppState;
use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};
use tauri::State;
use useful_source_accounts::session::CallbackParams;
use useful_source_accounts::{AuthSession, SourceAccount, TokenBundle, TokenStore};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAccountInfo {
    pub source_id: String,
    pub account_id: String,
    pub display_name: String,
    pub scopes: Vec<String>,
    pub expires_at: i64,
    pub last_authenticated_at: i64,
    /// access token 是否已过期（UI 提示重新登录；已装工具运行不受影响）。
    pub expired: bool,
}

fn credentials_dir(state: &AppState) -> std::path::PathBuf {
    state.paths.data_dir.join("credentials")
}

/// 读取某源的 discovery（复用 trp_sources 的拉取+校验，返回 auth 信息）。
async fn source_auth_config(
    state: &AppState,
    source_id: &str,
) -> Result<(String, useful_repository_client::discovery::AuthMeta, bool), CmdError> {
    let (url, local) = {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        db.conn
            .query_row(
                "SELECT discovery_url, local FROM trp_sources WHERE id = ?1",
                [source_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .map_err(|_| CmdError::from("源不存在"))?
    };
    let dev = super::sources::developer_mode_enabled(state);
    super::trp_sources::check_discovery_url_pub(&url, dev || local)?;
    let d = super::trp_sources::fetch_discovery_pub(&url, local).await?;
    let auth = d
        .auth
        .ok_or_else(|| CmdError::from("该源未声明 OAuth 认证（无需登录或不支持登录）"))?;
    if auth.auth_type != "oauth2-pkce" {
        return Err(CmdError::from("仅支持 oauth2-pkce 认证"));
    }
    Ok((auth.issuer.clone(), auth, local))
}

/// 发起登录：完整 PKCE 授权码流程。
#[tauri::command]
pub async fn source_login(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source_id: String,
) -> CmdResult<SourceAccountInfo> {
    let (issuer, auth, local) = source_auth_config(&state, &source_id).await?;

    // 1) 开 loopback 端口（仅授权期间开启）
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| CmdError::from(format!("无法开启本地回调端口: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| CmdError::from(e.to_string()))?
        .port();

    let session = AuthSession::new(
        &source_id,
        &issuer,
        &auth.client_id,
        port,
        auth.scopes.clone(),
    );
    let authorize_url = session
        .authorize_url()
        .map_err(|e| CmdError::from(e.to_string()))?;
    let parsed_authorize_url =
        useful_repository_client::network::validate_url(&authorize_url, local)
            .map_err(|error| CmdError::from(format!("授权端点被网络安全策略拒绝: {error}")))?;
    // The system browser cannot consume reqwest's resolver pin, but resolve and
    // reject a private/special destination before launching it. Token/userinfo
    // requests below additionally pin the audited address set.
    let _ = super::sources::pinned_client_for_url(&parsed_authorize_url, local).await?;

    // 2) 系统默认浏览器打开授权页（绝不用内嵌 WebView 登录）
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(authorize_url, None::<String>)
        .map_err(|e| CmdError::from(format!("打开浏览器失败: {e}")))?;

    // 3) 等待回调（阻塞在专用线程，带超时；完成即关闭端口）
    let code = tokio::task::spawn_blocking(move || wait_for_callback(listener, &session))
        .await
        .map_err(|e| CmdError::from(e.to_string()))??;

    // 4) 用授权码换令牌
    let (session2, verified_code) = code;
    let form = session2.token_request_form(&verified_code);
    let token_url = format!("{}/oauth/token", session2.issuer);
    let parsed_token_url = useful_repository_client::network::validate_url(&token_url, local)
        .map_err(|error| CmdError::from(format!("令牌端点被网络安全策略拒绝: {error}")))?;
    let token_client = super::sources::pinned_client_for_url(&parsed_token_url, local).await?;
    let resp = token_client
        .post(parsed_token_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| CmdError::from(format!("令牌请求失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(CmdError::from(format!("令牌端点返回 {}", resp.status())));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| CmdError::from(e.to_string()))?;
    let tokens = session2
        .parse_token_response(&bytes)
        .map_err(|e| CmdError::from(e.to_string()))?;

    // 5) DPAPI 存令牌，SQLite 只存账户元信息
    let now = now_unix();
    let expires_at = if tokens.expires_in > 0 {
        now + tokens.expires_in
    } else {
        now + 3600
    };
    let store = DpapiTokenStore::new(&credentials_dir(&state));
    let reference = format!("oauth-{}", uuid::Uuid::new_v4());
    store
        .save(
            &source_id,
            &reference,
            &TokenBundle {
                access_token: tokens.access_token.clone(),
                refresh_token: tokens.refresh_token.clone(),
                expires_at,
            },
        )
        .map_err(|e| CmdError::from(e.to_string()))?;

    // account_id 从 /v1/me 获取（用 bearer）
    let account_id = fetch_subject(&session2.issuer, &tokens.access_token, local)
        .await
        .unwrap_or_else(|| "account".to_string());

    let account = SourceAccount {
        source_id: source_id.clone(),
        account_id: account_id.clone(),
        display_name: account_id.clone(),
        credential_reference: reference.clone(),
        scopes: auth.scopes.clone(),
        expires_at,
        last_authenticated_at: now,
    };
    upsert_account(&state, &account)?;
    Ok(to_info(&account, now))
}

/// 阻塞等待一次 loopback 回调，返回 (session, code)。超时/失败即返回错误。
#[allow(clippy::type_complexity)]
fn wait_for_callback(
    listener: TcpListener,
    session: &AuthSession,
) -> Result<(AuthSession, String), CmdError> {
    wait_for_callback_with_timeout(listener, session, Duration::from_secs(120))
}

const MAX_CALLBACK_REQUEST_LINE: usize = 8 * 1024;
const CALLBACK_IO_TIMEOUT: Duration = Duration::from_secs(2);

fn read_request_line(
    stream: &mut std::net::TcpStream,
    deadline: Instant,
) -> std::io::Result<String> {
    let mut line = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "deadline",
            ));
        }
        stream.set_read_timeout(Some(remaining.min(CALLBACK_IO_TIMEOUT)))?;
        let mut chunk = [0u8; 512];
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "request line incomplete",
            ));
        }
        line.extend_from_slice(&chunk[..read]);
        if line.len() > MAX_CALLBACK_REQUEST_LINE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request line too long",
            ));
        }
        if let Some(end) = line.windows(2).position(|window| window == b"\r\n") {
            return std::str::from_utf8(&line[..end])
                .map(str::to_owned)
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "non-UTF8"));
        }
    }
}

fn write_callback_response(
    stream: &mut std::net::TcpStream,
    deadline: Instant,
    status: &str,
    body: &str,
) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return;
    }
    let _ = stream.set_write_timeout(Some(remaining.min(CALLBACK_IO_TIMEOUT)));
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(), body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn wait_for_callback_with_timeout(
    listener: TcpListener,
    session: &AuthSession,
    timeout: Duration,
) -> Result<(AuthSession, String), CmdError> {
    listener
        .set_nonblocking(true)
        .map_err(|e| CmdError::from(e.to_string()))?;
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() >= deadline {
            return Err(CmdError::from("登录超时"));
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(error) => return Err(CmdError::from(format!("回调监听失败: {error}"))),
        };
        let first = match read_request_line(&mut stream, deadline) {
            Ok(line) => line,
            Err(_) => {
                write_callback_response(
                    &mut stream,
                    deadline,
                    "400 Bad Request",
                    "无效请求，请返回浏览器重试。",
                );
                continue;
            }
        };
        let mut parts = first.split_whitespace();
        let method = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        let protocol = parts.next().unwrap_or("");
        if method != "GET"
            || !path.starts_with("/callback?")
            || !protocol.starts_with("HTTP/1.")
            || parts.next().is_some()
        {
            write_callback_response(
                &mut stream,
                deadline,
                "400 Bad Request",
                "无效请求，请返回浏览器重试。",
            );
            continue;
        }
        let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
        let cb = CallbackParams::from_query(query);
        // Random local probes, favicon requests, stale browser tabs and forged
        // states do not consume the one-shot authorization listener.
        if cb.state != session.state {
            write_callback_response(
                &mut stream,
                deadline,
                "400 Bad Request",
                "登录请求无效，请返回 Useful 重试。",
            );
            continue;
        }
        let result = session.verify_callback(&cb);
        let body = match &result {
            Ok(_) => "登录成功，请返回 Useful。",
            Err(_) => "登录失败或被拒绝，请返回 Useful 重试。",
        };
        write_callback_response(&mut stream, deadline, "200 OK", body);
        return result
            .map(|code| (session.clone(), code))
            .map_err(|e| CmdError::from(e.to_string()));
    }
}

async fn fetch_subject(issuer: &str, access_token: &str, allow_local: bool) -> Option<String> {
    let url =
        useful_repository_client::network::validate_url(&format!("{issuer}/v1/me"), allow_local)
            .ok()?;
    let client = super::sources::pinned_client_for_url(&url, allow_local)
        .await
        .ok()?;
    let resp = client
        .get(url)
        .bearer_auth(access_token)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    v.get("subjectId")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn source_account_get(
    state: State<AppState>,
    source_id: String,
) -> CmdResult<Option<SourceAccountInfo>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let row = db.conn.query_row(
        "SELECT source_id, account_id, display_name, credential_reference, scopes_json,
                expires_at, last_authenticated_at
         FROM source_accounts WHERE source_id = ?1",
        [&source_id],
        |r| {
            let scopes_json: String = r.get(4)?;
            Ok(SourceAccount {
                source_id: r.get(0)?,
                account_id: r.get(1)?,
                display_name: r.get(2)?,
                credential_reference: r.get(3)?,
                scopes: serde_json::from_str(&scopes_json).unwrap_or_default(),
                expires_at: r.get(5)?,
                last_authenticated_at: r.get(6)?,
            })
        },
    );
    match row {
        Ok(acct) => Ok(Some(to_info(&acct, now_unix()))),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(CmdError::from(e.to_string())),
    }
}

/// 登出：删除 DPAPI 令牌与账户记录。已安装工具不受影响（本地版本继续运行）。
#[tauri::command]
pub fn source_logout(state: State<AppState>, source_id: String) -> CmdResult<()> {
    let reference: Option<String> = {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        db.conn
            .query_row(
                "SELECT credential_reference FROM source_accounts WHERE source_id = ?1",
                [&source_id],
                |r| r.get(0),
            )
            .ok()
    };
    if let Some(reference) = reference {
        let store = DpapiTokenStore::new(&credentials_dir(&state));
        let _ = store.delete(&source_id, &reference);
    }
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn.execute(
        "DELETE FROM source_accounts WHERE source_id = ?1",
        [&source_id],
    )?;
    Ok(())
}

fn upsert_account(state: &AppState, a: &SourceAccount) -> Result<(), CmdError> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn.execute(
        "INSERT INTO source_accounts
         (source_id, account_id, display_name, credential_reference, scopes_json, expires_at, last_authenticated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(source_id) DO UPDATE SET
           account_id=?2, display_name=?3, credential_reference=?4, scopes_json=?5,
           expires_at=?6, last_authenticated_at=?7",
        rusqlite::params![
            a.source_id,
            a.account_id,
            a.display_name,
            a.credential_reference,
            serde_json::to_string(&a.scopes).unwrap_or_else(|_| "[]".into()),
            a.expires_at,
            a.last_authenticated_at,
        ],
    )?;
    Ok(())
}

fn to_info(a: &SourceAccount, now: i64) -> SourceAccountInfo {
    SourceAccountInfo {
        source_id: a.source_id.clone(),
        account_id: a.account_id.clone(),
        display_name: a.display_name.clone(),
        scopes: a.scopes.clone(),
        expires_at: a.expires_at,
        last_authenticated_at: a.last_authenticated_at,
        expired: a.expires_at > 0 && now >= a.expires_at,
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    #[test]
    fn invalid_loopback_connections_do_not_consume_callback_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let session =
            AuthSession::new("source.test", "https://issuer.test", "client", port, vec![]);
        let state = session.state.clone();
        let client = std::thread::spawn(move || {
            let mut invalid = TcpStream::connect(("127.0.0.1", port)).unwrap();
            invalid
                .write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n")
                .unwrap();
            drop(invalid);
            let mut forged = TcpStream::connect(("127.0.0.1", port)).unwrap();
            forged
                .write_all(b"GET /callback?code=evil&state=wrong HTTP/1.1\r\n\r\n")
                .unwrap();
            drop(forged);
            let mut oversized = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = oversized.write_all(&vec![b'A'; MAX_CALLBACK_REQUEST_LINE + 1]);
            drop(oversized);
            let mut valid = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
                valid,
                "GET /callback?code=good&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
            )
            .unwrap();
        });
        let (_, code) =
            wait_for_callback_with_timeout(listener, &session, Duration::from_secs(2)).unwrap();
        client.join().unwrap();
        assert_eq!(code, "good");
    }

    #[test]
    fn slow_connection_cannot_extend_global_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let session =
            AuthSession::new("source.test", "https://issuer.test", "client", port, vec![]);
        let client = std::thread::spawn(move || {
            let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
            slow.write_all(b"G").unwrap();
            std::thread::sleep(Duration::from_millis(250));
        });
        let started = Instant::now();
        assert!(
            wait_for_callback_with_timeout(listener, &session, Duration::from_millis(80)).is_err()
        );
        assert!(started.elapsed() < Duration::from_millis(220));
        client.join().unwrap();
    }
}
