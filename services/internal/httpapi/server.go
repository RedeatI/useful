// Package httpapi 装配 chi 路由：TRP v1 REST API。
// 统一 problem+json 错误、请求 ID、超时、请求体上限、每 IP 限流、结构化日志。
// 不记录 token、临时完整下载 URL、用户文件路径。
package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"useful.dev/source/internal/auth"
	"useful.dev/source/internal/billing"
	"useful.dev/source/internal/catalog"
	"useful.dev/source/internal/config"
	"useful.dev/source/internal/discovery"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/downloads"
	"useful.dev/source/internal/metrics"
	"useful.dev/source/internal/publishers"
	"useful.dev/source/internal/repository"
	"useful.dev/source/internal/storage"
	"useful.dev/source/internal/storage/fsstore"
)

type Server struct {
	Cfg              *config.Config
	Repo             repository.Repository
	Store            storage.Storage
	Catalog          *catalog.Service
	Publisher        *publishers.Service
	Grants           *downloads.Service
	Billing          billing.BillingProvider
	WebhookProcessor *billing.Processor
	OAuth            *auth.Server
	Signer           *auth.Signer
	Metrics          *metrics.Registry
	Log              *slog.Logger
}

// metricsReg 返回注册表（未注入时惰性创建，避免 nil）。
func (s *Server) metricsReg() *metrics.Registry {
	if s.Metrics == nil {
		s.Metrics = metrics.New()
	}
	return s.Metrics
}

// ---------- problem+json ----------

