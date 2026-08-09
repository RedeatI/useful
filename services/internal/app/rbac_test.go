// RBAC 与 API Token 认证测试：正向 + 负向（错误 scope、撤销、过期、匿名、
// 生产禁用静态 Admin Token、紧急恢复模式边界）。
package app_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	authpkg "useful.dev/source/internal/auth"
	"useful.dev/source/internal/config"
	"useful.dev/source/internal/domain"
)

// issueToken 为指定角色创建身份并签发 API Token（返回明文）。
func (e *env) issueToken(t *testing.T, id string, roles []domain.Role, scopes []string, ttl time.Duration) string {
	t.Helper()
	now := time.Now().UTC()
	binding := ""
	if domain.HasPublisherRole(roles) {
		binding = publisherKey
	}
	_ = e.repo.Identities().CreateIdentity(context.Background(), &domain.Identity{
		ID: id, DisplayName: id, Kind: "service-account", Roles: roles,
		PublisherKeyID: binding, CreatedAt: now,
	})
	plaintext, hash, err := authpkg.NewAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	if scopes == nil {
		scopes = domain.ScopesForRoles(roles)
	}
	if err := e.repo.Identities().CreateToken(context.Background(), &domain.APIToken{
		ID: "tok_" + id, IdentityID: id, TokenHash: hash,
		Scopes: scopes, ExpiresAt: now.Add(ttl), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	return plaintext
}

func TestRBAC_ScopeEnforcement(t *testing.T) {
	e := newEnv(t)

	// reviewer 只有 review:write：创建上传会话（publisher:write）必须 403
	reviewer := e.issueToken(t, "rev1", []domain.Role{domain.RoleReviewer}, nil, time.Hour)
	resp := e.postJSONBearer("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey, "sha256": strings.Repeat("ab", 32), "size": 10,
	}, reviewer)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer 创建上传会话应 403，得到 %d", resp.StatusCode)
	}

	// publisher-maintainer 只有 publisher:write：撤回必须 403
	maint := e.issueToken(t, "maint1", []domain.Role{domain.RolePublisherMaintainer}, nil, time.Hour)
	resp = e.postJSONBearer("/v1/publisher/releases/whatever/withdraw",
		map[string]any{"reason": "x"}, maint)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("maintainer 撤回应 403，得到 %d", resp.StatusCode)
	}

	// 匿名访问发布端点必须 401
	resp = e.postJSON("/v1/publisher/releases/whatever/withdraw", map[string]any{"reason": "x"}, false)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("匿名撤回应 401，得到 %d", resp.StatusCode)
	}
}

func TestRBAC_RevokedAndExpiredTokens(t *testing.T) {
	e := newEnv(t)

	// 撤销后 401
	tok := e.issueToken(t, "sa-revoke", []domain.Role{domain.RoleInstanceAdmin}, nil, time.Hour)
	if err := e.repo.Identities().RevokeToken(context.Background(), "tok_sa-revoke"); err != nil {
		t.Fatal(err)
	}
	resp := e.postJSONBearer("/v1/admin/identities", map[string]any{"id": "nope"}, tok)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("撤销 token 应 401，得到 %d", resp.StatusCode)
	}

	// 过期后 401（ttl 为负值模拟已过期）
	expired := e.issueToken(t, "sa-expired", []domain.Role{domain.RoleInstanceAdmin}, nil, -time.Minute)
	resp = e.postJSONBearer("/v1/admin/identities", map[string]any{"id": "nope2"}, expired)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("过期 token 应 401，得到 %d", resp.StatusCode)
	}

	// 伪造 token（正确前缀 + 随机内容）401
	resp = e.postJSONBearer("/v1/admin/identities", map[string]any{"id": "nope3"},
		authpkg.APITokenPrefix+strings.Repeat("ff", 32))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("伪造 token 应 401，得到 %d", resp.StatusCode)
	}
}

