// OAuth2 授权服务器：/oauth/authorize（Authorization Code + PKCE）与 /oauth/token。
//
// 安全约束（对应规范 §12）：
// - 仅 response_type=code + code_challenge_method=S256；拒绝 implicit/token。
// - redirect_uri 必须是 loopback IP literal（127.0.0.1 / [::1]），精确匹配换码。
// - 授权码短期有效（60s）、单次使用、绑定 challenge+redirect+client+subject+nonce+scope。
// - token 不出现在查询参数（走 POST body / Authorization 头）。
// - 不接受 state/issuer 不匹配（state 由客户端校验；issuer 在令牌内）。
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"useful.dev/source/internal/config"
)

const (
	authCodeTTL     = 60 * time.Second
	accessTokenTTL  = time.Hour
	refreshTokenTTL = 30 * 24 * time.Hour
	defaultClientID = "useful-desktop"
)

type authCode struct {
	subject       string
	clientID      string
	redirectURI   string
	codeChallenge string
	nonce         string
	scopes        []string
	expiresAt     time.Time
}

// Server OAuth2 授权服务器。
type Server struct {
	Cfg    *config.Config
	Signer *Signer
	Now    func() time.Time

	mu    sync.Mutex
	codes map[string]authCode
}

func NewServer(cfg *config.Config, signer *Signer) *Server {
	return &Server{Cfg: cfg, Signer: signer, codes: map[string]authCode{}}
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

// parseLoopbackRedirect returns the only URL value that may reach a redirect
// sink. It requires an HTTP loopback IP literal and an explicit port.
func parseLoopbackRedirect(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Scheme != "http" || u.User != nil || u.Fragment != "" || u.Port() == "" {
		return nil, false
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "::1" {
		return nil, false
	}
	return u, true
}

func randToken(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// Authorize 处理 GET /oauth/authorize。
//
// 用户认证：本参考实现在开发环境用 login_hint 作为 subject 自动签发授权码
// （自托管源的最小可用登录）；生产环境应对接真实 IdP（返回 501 指引）。
func (s *Server) Authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	respType := q.Get("response_type")
	clientID := q.Get("client_id")
	redirectURI := q.Get("redirect_uri")
	challenge := q.Get("code_challenge")
	method := q.Get("code_challenge_method")
	state := q.Get("state")
	scope := q.Get("scope")
	nonce := q.Get("nonce")
	loginHint := q.Get("login_hint")

	// 禁止 implicit：response_type 必须为 code
	if respType != "code" {
		authError(w, redirectURI, state, "unsupported_response_type", "仅支持 authorization code")
		return
	}
	if method != "S256" {
		authError(w, redirectURI, state, "invalid_request", "code_challenge_method 必须为 S256")
		return
	}
	if challenge == "" {
		authError(w, redirectURI, state, "invalid_request", "缺少 code_challenge（PKCE 必需）")
		return
	}
	if clientID != defaultClientID {
		authError(w, redirectURI, state, "unauthorized_client", "未知 client_id")
		return
	}
	redirect, ok := parseLoopbackRedirect(redirectURI)
	if !ok {
		// redirect_uri 非法时不得回跳（防开放重定向），直接返回错误页
		writePlain(w, http.StatusBadRequest, "redirect_uri 必须是 loopback IP literal（http://127.0.0.1:PORT）")
		return
	}

	// 用户认证
	subject := loginHint
	if subject == "" || s.Cfg.Environment != config.EnvDevelopment {
		if s.Cfg.Environment != config.EnvDevelopment {
			writePlain(w, http.StatusNotImplemented,
				"该参考源在生产环境需对接真实身份提供方（IdP）；开发环境可用 login_hint 演示登录。")
			return
		}
		writePlain(w, http.StatusBadRequest, "开发环境请提供 login_hint 作为演示登录主体")
		return
	}

	scopes := splitScopes(scope)
	code := randToken(24)
	s.mu.Lock()
	s.codes[code] = authCode{
		subject: subject, clientID: clientID, redirectURI: redirectURI,
		codeChallenge: challenge, nonce: nonce, scopes: scopes,
		expiresAt: s.now().Add(authCodeTTL),
	}
	s.mu.Unlock()

	// 302 回跳 loopback，仅带 code + state（token 绝不在此出现）
	rq := redirect.Query()
	rq.Set("code", code)
	if state != "" {
		rq.Set("state", state)
	}
	redirect.RawQuery = rq.Encode()
	// parseLoopbackRedirect is the sole constructor for this dynamic native-app callback.
	// codeql[go/unvalidated-url-redirection]
	w.Header().Set("Location", redirect.String())
	w.WriteHeader(http.StatusFound)
}

// Token 处理 POST /oauth/token（grant_type=authorization_code | refresh_token）。
func (s *Server) Token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		tokenError(w, http.StatusBadRequest, "invalid_request", "表单解析失败")
		return
	}
	switch r.Form.Get("grant_type") {
	case "authorization_code":
		s.tokenFromCode(w, r)
	case "refresh_token":
		s.tokenFromRefresh(w, r)
	default:
		// 明确拒绝 password flow 等
		tokenError(w, http.StatusBadRequest, "unsupported_grant_type",
			"仅支持 authorization_code 与 refresh_token")
	}
}