type problem struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Detail    string `json:"detail,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

func writeProblem(w http.ResponseWriter, r *http.Request, status int, title, detail string) {
	w.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(problem{
		Type: "about:blank", Title: title, Status: status, Detail: detail,
		RequestID: requestIDFrom(r.Context()),
	})
}

func writeDomainErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, domain.ErrNotFound):
		writeProblem(w, r, http.StatusNotFound, "not found", "")
	case errors.Is(err, domain.ErrConflict):
		writeProblem(w, r, http.StatusConflict, "conflict", err.Error())
	case errors.Is(err, domain.ErrInvalidInput):
		writeProblem(w, r, http.StatusBadRequest, "invalid input", err.Error())
	case errors.Is(err, domain.ErrForbidden):
		writeProblem(w, r, http.StatusForbidden, "forbidden", err.Error())
	case errors.Is(err, billing.ErrDisabled):
		writeProblem(w, r, http.StatusNotImplemented, "billing disabled", "该源未启用支付能力")
	default:
		writeProblem(w, r, http.StatusInternalServerError, "internal error", "")
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ---------- 中间件 ----------

type ctxKey string

const requestIDKey ctxKey = "request-id"

func requestIDFrom(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 请求 ID
		var buf [8]byte
		_, _ = rand.Read(buf[:])
		rid := hex.EncodeToString(buf[:])
		ctx := context.WithValue(r.Context(), requestIDKey, rid)
		w.Header().Set("X-Request-Id", rid)

		// 恢复 panic → 500（不泄露内部细节）
		defer func() {
			if p := recover(); p != nil {
				s.Log.Error("panic", "requestId", rid, "path", r.URL.Path, "panic", fmt.Sprint(p))
				writeProblem(w, r.WithContext(ctx), http.StatusInternalServerError, "internal error", "")
			}
		}()

		start := time.Now()
		next.ServeHTTP(w, r.WithContext(ctx))
		// 结构化日志（不含查询参数值，避免泄露搜索词以外的敏感内容）
		s.Log.Info("http",
			"requestId", rid, "method", r.Method, "path", r.URL.Path,
			"durMs", time.Since(start).Milliseconds())
	})
}

// 每 IP 简易滑动窗口限流。定期清理静默 IP 桶，防长期运行无界增长。
type rateLimiter struct {
	mu        sync.Mutex
	hits      map[string][]time.Time
	lastPurge time.Time
	limit     int
	window    time.Duration
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{hits: map[string][]time.Time{}, limit: limit, window: window}
}

func (rl *rateLimiter) allow(ip string, now time.Time) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	cutoff := now.Add(-rl.window)
	// 摊还式清理：每个窗口期扫一次全表，丢弃无活跃记录的 IP 桶
	if now.Sub(rl.lastPurge) > rl.window {
		for k, ts := range rl.hits {
			if len(ts) == 0 || !ts[len(ts)-1].After(cutoff) {
				delete(rl.hits, k)
			}
		}
		rl.lastPurge = now
	}
	kept := rl.hits[ip][:0]
	for _, t := range rl.hits[ip] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= rl.limit {
		rl.hits[ip] = kept
		return false
	}
	rl.hits[ip] = append(kept, now)
	return true
}

func (s *Server) rateLimit(rl *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := r.RemoteAddr
			if i := strings.LastIndex(ip, ":"); i > 0 {
				ip = ip[:i]
			}
			if !rl.allow(ip, time.Now()) {
				writeProblem(w, r, http.StatusTooManyRequests, "rate limited", "请求过于频繁")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ---------- 认证与 RBAC ----------

// principal 已认证的管理/发布者主体。
type principal struct {
	Actor          string
	Scopes         []string
	Roles          []domain.Role
	PublisherKeyID string
}

const principalKey ctxKey = "principal"

func principalFrom(ctx context.Context) *principal {
	if p, ok := ctx.Value(principalKey).(*principal); ok {
		return p
	}
	return &principal{Actor: "unknown"}
}

func (s *Server) validIdentityPublisherBinding(ctx context.Context, id *domain.Identity) bool {
	if !domain.RolesValid(id.Roles) {
		return false
	}
	if !domain.HasPublisherRole(id.Roles) {
		return id.PublisherKeyID == ""
	}
	if !domain.IsPublisherKey(id.PublisherKeyID) {
		return false
	}
	_, err := s.Repo.Publishers().GetByKeyID(ctx, id.PublisherKeyID)
	return err == nil
}

func scopesWithin(scopes, allowed []string) bool {
	for _, scope := range scopes {
		if !domain.HasScope(allowed, scope) {
			return false
		}
	}
	return true
}

func principalHasGlobalPublisherScope(p *principal, scope string) bool {
	if domain.HasRole(p.Roles, domain.RoleInstanceAdmin) || domain.HasRole(p.Roles, domain.RoleSourceAdmin) {
		return true
	}
	return scope == domain.ScopePublisherAdvisory && domain.HasRole(p.Roles, domain.RoleSecurityReviewer)
}

func (s *Server) authorizePublisher(w http.ResponseWriter, r *http.Request, publisherKeyID, scope string) bool {
	p := principalFrom(r.Context())
	if principalHasGlobalPublisherScope(p, scope) ||
		(domain.HasPublisherRole(p.Roles) && p.PublisherKeyID == publisherKeyID) {
		return true
	}
	// Conceal whether a tenant-scoped resource exists. Cross-tenant and missing
	// opaque identifiers share the same generic response.
	writeProblem(w, r, http.StatusNotFound, "not found", "")
	return false
}

// authenticateAdmin 解析管理/发布者凭据：
//  1. Authorization: Bearer usefuls_… → API Token（哈希查询，检查撤销/过期/禁用）；
//  2. X-Admin-Token → 仅限开发环境或紧急恢复模式（短期、审计）。
func (s *Server) authenticateAdmin(r *http.Request) (*principal, bool) {
	now := time.Now()
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		raw := strings.TrimSpace(h[len("Bearer "):])
		if auth.IsAPIToken(raw) {
			tok, err := s.Repo.Identities().GetTokenByHash(r.Context(), auth.HashAPIToken(raw))
			if err != nil || !tok.Usable(now) {
				return nil, false
			}
			id, err := s.Repo.Identities().GetIdentity(r.Context(), tok.IdentityID)
			if err != nil || id.Disabled || !s.validIdentityPublisherBinding(r.Context(), id) ||
				!scopesWithin(tok.Scopes, domain.ScopesForRoles(id.Roles)) {
				return nil, false
			}
			// 记录最后使用时间（失败不阻断）
			_ = s.Repo.Identities().TouchToken(r.Context(), tok.ID, now)
			return &principal{
				Actor: id.ID, Scopes: tok.Scopes, Roles: id.Roles,
				PublisherKeyID: id.PublisherKeyID,
			}, true
		}
	}
	if t := r.Header.Get("X-Admin-Token"); t != "" && s.Cfg.AdminToken != "" &&
		subtle.ConstantTimeCompare([]byte(t), []byte(s.Cfg.AdminToken)) == 1 {
		switch {
		case s.Cfg.Environment == config.EnvDevelopment:
			return &principal{Actor: "dev-admin", Scopes: domain.AllScopes(), Roles: []domain.Role{domain.RoleInstanceAdmin}}, true
		case s.Cfg.EmergencyAdminActive(now):
			// 紧急恢复：只给最小管理能力（身份/令牌管理），并强制审计
			_ = s.Repo.Audit().Append(r.Context(), &domain.AuditEvent{
				At: now, Actor: "emergency-admin", Action: "emergency-access",
				Detail: r.Method + " " + r.URL.Path,
			})
			return &principal{Actor: "emergency-admin",
				Scopes: []string{domain.ScopeAdminIdentities, domain.ScopeAdminTokens}}, true
		}
	}
	return nil, false
}

// requireScope RBAC 门禁：认证 + scope 检查，principal 注入请求上下文。
func (s *Server) requireScope(scope string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := s.authenticateAdmin(r)
		if !ok {
			writeProblem(w, r, http.StatusUnauthorized, "unauthorized", "需要有效的 API Token")
			return
		}
		if !domain.HasScope(p.Scopes, scope) {
			writeProblem(w, r, http.StatusForbidden, "forbidden", "缺少 scope: "+scope)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), principalKey, p)))
	}
}

// audit 敏感操作写 append-only 审计（不记录 token/完整 URL）。
func (s *Server) audit(r *http.Request, action, detail string) {
	_ = s.Repo.Audit().Append(r.Context(), &domain.AuditEvent{
		At: time.Now().UTC(), Actor: principalFrom(r.Context()).Actor,
		Action: action, Detail: detail,
	})
}

// ---------- 路由 ----------

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(s.middleware)
	rl := newRateLimiter(300, 10*time.Second)
	r.Use(s.rateLimit(rl))

	r.Get("/.well-known/useful-repository.json", s.handleDiscovery)
	r.Get("/metrics", s.handleMetrics)
	r.Get("/metadata/{name}", s.handleMetadata)
	r.Get("/targets/{name}", s.handleTarget)
	r.Get("/v1/blobs/{token}", s.handleBlob)

	// OAuth2 授权服务器（Authorization Code + PKCE）
	if s.OAuth != nil {
		r.Get("/oauth/authorize", s.OAuth.Authorize)
		r.Post("/oauth/token", s.OAuth.Token)
	}

	r.Route("/v1", func(v chi.Router) {
		v.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		})
		v.Get("/ready", s.handleReady)
		v.Get("/source", s.handleSource)
		v.Get("/catalog/snapshot", s.handleCatalogSnapshot)
		v.Get("/catalog/search", s.handleCatalogSearch)
		v.Get("/tools/{publisherId}/{toolId}", s.handleTool)
		v.Get("/tools/{publisherId}/{toolId}/versions", s.handleToolVersions)
		v.Get("/tools/{publisherId}/{toolId}/advisories", s.handleToolAdvisories)

		// Phase 8：需 bearer（匿名仍可用免费源）
		v.Get("/me", s.handleMe)
		v.Get("/me/entitlements", s.handleMyEntitlements)

		v.Post("/download-grants", s.limitBody(s.handleCreateGrant))
		v.Get("/download-grants/{grantId}", s.handleGetGrant)

		v.Post("/publisher/upload-sessions", s.requireScope(domain.ScopePublisherWrite, s.limitBody(s.handleCreateUpload)))
		v.Put("/publisher/upload-sessions/{id}/content", s.requireScope(domain.ScopePublisherWrite, s.handleUploadContent))
		v.Post("/publisher/releases", s.requireScope(domain.ScopePublisherWrite, s.limitBody(s.handleCreateRelease)))
		v.Get("/publisher/releases/{releaseId}", s.requireScope(domain.ScopePublisherWrite, s.handleGetRelease))
		v.Post("/publisher/releases/{releaseId}/review", s.requireScope(domain.ScopeReviewWrite, s.limitBody(s.handleReview)))
		v.Post("/publisher/releases/{releaseId}/withdraw", s.requireScope(domain.ScopePublisherWithdraw, s.limitBody(s.handleWithdraw)))
		v.Post("/publisher/advisories", s.requireScope(domain.ScopePublisherAdvisory, s.limitBody(s.handleCreateAdvisory)))
		v.Post("/publisher/keys/rotate", s.requireScope(domain.ScopePublisherKeys, s.limitBody(s.handleRotateKey)))

		// 身份与 API Token 管理（instance-admin / source-admin）
		v.Post("/admin/identities", s.requireScope(domain.ScopeAdminIdentities, s.limitBody(s.handleCreateIdentity)))
		v.Get("/admin/identities", s.requireScope(domain.ScopeAdminIdentities, s.handleListIdentities))
		v.Post("/admin/api-tokens", s.requireScope(domain.ScopeAdminTokens, s.limitBody(s.handleCreateAPIToken)))
		v.Get("/admin/api-tokens", s.requireScope(domain.ScopeAdminTokens, s.handleListAPITokens))
		v.Post("/admin/api-tokens/{tokenId}/revoke", s.requireScope(domain.ScopeAdminTokens, s.handleRevokeAPIToken))
		v.Get("/admin/audit", s.requireScope(domain.ScopeAdminIdentities, s.handleListAudit))
		// 发布者登记（E2E/自托管初始化路径；只存公钥）
		v.Post("/admin/publishers", s.requireScope(domain.ScopeAdminIdentities, s.limitBody(s.handleRegisterPublisher)))
		v.Get("/admin/publishers", s.requireScope(domain.ScopeAdminIdentities, s.handleListPublishers))

		v.Post("/billing/checkout-sessions", s.limitBody(s.handleCheckout))
		v.Post("/billing/customer-portal", s.limitBody(s.handlePortal))
		v.Post("/billing/webhooks/{provider}", s.handleWebhook)
	})
	return r
}

// limitBody 普通 JSON 端点的请求体上限。
func (s *Server) limitBody(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, s.Cfg.MaxRequestBody)
		next(w, r)
	}
}

// ---------- 基础端点 ----------

func (s *Server) rootSHA256(ctx context.Context) (string, error) {
	rc, _, err := s.Store.Get(ctx, "metadata/1.root.json")
	if err != nil {
		return "", err
	}
	defer rc.Close()
	h := sha256.New()
	if _, err := io.Copy(h, rc); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (s *Server) handleDiscovery(w http.ResponseWriter, r *http.Request) {
	rootSHA, err := s.rootSHA256(r.Context())
	if err != nil {
		writeProblem(w, r, http.StatusServiceUnavailable, "not initialized", "源尚未初始化 TUF root")
		return
	}
	writeJSON(w, http.StatusOK, discovery.Build(s.Cfg, rootSHA))
}

func (s *Server) handleSource(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"id": s.Cfg.SourceID, "name": s.Cfg.SourceName, "operator": s.Cfg.SourceOperator,
	})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if err := s.Repo.Ping(r.Context()); err != nil {
		writeProblem(w, r, http.StatusServiceUnavailable, "not ready", "")
		return
	}
	depth, _ := s.Repo.Jobs().Depth(r.Context())
	s.metricsReg().SetGauge(metrics.JobQueueDepth, int64(depth))
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "jobQueueDepth": depth})
}

// handleMetrics Prometheus 文本格式指标（刷新队列深度与 source health 瞬时值）。
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	reg := s.metricsReg()
	if depth, err := s.Repo.Jobs().Depth(r.Context()); err == nil {
		reg.SetGauge(metrics.JobQueueDepth, int64(depth))
	}
	// source health 瞬时统计（读最近检查结果，不同步探测）
	if checks, err := s.Repo.Availability().ListAll(r.Context()); err == nil {
		var healthy, unavail int64
		now := time.Now()
		for _, c := range checks {
			switch c.Effective(now) {
			case domain.AvailabilityHealthy:
				healthy++
			case domain.AvailabilityUnavailable:
				unavail++
			}
		}
		reg.SetGauge(metrics.SourceHealthy, healthy)
		reg.SetGauge(metrics.SourceUnavailable, unavail)
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(reg.Render()))
}

// ---------- 目录 ----------

func (s *Server) handleCatalogSnapshot(w http.ResponseWriter, r *http.Request) {
	// 走带 TTL 的缓存快照；发布侧变更时显式失效，绝不每请求全量重建
	snap, err := s.Catalog.CachedSnapshot(r.Context(), time.Now())
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handleCatalogSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if len(q) > 256 {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "搜索词过长")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	entries, err := s.Catalog.Search(r.Context(), q, limit, time.Now())
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (s *Server) handleTool(w http.ResponseWriter, r *http.Request) {
	pub, tool := chi.URLParam(r, "publisherId"), chi.URLParam(r, "toolId")
	t, err := s.Repo.Tools().Get(r.Context(), pub, tool)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleToolVersions(w http.ResponseWriter, r *http.Request) {
	pub, tool := chi.URLParam(r, "publisherId"), chi.URLParam(r, "toolId")
	arts, err := s.Repo.Artifacts().ListPublished(r.Context())
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	out := []map[string]any{}
	for _, a := range arts {
		if a.PublisherKeyID == pub && a.ToolID == tool {
			out = append(out, map[string]any{
				"version": a.Version, "channel": a.Channel,
				"platform": a.Platform, "arch": a.Arch,
				"artifactSha256": a.SHA256, "size": a.Size,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": out})
}

// handleToolAdvisories 工具维度安全公告列表（公开可读，已安装用户轮询）。
func (s *Server) handleToolAdvisories(w http.ResponseWriter, r *http.Request) {
	pub, tool := chi.URLParam(r, "publisherId"), chi.URLParam(r, "toolId")
	advs, err := s.Repo.Advisories().ListByTool(r.Context(), pub, tool)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	if advs == nil {
		advs = []*domain.SecurityAdvisory{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"advisories": advs})
}

// subjectFromBearer 从 Authorization: Bearer 提取并校验访问令牌，返回 (subject, scopes, ok)。
// 无令牌/无效令牌返回 ok=false（调用方决定匿名是否允许）。
func (s *Server) subjectFromBearer(r *http.Request) (*auth.TokenClaims, bool) {
	if s.Signer == nil {
		return nil, false
	}
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return nil, false
	}
	claims, err := s.Signer.Verify(strings.TrimSpace(h[len(prefix):]), time.Now())
	if err != nil || claims.Type != "access" {
		return nil, false
	}
	return claims, true
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.subjectFromBearer(r)
	if !ok {
		writeProblem(w, r, http.StatusUnauthorized, "unauthorized", "需要有效的访问令牌")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"subjectId": claims.Subject, "scopes": claims.Scopes,
	})
}

func (s *Server) handleMyEntitlements(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.subjectFromBearer(r)
	if !ok {
		writeProblem(w, r, http.StatusUnauthorized, "unauthorized", "需要有效的访问令牌")
		return
	}
	ents, err := s.Repo.Entitlements().ListBySubject(r.Context(), claims.Subject)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entitlements": ents})
}

// ---------- 下载授权 ----------

func (s *Server) handleCreateGrant(w http.ResponseWriter, r *http.Request) {
	var req downloads.GrantRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	// 付费制品的 subject 只来自校验过的 bearer，绝不信任请求体
	if claims, ok := s.subjectFromBearer(r); ok {
		req.SubjectID = claims.Subject
	} else {
		req.SubjectID = ""
	}
	g, err := s.Grants.Create(r.Context(), &req)
	if err != nil {
		s.metricsReg().Inc(metrics.DownloadAuthFailures)
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"grantId":        g.ID,
		"artifactSha256": g.ArtifactSHA256,
		"size":           g.Size,
		"downloadUrl":    absoluteURL(s.Cfg, g.DownloadURL),
		"expiresAt":      g.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z"),
		"supportsRange":  g.SupportsRange,
	})
}

func (s *Server) handleGetGrant(w http.ResponseWriter, r *http.Request) {
	g, err := s.Grants.Get(r.Context(), chi.URLParam(r, "grantId"))
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	status := "active"
	if g.Expired(time.Now()) {
		status = "expired" // 过期后客户端应重新申请 grant
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"grantId": g.ID, "artifactSha256": g.ArtifactSHA256, "size": g.Size,
		"expiresAt": g.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z"), "status": status,
	})
}

func absoluteURL(cfg *config.Config, path string) string {
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return path
	}
	return strings.TrimRight(cfg.BaseURL, "/") + path
}

// ---------- 发布者 ----------

func (s *Server) handleCreateUpload(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PublisherKeyID string `json:"publisherKeyId"`
		SHA256         string `json:"sha256"`
		Size           int64  `json:"size"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	if !s.authorizePublisher(w, r, req.PublisherKeyID, domain.ScopePublisherWrite) {
		return
	}
	sess, err := s.Publisher.CreateUploadSession(r.Context(), req.PublisherKeyID, req.SHA256, req.Size)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"uploadSessionId": sess.ID,
		"uploadUrl":       fmt.Sprintf("/v1/publisher/upload-sessions/%s/content", sess.ID),
	})
}

