package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"useful.dev/source/internal/config"
)

func devServer() *Server {
	cfg := &config.Config{Environment: config.EnvDevelopment, BaseURL: "https://src.example"}
	return NewServer(cfg, NewSigner([]byte("test-secret"), "https://src.example"))
}

func pkcePair() (verifier, challenge string) {
	buf := make([]byte, 32)
	_, _ = rand.Read(buf)
	verifier = base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return
}

// authorizeAndGetCode 驱动一次授权，返回回跳 URL 里的 code 与 state。
func authorizeAndGetCode(t *testing.T, s *Server, challenge, redirect, state string) (string, string) {
	t.Helper()
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", "useful-desktop")
	q.Set("redirect_uri", redirect)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	q.Set("scope", "profile entitlements downloads")
	q.Set("login_hint", "user-42")
	r := httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	s.Authorize(w, r)
	if w.Code != http.StatusFound {
		t.Fatalf("authorize 应 302，实际 %d: %s", w.Code, w.Body.String())
	}
	loc, _ := url.Parse(w.Header().Get("Location"))
	// token 绝不出现在回跳查询参数
	if loc.Query().Get("access_token") != "" || loc.Query().Get("token") != "" {
		t.Fatal("回跳 URL 不得包含 token")
	}
	return loc.Query().Get("code"), loc.Query().Get("state")
}

func exchangeToken(t *testing.T, s *Server, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	s.Token(w, r)
	return w
}

func TestAuthorizationCodePKCEFlow(t *testing.T) {
	s := devServer()
	verifier, challenge := pkcePair()
	redirect := "http://127.0.0.1:53112/callback"
	code, state := authorizeAndGetCode(t, s, challenge, redirect, "xyz-state")
	if code == "" {
		t.Fatal("未取得授权码")
	}
	if state != "xyz-state" {
		t.Fatalf("state 未原样回传: %s", state)
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {verifier},
		"redirect_uri":  {redirect},
		"client_id":     {"useful-desktop"},
	}
	w := exchangeToken(t, s, form)
	if w.Code != http.StatusOK {
		t.Fatalf("换码应 200，实际 %d: %s", w.Code, w.Body.String())
	}
	var tok struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &tok)
	if tok.TokenType != "Bearer" || tok.AccessToken == "" || tok.RefreshToken == "" {
		t.Fatalf("令牌响应不完整: %+v", tok)
	}
	claims, err := s.Signer.Verify(tok.AccessToken, time.Now())
	if err != nil || claims.Subject != "user-42" {
		t.Fatalf("访问令牌校验失败: %v %+v", err, claims)
	}
}

func TestPKCEMismatchRejected(t *testing.T) {
	s := devServer()
	_, challenge := pkcePair()
	redirect := "http://127.0.0.1:53112/callback"
	code, _ := authorizeAndGetCode(t, s, challenge, redirect, "s")
	// 用错误的 verifier
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"code_verifier": {"wrong-verifier"}, "redirect_uri": {redirect},
		"client_id": {"useful-desktop"},
	}
	w := exchangeToken(t, s, form)
	if w.Code == http.StatusOK {
		t.Fatal("PKCE 不匹配必须拒绝换码")
	}
}

func TestAuthorizationCodeSingleUse(t *testing.T) {
	s := devServer()
	verifier, challenge := pkcePair()
	redirect := "http://127.0.0.1:53112/callback"
	code, _ := authorizeAndGetCode(t, s, challenge, redirect, "s")
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"code_verifier": {verifier}, "redirect_uri": {redirect},
		"client_id": {"useful-desktop"},
	}
	if exchangeToken(t, s, form).Code != http.StatusOK {
		t.Fatal("首次换码应成功")
	}
	if exchangeToken(t, s, form).Code == http.StatusOK {
		t.Fatal("授权码必须单次使用，二次换码须失败")
	}
}

func TestRedirectMismatchRejected(t *testing.T) {
	s := devServer()
	verifier, challenge := pkcePair()
	code, _ := authorizeAndGetCode(t, s, challenge, "http://127.0.0.1:53112/callback", "s")
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"code_verifier": {verifier}, "redirect_uri": {"http://127.0.0.1:9999/other"},
		"client_id": {"useful-desktop"},
	}
	if exchangeToken(t, s, form).Code == http.StatusOK {
		t.Fatal("redirect_uri 不匹配必须拒绝")
	}
}