func (s *Server) tokenFromCode(w http.ResponseWriter, r *http.Request) {
	code := r.Form.Get("code")
	verifier := r.Form.Get("code_verifier")
	redirectURI := r.Form.Get("redirect_uri")
	clientID := r.Form.Get("client_id")

	s.mu.Lock()
	ac, ok := s.codes[code]
	if ok {
		delete(s.codes, code) // 单次使用：立即消费
	}
	s.mu.Unlock()

	if !ok || s.now().After(ac.expiresAt) {
		tokenError(w, http.StatusBadRequest, "invalid_grant", "授权码无效或已过期")
		return
	}
	if ac.redirectURI != redirectURI || ac.clientID != clientID {
		tokenError(w, http.StatusBadRequest, "invalid_grant", "redirect_uri 或 client_id 不匹配")
		return
	}
	if verifier == "" || !VerifyPKCE(verifier, ac.codeChallenge) {
		tokenError(w, http.StatusBadRequest, "invalid_grant", "PKCE 校验失败")
		return
	}
	s.issueTokens(w, ac.subject, ac.scopes)
}

func (s *Server) tokenFromRefresh(w http.ResponseWriter, r *http.Request) {
	refresh := r.Form.Get("refresh_token")
	claims, err := s.Signer.Verify(refresh, s.now())
	if err != nil || claims.Type != "refresh" {
		tokenError(w, http.StatusBadRequest, "invalid_grant", "refresh_token 无效")
		return
	}
	s.issueTokens(w, claims.Subject, claims.Scopes)
}

func (s *Server) issueTokens(w http.ResponseWriter, subject string, scopes []string) {
	now := s.now()
	access, err := s.Signer.Issue(subject, "access", scopes, accessTokenTTL, now)
	if err != nil {
		tokenError(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	refresh, err := s.Signer.Issue(subject, "refresh", scopes, refreshTokenTTL, now)
	if err != nil {
		tokenError(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"token_type":    "Bearer",
		"expires_in":    int(accessTokenTTL.Seconds()),
		"scope":         joinScopes(scopes),
	})
}

// 清理过期授权码（可由后台定期调用）。
func (s *Server) GC() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for k, v := range s.codes {
		if now.After(v.expiresAt) {
			delete(s.codes, k)
		}
	}
}

func authError(w http.ResponseWriter, redirectURI, state, code, desc string) {
	if redirect, ok := parseLoopbackRedirect(redirectURI); ok {
		rq := redirect.Query()
		rq.Set("error", code)
		rq.Set("error_description", desc)
		if state != "" {
			rq.Set("state", state)
		}
		redirect.RawQuery = rq.Encode()
		// parseLoopbackRedirect is the sole constructor for this dynamic native-app callback.
		// codeql[go/unvalidated-url-redirection]
		w.Header().Set("Location", redirect.String())
		w.WriteHeader(http.StatusFound)
		return
	}
	writePlain(w, http.StatusBadRequest, fmt.Sprintf("%s: %s", code, desc))
}

func tokenError(w http.ResponseWriter, status int, code, desc string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "error_description": desc})
}

func writePlain(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(msg))
}

func splitScopes(s string) []string {
	out := []string{}
	for _, f := range splitFields(s) {
		out = append(out, f)
	}
	return out
}

func joinScopes(scopes []string) string {
	res := ""
	for i, sc := range scopes {
		if i > 0 {
			res += " "
		}
		res += sc
	}
	return res
}

func splitFields(s string) []string {
	var out []string
	cur := ""
	for _, c := range s {
		if c == ' ' || c == '+' {
			if cur != "" {
				out = append(out, cur)
				cur = ""
			}
		} else {
			cur += string(c)
		}
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