func (s *Server) handleUploadContent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sess, err := s.Repo.Uploads().Get(r.Context(), id)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	if !s.authorizePublisher(w, r, sess.PublisherKeyID, domain.ScopePublisherWrite) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.Cfg.MaxUploadSize)
	if err := s.Publisher.ReceiveContent(r.Context(), id, r.Body); err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "completed"})
}

func (s *Server) handleCreateRelease(w http.ResponseWriter, r *http.Request) {
	var req publishers.ReleaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	sess, err := s.Repo.Uploads().Get(r.Context(), req.UploadSessionID)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	if !s.authorizePublisher(w, r, sess.PublisherKeyID, domain.ScopePublisherWrite) {
		return
	}
	req.Actor = principalFrom(r.Context()).Actor
	art, err := s.Publisher.CreateRelease(r.Context(), &req)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, art)
}

func (s *Server) handleGetRelease(w http.ResponseWriter, r *http.Request) {
	art, err := s.Repo.Artifacts().Get(r.Context(), chi.URLParam(r, "releaseId"))
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	if !s.authorizePublisher(w, r, art.PublisherKeyID, domain.ScopePublisherWrite) {
		return
	}
	writeJSON(w, http.StatusOK, art)
}

func (s *Server) handleReview(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Decision string `json:"decision"` // approved|rejected
		Note     string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	id := chi.URLParam(r, "releaseId")
	actor := principalFrom(r.Context()).Actor
	var err error
	switch req.Decision {
	case "approved":
		err = s.Publisher.Approve(r.Context(), id, actor)
	case "rejected":
		err = s.Publisher.Reject(r.Context(), id, actor, req.Note)
	default:
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "decision 必须为 approved|rejected")
		return
	}
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": req.Decision})
}