func TestRBAC_TokenLifecycleViaAPI(t *testing.T) {
	e := newEnv(t)

	// instance-admin 创建 reviewer 身份
	resp := e.postJSON("/v1/admin/identities", map[string]any{
		"id": "reviewer-x", "displayName": "Reviewer X", "roles": []string{"reviewer"},
	}, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("创建身份失败: %d", resp.StatusCode)
	}

	// 为 reviewer 申请超出角色的 scope 必须 403（权限不可提升）
	resp = e.postJSON("/v1/admin/api-tokens", map[string]any{
		"identityId": "reviewer-x", "scopes": []string{domain.ScopeAdminTokens},
	}, true)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("scope 提升应 403，得到 %d", resp.StatusCode)
	}

	// 正常签发：明文只出现一次
	created := decode[map[string]any](t, e.postJSON("/v1/admin/api-tokens", map[string]any{
		"identityId": "reviewer-x",
	}, true))
	plaintext, _ := created["token"].(string)
	if !strings.HasPrefix(plaintext, authpkg.APITokenPrefix) {
		t.Fatalf("响应缺少 token 明文")
	}
	tokenID, _ := created["tokenId"].(string)

	// 数据库中绝不出现明文
	stored, err := e.repo.Identities().GetTokenByHash(context.Background(), authpkg.HashAPIToken(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	if stored.TokenHash == plaintext {
		t.Fatal("token 明文被存库")
	}

	// 使用后 last_used 更新
	r2 := e.postJSONBearer("/v1/publisher/releases/whatever/review",
		map[string]any{"decision": "approved"}, plaintext)
	_ = r2.Body.Close
	after, _ := e.repo.Identities().GetTokenByHash(context.Background(), authpkg.HashAPIToken(plaintext))
	if after.LastUsedAt == nil {
		t.Fatal("last_used_at 未更新")
	}

	// 撤销 + 审计
	resp = e.postJSON("/v1/admin/api-tokens/"+tokenID+"/revoke", map[string]any{}, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("撤销失败: %d", resp.StatusCode)
	}
	events, _ := e.repo.Audit().List(context.Background(), 100)
	found := false
	for _, ev := range events {
		if ev.Action == "api-token-revoked" && strings.Contains(ev.Detail, tokenID) {
			found = true
		}
		if strings.Contains(ev.Detail, plaintext) {
			t.Fatal("审计日志泄漏 token 明文")
		}
	}
	if !found {
		t.Fatal("撤销未写审计")
	}
}

func TestConfig_ProductionRejectsStaticAdminToken(t *testing.T) {
	base := func() *config.Config {
		return &config.Config{
			Environment: config.EnvProduction, BillingProvider: "disabled",
			StorageDriver: "filesystem", DownloadTokenSecret: "s",
			DatabaseURL: "postgres://x", BaseURL: "https://example.com",
		}
	}

	// 生产 + 静态 AdminToken → 拒绝启动
	c := base()
	c.AdminToken = "static-token"
	if err := c.Validate(); err == nil {
		t.Fatal("生产环境静态 ADMIN_TOKEN 应被拒绝")
	}

	// 紧急恢复模式：缺有效期 → 拒绝
	c = base()
	c.AdminToken = "t"
	c.EmergencyAdminMode = true
	if err := c.Validate(); err == nil {
		t.Fatal("紧急模式缺 EMERGENCY_ADMIN_UNTIL 应被拒绝")
	}

	// 有效期超 24h → 拒绝
	c.EmergencyAdminUntil = time.Now().Add(48 * time.Hour)
	if err := c.Validate(); err == nil {
		t.Fatal("紧急模式 >24h 应被拒绝")
	}

	// 合法紧急模式 → 通过，且到期自动失效
	c.EmergencyAdminUntil = time.Now().Add(time.Hour)
	if err := c.Validate(); err != nil {
		t.Fatalf("合法紧急模式应通过: %v", err)
	}
	if !c.EmergencyAdminActive(time.Now()) {
		t.Fatal("紧急模式应生效")
	}
	if c.EmergencyAdminActive(time.Now().Add(2 * time.Hour)) {
		t.Fatal("紧急模式到期应失效")
	}
}