func TestImplicitFlowRejected(t *testing.T) {
	s := devServer()
	_, challenge := pkcePair()
	q := url.Values{}
	q.Set("response_type", "token") // implicit
	q.Set("client_id", "useful-desktop")
	q.Set("redirect_uri", "http://127.0.0.1:53112/cb")
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("login_hint", "u")
	r := httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	s.Authorize(w, r)
	// 回跳带 error，绝不发 token
	loc, _ := url.Parse(w.Header().Get("Location"))
	if loc.Query().Get("error") == "" {
		t.Fatalf("implicit flow 必须被拒绝: %s", w.Header().Get("Location"))
	}
}

func TestNonLoopbackRedirectRejected(t *testing.T) {
	s := devServer()
	_, challenge := pkcePair()
	for _, bad := range []string{
		"http://localhost:5000/cb", // 主机名而非 IP literal
		"https://evil.example/cb",  // 非 loopback
		"http://192.168.1.5/cb",    // 私网
	} {
		q := url.Values{}
		q.Set("response_type", "code")
		q.Set("client_id", "useful-desktop")
		q.Set("redirect_uri", bad)
		q.Set("code_challenge", challenge)
		q.Set("code_challenge_method", "S256")
		q.Set("login_hint", "u")
		r := httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil)
		w := httptest.NewRecorder()
		s.Authorize(w, r)
		if w.Code == http.StatusFound {
			t.Fatalf("非 loopback IP literal redirect 必须拒绝: %s", bad)
		}
	}
}

func TestPlainPKCERejected(t *testing.T) {
	s := devServer()
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", "useful-desktop")
	q.Set("redirect_uri", "http://127.0.0.1:5000/cb")
	q.Set("code_challenge", "abc")
	q.Set("code_challenge_method", "plain") // 必须 S256
	q.Set("login_hint", "u")
	r := httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	s.Authorize(w, r)
	loc, _ := url.Parse(w.Header().Get("Location"))
	if loc.Query().Get("error") == "" {
		t.Fatal("plain PKCE 必须拒绝")
	}
}

func TestPasswordGrantRejected(t *testing.T) {
	s := devServer()
	form := url.Values{"grant_type": {"password"}, "username": {"u"}, "password": {"p"}}
	if exchangeToken(t, s, form).Code == http.StatusOK {
		t.Fatal("password flow 必须被拒绝")
	}
}

func TestRefreshTokenFlow(t *testing.T) {
	s := devServer()
	verifier, challenge := pkcePair()
	redirect := "http://127.0.0.1:53112/callback"
	code, _ := authorizeAndGetCode(t, s, challenge, redirect, "s")
	w := exchangeToken(t, s, url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"code_verifier": {verifier}, "redirect_uri": {redirect}, "client_id": {"useful-desktop"},
	})
	var tok struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &tok)
	rw := exchangeToken(t, s, url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {tok.RefreshToken},
	})
	if rw.Code != http.StatusOK {
		t.Fatalf("refresh 应 200，实际 %d", rw.Code)
	}
}

func TestTokenIssuerMismatchRejected(t *testing.T) {
	// 一个源签发的令牌，另一个源（不同 issuer）必须拒绝——跨源令牌隔离
	signerA := NewSigner([]byte("secret-a"), "https://a.example")
	signerB := NewSigner([]byte("secret-b"), "https://b.example")
	tok, _ := signerA.Issue("user-1", "access", []string{"downloads"}, time.Hour, time.Now())
	if _, err := signerB.Verify(tok, time.Now()); err == nil {
		t.Fatal("跨源令牌（不同 issuer/secret）必须拒绝")
	}
}

func TestProductionAuthorizeNeedsRealIdP(t *testing.T) {
	cfg := &config.Config{Environment: config.EnvProduction, BaseURL: "https://src.example"}
	s := NewServer(cfg, NewSigner([]byte("s"), "https://src.example"))
	_, challenge := pkcePair()
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", "useful-desktop")
	q.Set("redirect_uri", "http://127.0.0.1:5000/cb")
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("login_hint", "u")
	r := httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	s.Authorize(w, r)
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("生产环境应要求真实 IdP（501），实际 %d", w.Code)
	}
}
