// Package repository 定义持久层接口。source-server 与 source-worker 共享。
// 实现：memory（开发/单测）、postgres（生产，migrations/ 下 SQL 迁移）。
package repository

import (
	"context"
	"time"

	"useful.dev/source/internal/domain"
)

// Repository 聚合仓库接口（模块化单体：单库多表）。
type Repository interface {
	Publishers() PublisherRepo
	Tools() ToolRepo
	Artifacts() ArtifactRepo
	Uploads() UploadRepo
	Entitlements() EntitlementRepo
	Grants() GrantRepo
	Billing() BillingRepo
	Audit() AuditRepo
	Jobs() JobRepo
	Advisories() AdvisoryRepo
	Identities() IdentityRepo
	Availability() AvailabilityRepo
	Metadata() MetadataRepo
	// Ping 健康检查（readiness）。
	Ping(ctx context.Context) error
}

// AvailabilityRepo 制品可用性检查结果（后台任务写入，catalog 推导）。
type AvailabilityRepo interface {
	// Upsert 以 artifact sha256 为键覆盖最新检查结果。
	Upsert(ctx context.Context, c *domain.AvailabilityCheck) error
	Get(ctx context.Context, artifactSHA256 string) (*domain.AvailabilityCheck, error)
	ListAll(ctx context.Context) ([]*domain.AvailabilityCheck, error)
}

// IdentityRepo 管理/发布者身份与 API Token（只存哈希，不存明文）。
type IdentityRepo interface {
	CreateIdentity(ctx context.Context, id *domain.Identity) error
	GetIdentity(ctx context.Context, id string) (*domain.Identity, error)
	ListIdentities(ctx context.Context) ([]*domain.Identity, error)
	CreateToken(ctx context.Context, t *domain.APIToken) error
	// GetTokenByHash 按 sha256 hex 查 token（认证热路径）。
	GetTokenByHash(ctx context.Context, hash string) (*domain.APIToken, error)
	ListTokensByIdentity(ctx context.Context, identityID string) ([]*domain.APIToken, error)
	RevokeToken(ctx context.Context, tokenID string) error
	// TouchToken 记录最后使用时间（失败不阻断请求）。
	TouchToken(ctx context.Context, tokenID string, at time.Time) error
}

type PublisherRepo interface {
	Create(ctx context.Context, p *domain.Publisher) error
	GetByKeyID(ctx context.Context, keyID string) (*domain.Publisher, error)
	List(ctx context.Context) ([]*domain.Publisher, error)
	// AddKey 登记发布者公钥（含轮换连续性）；key_id 唯一。
	AddKey(ctx context.Context, k *domain.PublisherKey) error
	// GetKey 按 key_id 取公钥登记（含 rotated_from）。
	GetKey(ctx context.Context, keyID string) (*domain.PublisherKey, error)
}

type AdvisoryRepo interface {
	Create(ctx context.Context, a *domain.SecurityAdvisory) error
	ListByTool(ctx context.Context, publisherKeyID, toolID string) ([]*domain.SecurityAdvisory, error)
	ListAll(ctx context.Context) ([]*domain.SecurityAdvisory, error)
}

type ToolRepo interface {
	// Upsert 以 (publisherKeyId, toolId) 为键。同名不同发布者是不同工具。
	Upsert(ctx context.Context, t *domain.Tool) error
	Get(ctx context.Context, publisherKeyID, toolID string) (*domain.Tool, error)
	List(ctx context.Context) ([]*domain.Tool, error)
}

type ArtifactRepo interface {
	Create(ctx context.Context, a *domain.Artifact) error
	Get(ctx context.Context, id string) (*domain.Artifact, error)
	// GetByIdentity 按 tool identity + version + platform + arch（数据库唯一约束）。
	GetByIdentity(ctx context.Context, publisherKeyID, toolID, version, platform, arch string) (*domain.Artifact, error)
	GetBySHA256(ctx context.Context, sha256 string) (*domain.Artifact, error)
	// UpdateStatus 状态机推进；已发布记录禁止删除，撤回用 withdrawn 状态。
	UpdateStatus(ctx context.Context, id string, status domain.ArtifactStatus, publishedAt *time.Time) error
	// Update 全记录更新（持久化扫描/审核/签名等独立状态字段）。
	Update(ctx context.Context, a *domain.Artifact) error
	ListByStatus(ctx context.Context, status domain.ArtifactStatus) ([]*domain.Artifact, error)
	ListPublished(ctx context.Context) ([]*domain.Artifact, error)
}

type UploadRepo interface {
	Create(ctx context.Context, s *domain.UploadSession) error
	Get(ctx context.Context, id string) (*domain.UploadSession, error)
	Update(ctx context.Context, s *domain.UploadSession) error
	// ClaimCompleted atomically advances completed -> release-claimed and returns
	// the claimed session. Any repeat/concurrent claim returns ErrConflict.
	ClaimCompleted(ctx context.Context, id string) (*domain.UploadSession, error)
	// GetByArtifact 反查产生某 artifact 的上传会话（发布时定位 staging 对象）。
	GetByArtifact(ctx context.Context, artifactID string) (*domain.UploadSession, error)
}

// MetadataRepo owns the monotonic TUF metadata version across processes.
type MetadataRepo interface {
	// AcquirePublishLease serializes the complete metadata publication across
	// instances. The lease must cover snapshot reads, version allocation, all
	// immutable writes, and the final timestamp switch.
	AcquirePublishLease(ctx context.Context) (MetadataPublishLease, error)
}

type MetadataPublishLease interface {
	// NextVersion atomically returns max(candidateUnix, lastVersion+1) while the
	// publish lease is held.
	NextVersion(ctx context.Context, candidateUnix int64) (int64, error)
	Release() error
}

type EntitlementRepo interface {
	Upsert(ctx context.Context, e *domain.Entitlement) error
	ListBySubject(ctx context.Context, subjectID string) ([]*domain.Entitlement, error)
}

type GrantRepo interface {
	Create(ctx context.Context, g *domain.DownloadGrant) error
	Get(ctx context.Context, id string) (*domain.DownloadGrant, error)
}

type BillingRepo interface {
	// InsertEvent 幂等入口：event_id 唯一，重复返回 domain.ErrConflict。
	InsertEvent(ctx context.Context, e *domain.BillingEvent) error
	MarkEventProcessed(ctx context.Context, eventID string) error
	GetEvent(ctx context.Context, eventID string) (*domain.BillingEvent, error)
	// UpsertSubscription 乱序防护：仅当 objectTime 更新时才覆盖。
	UpsertSubscription(ctx context.Context, s *domain.Subscription) error
	GetSubscription(ctx context.Context, id string) (*domain.Subscription, error)
}

type AuditRepo interface {
	// Append 只追加；接口层不提供更新/删除。
	Append(ctx context.Context, e *domain.AuditEvent) error
	List(ctx context.Context, limit int) ([]*domain.AuditEvent, error)
}

type JobRepo interface {
	Enqueue(ctx context.Context, j *domain.Job) error
	// ClaimNext 取一个 queued 任务置为 running（worker 轮询）。无任务返回 ErrNotFound。
	ClaimNext(ctx context.Context, kinds []string) (*domain.Job, error)
	Complete(ctx context.Context, id string, jobErr string) error
	Depth(ctx context.Context) (int, error)
}
