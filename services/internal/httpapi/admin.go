// 身份与 API Token 管理端点（scope: admin:identities / admin:tokens）。
// Token 明文只在创建响应返回一次；列表/审计绝不含明文或哈希。
package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"useful.dev/source/internal/auth"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/publishers"
)

func newID(prefix string) string {
	var buf [12]byte
	_, _ = rand.Read(buf[:])
	return prefix + hex.EncodeToString(buf[:])
}

func (s *Server) handleCreateIdentity(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID             string        `json:"id"`
		DisplayName    string        `json:"displayName"`
		Kind           string        `json:"kind"`
		Roles          []domain.Role `json:"roles"`
		PublisherKeyID string        `json:"publisherKeyId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	if !domain.IsLowercaseID(req.ID) {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "非法身份 ID")
		return
	}
	if req.Kind == "" {
		req.Kind = "user"
	}
	if req.Kind != "user" && req.Kind != "service-account" {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "kind 必须为 user|service-account")
		return
	}
	for _, role := range req.Roles {
		if !domain.IsValidRole(role) {
			writeProblem(w, r, http.StatusBadRequest, "invalid input", "非法角色: "+string(role))
			return
		}
	}
	if domain.HasPublisherRole(req.Roles) {
		if !domain.IsPublisherKey(req.PublisherKeyID) {
			writeProblem(w, r, http.StatusBadRequest, "invalid input", "publisher 角色必须绑定合法 publisherKeyId")
			return
		}
		if _, err := s.Repo.Publishers().GetByKeyID(r.Context(), req.PublisherKeyID); err != nil {
			writeProblem(w, r, http.StatusForbidden, "forbidden", "publisherKeyId 未登记")
			return
		}
	} else if req.PublisherKeyID != "" {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "非 publisher 角色不得设置 publisherKeyId")
		return
	}
	id := &domain.Identity{
		ID: req.ID, DisplayName: req.DisplayName, Kind: req.Kind,
		Roles: req.Roles, PublisherKeyID: req.PublisherKeyID,
		CreatedAt: time.Now().UTC(),
	}
	if err := s.Repo.Identities().CreateIdentity(r.Context(), id); err != nil {
		writeDomainErr(w, r, err)
		return
	}
	s.audit(r, "identity-created", "id="+id.ID+" roles="+rolesString(id.Roles))
	writeJSON(w, http.StatusCreated, id)
}

func rolesString(roles []domain.Role) string {
	out := ""
	for i, r := range roles {
		if i > 0 {
			out += ","
		}
		out += string(r)
	}
	return out
}

func (s *Server) handleListIdentities(w http.ResponseWriter, r *http.Request) {
	ids, err := s.Repo.Identities().ListIdentities(r.Context())
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"identities": ids})
}

// handleCreateAPIToken 签发 API Token。scopes 不得超出身份角色允许范围；
// 明文只出现在本次响应。
func (s *Server) handleCreateAPIToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IdentityID string   `json:"identityId"`
		Scopes     []string `json:"scopes"`
		TTLSeconds int64    `json:"ttlSeconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	identity, err := s.Repo.Identities().GetIdentity(r.Context(), req.IdentityID)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	if identity.Disabled {
		writeProblem(w, r, http.StatusForbidden, "forbidden", "身份已禁用")
		return
	}
	if !s.validIdentityPublisherBinding(r.Context(), identity) {
		writeProblem(w, r, http.StatusForbidden, "forbidden", "身份的 publisher 绑定无效")
		return
	}
	allowed := domain.ScopesForRoles(identity.Roles)
	if len(req.Scopes) == 0 {
		req.Scopes = allowed
	}
	for _, sc := range req.Scopes {
		if !domain.HasScope(allowed, sc) {
			writeProblem(w, r, http.StatusForbidden, "forbidden",
				"scope 超出身份角色允许范围: "+sc)
			return
		}
	}
	if req.TTLSeconds <= 0 || req.TTLSeconds > 366*24*3600 {
		req.TTLSeconds = 90 * 24 * 3600 // 默认 90 天
	}
	plaintext, hash, err := auth.NewAPIToken()
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "internal error", "")
		return
	}
	now := time.Now().UTC()
	tok := &domain.APIToken{
		ID: newID("tok_"), IdentityID: identity.ID, TokenHash: hash,
		Scopes: req.Scopes, ExpiresAt: now.Add(time.Duration(req.TTLSeconds) * time.Second),
		CreatedAt: now,
	}
	if err := s.Repo.Identities().CreateToken(r.Context(), tok); err != nil {
		writeDomainErr(w, r, err)
		return
	}
	s.audit(r, "api-token-created", "tokenId="+tok.ID+" identity="+identity.ID)
	writeJSON(w, http.StatusCreated, map[string]any{
		"tokenId":   tok.ID,
		"token":     plaintext, // 只显示一次，服务端只存哈希
		"scopes":    tok.Scopes,
		"expiresAt": tok.ExpiresAt.Format(time.RFC3339),
	})
}