// handleWithdraw 撤回已发布制品：记录保留、新用户不能下载、metadata 重签。
func (s *Server) handleWithdraw(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	if len(req.Reason) > 2000 {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "reason 过长")
		return
	}
	releaseID := chi.URLParam(r, "releaseId")
	art, err := s.Repo.Artifacts().Get(r.Context(), releaseID)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	if !s.authorizePublisher(w, r, art.PublisherKeyID, domain.ScopePublisherWithdraw) {
		return
	}
	if err := s.Publisher.Withdraw(r.Context(), releaseID, req.Reason, principalFrom(r.Context()).Actor); err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "withdrawn"})
}

// handleCreateAdvisory 发布安全公告（已安装用户通过 catalog/advisories 可见）。
func (s *Server) handleCreateAdvisory(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PublisherKeyID   string   `json:"publisherKeyId"`
		ToolID           string   `json:"toolId"`
		Severity         string   `json:"severity"`
		Summary          string   `json:"summary"`
		AffectedVersions []string `json:"affectedVersions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	if len(req.AffectedVersions) > 256 {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "affectedVersions 数量超限")
		return
	}
	adv := &domain.SecurityAdvisory{
		PublisherKeyID:   req.PublisherKeyID,
		ToolID:           req.ToolID,
		Severity:         domain.AdvisorySeverity(req.Severity),
		Summary:          req.Summary,
		AffectedVersions: req.AffectedVersions,
	}
	if !s.authorizePublisher(w, r, adv.PublisherKeyID, domain.ScopePublisherAdvisory) {
		return
	}
	if _, err := s.Repo.Tools().Get(r.Context(), adv.PublisherKeyID, adv.ToolID); err != nil {
		writeDomainErr(w, r, err)
		return
	}
	if err := s.Publisher.CreateAdvisory(r.Context(), adv, principalFrom(r.Context()).Actor); err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, adv)
}

// handleRotateKey 登记发布者密钥轮换（需旧密钥交叉签名证明连续性）。
func (s *Server) handleRotateKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OldKeyID       string `json:"oldKeyId"`
		NewKeyID       string `json:"newKeyId"`
		CrossSignature string `json:"crossSignature"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	oldKey, err := s.Repo.Publishers().GetKey(r.Context(), req.OldKeyID)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	if !s.authorizePublisher(w, r, oldKey.KeyID, domain.ScopePublisherKeys) {
		return
	}
	if err := s.Publisher.RotateKey(r.Context(), req.OldKeyID, req.NewKeyID, req.CrossSignature, principalFrom(r.Context()).Actor); err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "rotated", "newKeyId": req.NewKeyID})
}

