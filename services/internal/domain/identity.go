// 管理与发布者身份模型（Phase RC：取代生产环境 X-Admin-Token）。
// API Token 明文只在创建时返回一次；数据库只存 SHA-256 哈希。
package domain

import "time"

// Role 实例内角色。publisher-* 角色作用域由 Identity.PublisherKeyID 限定。
type Role string

const (
	RoleInstanceAdmin       Role = "instance-admin"
	RoleSourceAdmin         Role = "source-admin"
	RolePublisherOwner      Role = "publisher-owner"
	RolePublisherMaintainer Role = "publisher-maintainer"
	RolePublisherViewer     Role = "publisher-viewer"
	RoleReviewer            Role = "reviewer"
	RoleSecurityReviewer    Role = "security-reviewer"
)

// 操作 scope（API Token 与角色推导共用同一命名空间）。
const (
	ScopePublisherWrite    = "publisher:write"    // 上传会话/发布 release
	ScopePublisherWithdraw = "publisher:withdraw" // 撤回已发布版本
	ScopePublisherAdvisory = "publisher:advisory" // 安全公告
	ScopePublisherKeys     = "publisher:keys"     // 发布者密钥轮换
	ScopeReviewWrite       = "review:write"       // 审核通过/驳回
	ScopeAdminIdentities   = "admin:identities"   // 身份管理
	ScopeAdminTokens       = "admin:tokens"       // API Token 管理
)

// AllScopes 全量 scope（instance-admin / 紧急恢复模式使用）。
func AllScopes() []string {
	return []string{
		ScopePublisherWrite, ScopePublisherWithdraw, ScopePublisherAdvisory,
		ScopePublisherKeys, ScopeReviewWrite, ScopeAdminIdentities, ScopeAdminTokens,
	}
}

var roleScopes = map[Role][]string{
	RoleInstanceAdmin: AllScopes(),
	RoleSourceAdmin: {
		ScopePublisherWrite, ScopePublisherWithdraw, ScopePublisherAdvisory,
		ScopePublisherKeys, ScopeReviewWrite, ScopeAdminTokens,
	},
	RolePublisherOwner: {
		ScopePublisherWrite, ScopePublisherWithdraw, ScopePublisherAdvisory, ScopePublisherKeys,
	},
	RolePublisherMaintainer: {ScopePublisherWrite},
	RolePublisherViewer:     {},
	RoleReviewer:            {ScopeReviewWrite},
	RoleSecurityReviewer:    {ScopePublisherAdvisory, ScopeReviewWrite},
}

// IsValidRole 校验角色名。
func IsValidRole(r Role) bool { _, ok := roleScopes[r]; return ok }

// RolesValid rejects corrupt/unknown persisted roles instead of silently
// authenticating an identity with a partially interpreted role set.
func RolesValid(roles []Role) bool {
	for _, role := range roles {
		if !IsValidRole(role) {
			return false
		}
	}
	return true
}

// HasRole reports whether roles contains want.
func HasRole(roles []Role, want Role) bool {
	for _, role := range roles {
		if role == want {
			return true
		}
	}
	return false
}

// HasPublisherRole reports whether an identity carries a role whose authority
// must be constrained to Identity.PublisherKeyID. Global administrative and
// security-review roles are intentionally not publisher-bound.
func HasPublisherRole(roles []Role) bool {
	return HasRole(roles, RolePublisherOwner) ||
		HasRole(roles, RolePublisherMaintainer) ||
		HasRole(roles, RolePublisherViewer)
}

// ScopesForRoles 角色集合 → 去重后的 scope 集合。
func ScopesForRoles(roles []Role) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, r := range roles {
		for _, s := range roleScopes[r] {
			if !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	return out
}

// Identity 用户或服务账户。
type Identity struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	// user | service-account
	Kind  string `json:"kind"`
	Roles []Role `json:"roles"`
	// publisher-* 角色的作用域（为空表示不绑定发布者）
	PublisherKeyID string    `json:"publisherKeyId,omitempty"`
	Disabled       bool      `json:"disabled"`
	CreatedAt      time.Time `json:"createdAt"`
}

// APIToken 长效凭据登记。明文绝不落库、绝不写日志。
type APIToken struct {
	ID         string `json:"id"`
	IdentityID string `json:"identityId"`
	// SHA-256(明文) 的 hex；比较用常量时间
	TokenHash  string     `json:"-"`
	Scopes     []string   `json:"scopes"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	Revoked    bool       `json:"revoked"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
}

// Usable 判定 token 当前是否可用。
func (t *APIToken) Usable(now time.Time) bool {
	return !t.Revoked && now.Before(t.ExpiresAt)
}

// HasScope 判定 scope 集合是否包含所需 scope。
func HasScope(scopes []string, want string) bool {
	for _, s := range scopes {
		if s == want {
			return true
		}
	}
	return false
}