func (s *Server) handleListAPITokens(w http.ResponseWriter, r *http.Request) {
	identityID := r.URL.Query().Get("identityId")
	if identityID == "" {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "需要 identityId")
		return
	}
	toks, err := s.Repo.Identities().ListTokensByIdentity(r.Context(), identityID)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	// APIToken.TokenHash 带 json:"-"，不会泄漏
	writeJSON(w, http.StatusOK, map[string]any{"tokens": toks})
}

func (s *Server) handleRevokeAPIToken(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "tokenId")
	if err := s.Repo.Identities().RevokeToken(r.Context(), id); err != nil {
		writeDomainErr(w, r, err)
		return
	}
	s.audit(r, "api-token-revoked", "tokenId="+id)
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request) {
	events, err := s.Repo.Audit().List(r.Context(), 200)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

// handleRegisterPublisher 登记发布者公钥（scope: admin:identities）。
// 只存公钥标识；可选 Sigstore 身份策略随初始密钥登记。
func (s *Server) handleRegisterPublisher(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID                 string `json:"id"`
		DisplayName        string `json:"displayName"`
		KeyID              string `json:"keyId"`
		IdentityIssuer     string `json:"identityIssuer"`
		IdentitySANExact   string `json:"identitySanExact"`
		IdentitySANPattern string `json:"identitySanPattern"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	if !domain.IsLowercaseID(req.ID) {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "非法发布者 ID")
		return
	}
	if !domain.IsPublisherKey(req.KeyID) {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "keyId 必须是 canonical ed25519 公钥或受控 Sigstore label")
		return
	}
	if req.DisplayName == "" || len(req.DisplayName) > 200 {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "displayName 长度非法")
		return
	}
	if domain.IsEd25519PublisherKey(req.KeyID) {
		if req.IdentityIssuer != "" || req.IdentitySANExact != "" || req.IdentitySANPattern != "" {
			writeProblem(w, r, http.StatusBadRequest, "invalid input", "Ed25519 publisher 不得携带 Sigstore identity policy")
			return
		}
	} else if err := publishers.ValidateIdentityPolicy(publishers.IdentityPolicy{
		PublisherKeyID: req.KeyID, Issuer: req.IdentityIssuer,
		SANExact: req.IdentitySANExact, SANPattern: req.IdentitySANPattern,
	}); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", err.Error())
		return
	}
	p := &domain.Publisher{
		ID: req.ID, DisplayName: req.DisplayName, KeyID: req.KeyID,
		CreatedAt:        time.Now().UTC(),
		IdentityIssuer:   req.IdentityIssuer,
		IdentitySANExact: req.IdentitySANExact, IdentitySANPattern: req.IdentitySANPattern,
	}
	if err := s.Repo.Publishers().Create(r.Context(), p); err != nil {
		writeDomainErr(w, r, err)
		return
	}
	s.audit(r, "publisher-registered", "id="+p.ID+" keyId="+p.KeyID)
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) handleListPublishers(w http.ResponseWriter, r *http.Request) {
	pubs, err := s.Repo.Publishers().List(r.Context())
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"publishers": pubs})
}