// ---------- billing ----------

func (s *Server) handleCheckout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CustomerID string `json:"customerId"`
		ProductID  string `json:"productId"`
		PlanID     string `json:"planId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	cs, err := s.Billing.CreateCheckoutSession(r.Context(), req.CustomerID, req.ProductID, req.PlanID)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, cs)
}

func (s *Server) handlePortal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CustomerID string `json:"customerId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "JSON 解析失败")
		return
	}
	url, err := s.Billing.CreateCustomerPortalSession(r.Context(), req.CustomerID)
	if err != nil {
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

// handleWebhook 原始体验签 + 幂等处理；快速确认，长任务不在此执行。
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if provider != s.Billing.Name() {
		writeProblem(w, r, http.StatusNotFound, "unknown provider", "")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.Cfg.MaxRequestBody))
	if err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "读取请求体失败")
		return
	}
	dup, err := s.WebhookProcessor.Handle(r.Context(), body, r.Header.Get("X-Webhook-Signature"))
	if err != nil {
		s.metricsReg().Inc(metrics.WebhookFailures)
		writeDomainErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": true, "duplicate": dup})
}

// ---------- metadata / targets / blobs ----------

var metadataNameOK = func(name string) bool {
	if len(name) == 0 || len(name) > 64 {
		return false
	}
	// 防御性拒绝 "." 序列（即使无分隔符不构成穿越，仍拒绝以保持与 target 路径一致的严格态度）
	if strings.Contains(name, "..") {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '-') {
			return false
		}
	}
	return strings.HasSuffix(name, ".json")
}

