// Package auth 实现源自身作为 OAuth2 授权服务器：Authorization Code + PKCE(S256)。
// 令牌为 HMAC-SHA256 签名的不透明 bearer（源专属密钥签发，跨源不通用）。
// 绝不实现 implicit / password flow；不内嵌 client secret（PKCE 公开客户端）。
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// TokenClaims 访问/刷新令牌载荷。
type TokenClaims struct {
	Subject string   `json:"sub"`
	Issuer  string   `json:"iss"`
	Scopes  []string `json:"scopes"`
	Type    string   `json:"typ"` // access | refresh
	Expires int64    `json:"exp"` // unix 秒
}

// Signer 用源专属密钥签发/校验令牌。
type Signer struct {
	secret []byte
	issuer string
}

func NewSigner(secret []byte, issuer string) *Signer {
	return &Signer{secret: secret, issuer: issuer}
}

func (s *Signer) sign(payload []byte) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Issue 生成一个签名令牌。
func (s *Signer) Issue(subject, tokenType string, scopes []string, ttl time.Duration, now time.Time) (string, error) {
	claims := TokenClaims{
		Subject: subject, Issuer: s.issuer, Scopes: scopes,
		Type: tokenType, Expires: now.Add(ttl).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	return s.sign(payload), nil
}

// Verify 校验令牌签名与过期，返回 claims。
func (s *Signer) Verify(token string, now time.Time) (*TokenClaims, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("令牌格式非法")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("令牌格式非法")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("令牌格式非法")
	}
	mac := hmac.New(sha256.New, s.secret)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, fmt.Errorf("令牌签名无效")
	}
	var claims TokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("令牌载荷非法")
	}
	if claims.Issuer != s.issuer {
		return nil, fmt.Errorf("issuer 不匹配")
	}
	if now.Unix() >= claims.Expires {
		return nil, fmt.Errorf("令牌已过期")
	}
	return &claims, nil
}

// VerifyPKCE 校验 code_verifier 与 code_challenge（S256）。
func VerifyPKCE(codeVerifier, codeChallenge string) bool {
	sum := sha256.Sum256([]byte(codeVerifier))
	computed := base64.RawURLEncoding.EncodeToString(sum[:])
	return hmac.Equal([]byte(computed), []byte(codeChallenge))
}