func (s *Server) handleMetadata(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !metadataNameOK(name) {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "非法 metadata 名")
		return
	}
	rc, info, err := s.Store.Get(r.Context(), "metadata/"+name)
	if err != nil {
		writeProblem(w, r, http.StatusNotFound, "not found", "")
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	_, _ = io.Copy(w, rc)
}

// handleTarget serves TUF consistent-snapshot paths. Logical metadata targets
// are <stable-identity-sha256>.useful; the HTTP path adds the artifact hash once:
// <artifact-sha256>.<logical-target>.
func (s *Server) handleTarget(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if len(name) != 136 || name[64] != '.' || name[129:] != ".useful" ||
		!domain.IsSHA256(name[:64]) || !domain.IsSHA256(name[65:129]) {
		writeProblem(w, r, http.StatusBadRequest, "invalid input", "非法 target 路径")
		return
	}
	sha := name[:64]
	logicalName := name[65:]
	arts, err := s.Repo.Artifacts().ListPublished(r.Context())
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "internal error", "")
		return
	}
	var art *domain.Artifact
	for _, candidate := range arts {
		if candidate.SHA256 != sha {
			continue
		}
		expectedLogical, targetErr := publishers.ArtifactTargetName(candidate)
		if targetErr == nil && logicalName == expectedLogical &&
			name == sha+"."+expectedLogical && publishers.ValidateArtifactPublisherTrust(candidate) == nil {
			art = candidate
			break
		}
	}
	if art == nil {
		writeProblem(w, r, http.StatusNotFound, "not found", "")
		return
	}
	tool, err := s.Repo.Tools().Get(r.Context(), art.PublisherKeyID, art.ToolID)
	if err != nil || tool.AccessMode != "free" {
		// 付费制品不走公开 targets 路径：必须 download grant
		writeProblem(w, r, http.StatusForbidden, "forbidden", "需要下载授权")
		return
	}
	s.serveBlob(w, r, storage.PublishedKey(sha))
}

// handleBlob 兑换 filesystem storage 的短期下载令牌（Range 支持）。
func (s *Server) handleBlob(w http.ResponseWriter, r *http.Request) {
	fss, ok := s.Store.(*fsstore.FilesystemStorage)
	if !ok {
		writeProblem(w, r, http.StatusNotFound, "not found", "")
		return
	}
	key, err := fss.ResolveToken(chi.URLParam(r, "token"), time.Now())
	if err != nil {
		writeProblem(w, r, http.StatusForbidden, "forbidden", "下载令牌无效或已过期，请重新申请授权")
		return
	}
	s.serveBlob(w, r, key)
}

// serveBlob 流式返回对象；filesystem 后端用 http.ServeFile 提供 Range。
func (s *Server) serveBlob(w http.ResponseWriter, r *http.Request, key string) {
	if fss, ok := s.Store.(*fsstore.FilesystemStorage); ok {
		p, err := fss.PathOf(key)
		if err != nil {
			writeProblem(w, r, http.StatusNotFound, "not found", "")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeFile(w, r, p)
		return
	}
	// 其他后端：短期 URL 重定向（S3 presigned）
	url, err := s.Store.CreateDownloadURL(r.Context(), key, 5*time.Minute)
	if err != nil {
		writeProblem(w, r, http.StatusNotFound, "not found", "")
		return
	}
	http.Redirect(w, r, url, http.StatusFound)
}
