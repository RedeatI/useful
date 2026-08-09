// Package domain 定义源后端的核心领域类型。
// 关键身份规则：ToolIdentity = PublisherKeyID + ToolID（禁止仅用 ToolID）；
// 版本唯一约束 = tool identity + version + platform + arch；
// 已发布制品记录禁止删除，只能置 withdrawn。
package domain

import (
	"errors"
	"regexp"
	"time"
)

// ---------- 通用 ----------

var (
	ErrNotFound     = errors.New("not found")
	ErrConflict     = errors.New("conflict")
	ErrInvalidInput = errors.New("invalid input")
	ErrForbidden    = errors.New("forbidden")
)

var (
	lowercaseIDRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$`)
	sha256Re      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	semverRe      = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
	ed25519KeyRe  = regexp.MustCompile(`^ed25519:[a-f0-9]{64}$`)
	sigstoreKeyRe = regexp.MustCompile(`^sigstore:[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`)
)

func IsLowercaseID(s string) bool          { return len(s) <= 200 && lowercaseIDRe.MatchString(s) }
func IsSHA256(s string) bool               { return sha256Re.MatchString(s) }
func IsSemver(s string) bool               { return len(s) <= 256 && semverRe.MatchString(s) }
func IsEd25519PublisherKey(s string) bool  { return ed25519KeyRe.MatchString(s) }
func IsSigstorePublisherKey(s string) bool { return sigstoreKeyRe.MatchString(s) }
func IsPublisherKey(s string) bool {
	return IsEd25519PublisherKey(s) || IsSigstorePublisherKey(s)
}

// ---------- 发布者与工具 ----------

type Publisher struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	// 公钥标识（ed25519:<hex> 或 sigstore:<label>）。数据库只存公钥，绝不存私钥。
	KeyID     string    `json:"keyId"`
	CreatedAt time.Time `json:"createdAt"`
	// Sigstore 身份策略（sigstore 发布者注册时提供；传递到初始密钥）。
	IdentityIssuer     string `json:"identityIssuer,omitempty"`
	IdentitySANExact   string `json:"identitySanExact,omitempty"`
	IdentitySANPattern string `json:"identitySanPattern,omitempty"`
}

type Tool struct {
	// ToolIdentity = PublisherKeyID + ToolID
	PublisherKeyID string `json:"publisherKeyId"`
	ToolID         string `json:"toolId"`
	Name           string `json:"name"`
	Summary        string `json:"summary"`
	License        string `json:"license"`
	// CatalogOffer（可变商业信息，绝不进入不可变 manifest）
	AccessMode     string    `json:"accessMode"` // free|entitlement|external-purchase|private|unavailable
	ProductID      string    `json:"productId,omitempty"`
	IsNativeWorker bool      `json:"isNativeWorker"`
	CreatedAt      time.Time `json:"createdAt"`
}

type ArtifactStatus string

const (
	ArtifactStaged   ArtifactStatus = "staged"   // 上传完成，隔离区
	ArtifactScanned  ArtifactStatus = "scanned"  // 扫描通过
	ArtifactApproved ArtifactStatus = "approved" // 审核通过，待发布
	// Pending states are durable publication intents. They are excluded from
	// catalog/downloads while TUF reconciliation is incomplete.
	ArtifactPublishPending  ArtifactStatus = "publish-pending"
	ArtifactWithdrawPending ArtifactStatus = "withdraw-pending"
	ArtifactPublished       ArtifactStatus = "published" // 已发布（不可变）
	ArtifactRejected        ArtifactStatus = "rejected"
	ArtifactWithdrawn       ArtifactStatus = "withdrawn" // 撤回（记录保留）
)

// CanTransitionArtifactStatus is the fail-closed persisted state machine used
// by both repository implementations. Same-state updates may persist scan or
// reproducibility fields without allowing a stale writer to roll state back.
func CanTransitionArtifactStatus(from, to ArtifactStatus) bool {
	if from == to {
		return true
	}
	switch from {
	case ArtifactStaged:
		return to == ArtifactScanned || to == ArtifactRejected
	case ArtifactScanned:
		return to == ArtifactPublishPending || to == ArtifactRejected
	case ArtifactPublishPending:
		return to == ArtifactPublished
	case ArtifactPublished:
		return to == ArtifactWithdrawPending
	case ArtifactWithdrawPending:
		return to == ArtifactWithdrawn
	default:
		return false
	}
}

type Artifact struct {
	ID             string         `json:"id"`
	PublisherKeyID string         `json:"publisherKeyId"`
	ToolID         string         `json:"toolId"`
	Version        string         `json:"version"`
	Channel        string         `json:"channel"` // stable|beta|nightly
	Platform       string         `json:"platform"`
	Arch           string         `json:"arch"`
	SHA256         string         `json:"sha256"`
	ManifestDigest string         `json:"manifestDigest"`
	Size           int64          `json:"size"`
	FileName       string         `json:"fileName"`
	Permissions    []string       `json:"permissions"`
	Status         ArtifactStatus `json:"status"`
	CreatedAt      time.Time      `json:"createdAt"`
	PublishedAt    *time.Time     `json:"publishedAt,omitempty"`

	// —— 独立状态字段（Phase 9）：绝不合并成单一 safe 布尔 ——
	// 发布者签名验证通过（与软件源 TUF 验证分离）
	PublisherSignatureVerified bool `json:"publisherSignatureVerified"`
	// 签名方式：ed25519 | sigstore（空表示未签名）
	SignatureMethod string `json:"signatureMethod,omitempty"`
	// 已通过验证的规范化 Ed25519 签名（小写 hex）。Sigstore 不在此字段
	// 携带 bundle，避免把仅服务端验证误表述为客户端可独立验证的 proof。
	PublisherSignature string `json:"publisherSignature,omitempty"`
	// 已验证身份：Ed25519 时等于 publisherKeyId；Sigstore 时为 issuer + subject。
	SignatureIdentity string `json:"signatureIdentity,omitempty"`
	// 安全扫描通过（worker 静态检查）
	SecurityScanPassed bool `json:"securityScanPassed"`
	// 官方/人工审核通过（原生 worker 发布前置条件）
	OfficialReviewPassed bool `json:"officialReviewPassed"`
	// 是否为原生 worker 工具（扫描从包内 manifest 判定）
	IsNativeWorker bool `json:"isNativeWorker"`
	// SBOM 摘要（包内 sbom/ 存在时）
	SBOMDigest string `json:"sbomDigest,omitempty"`
	// 扫描结果 JSON（各独立检查项）
	ScanResultJSON string `json:"scanResultJson,omitempty"`
	// 复现构建：作者声明与官方验证严格分离，绝不合并。
	// ReproducibleClaimed = manifest 自称（不构成验证）；
	// ReproStatus = 状态机（unknown|claimed|verification-pending|verified|failed）。
	ReproducibleClaimed bool   `json:"reproducibleClaimed"`
	ReproStatus         string `json:"reproStatus,omitempty"`
	ReproStrategy       string `json:"reproStrategy,omitempty"`
}

// ScanResult 扫描 worker 产出的各独立检查项（不合并成单一布尔）。
type ScanResult struct {
	// ZIP/路径/大小等结构安全检查通过
	StructureSafe bool `json:"structureSafe"`
	// manifest 可解析且字段合法
	ManifestValid bool `json:"manifestValid"`
	// 声明的权限均在已知白名单
	PermissionsReviewed bool `json:"permissionsReviewed"`
	// 是否含可执行原生载荷（worker）
	IsNativeWorker bool `json:"isNativeWorker"`
	// 可执行文件哈希清单（原生 worker 审核依据）
	ExecutableHashes []string `json:"executableHashes,omitempty"`
	// SBOM 是否存在
	HasSBOM bool `json:"hasSbom"`
	// 发现的问题（非致命）
	Findings []string `json:"findings,omitempty"`
	// 整体是否通过（结构安全+manifest+权限）
	Passed bool `json:"passed"`
}

// SecurityAdvisory 安全公告：已安装用户可见（catalog 携带）。
type AdvisorySeverity string

const (
	SeverityLow      AdvisorySeverity = "low"
	SeverityMedium   AdvisorySeverity = "medium"
	SeverityHigh     AdvisorySeverity = "high"
	SeverityCritical AdvisorySeverity = "critical"
)

type SecurityAdvisory struct {
	ID               string           `json:"id"`
	PublisherKeyID   string           `json:"publisherKeyId"`
	ToolID           string           `json:"toolId"`
	Severity         AdvisorySeverity `json:"severity"`
	Summary          string           `json:"summary"`
	AffectedVersions []string         `json:"affectedVersions"`
	CreatedAt        time.Time        `json:"createdAt"`
}

// PublisherKey 发布者公钥登记（只存公钥），含轮换连续性元信息。
type PublisherKey struct {
	KeyID       string `json:"keyId"` // ed25519:<hex>
	PublisherID string `json:"publisherId"`
	PublicKey   string `json:"publicKey"`
	// 前一个密钥（交叉签名证明连续性；无则为新发布者）
	RotatedFrom string    `json:"rotatedFrom,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	// Sigstore 身份策略（keyId 形如 sigstore:<label> 时使用）。
	// issuer 精确匹配；SAN 精确优先，否则受控模式（仅单个 '*'）。
	IdentityIssuer     string `json:"identityIssuer,omitempty"`
	IdentitySANExact   string `json:"identitySanExact,omitempty"`
	IdentitySANPattern string `json:"identitySanPattern,omitempty"`
}

// ---------- 上传会话 ----------

type UploadSessionStatus string

const (
	UploadOpen      UploadSessionStatus = "open"
	UploadCompleted UploadSessionStatus = "completed"
	// UploadReleaseClaimed is a one-way, repository-atomic claim. A session may
	// feed at most one CreateRelease attempt, including under concurrent calls.
	UploadReleaseClaimed UploadSessionStatus = "release-claimed"
	UploadFailed         UploadSessionStatus = "failed"
)

type UploadSession struct {
	ID             string              `json:"id"`
	PublisherKeyID string              `json:"publisherKeyId"`
	StagingKey     string              `json:"stagingKey"`
	DeclaredSHA256 string              `json:"declaredSha256"`
	DeclaredSize   int64               `json:"declaredSize"`
	Status         UploadSessionStatus `json:"status"`
	Error          string              `json:"error,omitempty"`
	ArtifactID     string              `json:"artifactId,omitempty"`
	CreatedAt      time.Time           `json:"createdAt"`
}

// ---------- 权益与下载授权 ----------

type EntitlementStatus string

const (
	EntitlementActive   EntitlementStatus = "active"
	EntitlementTrialing EntitlementStatus = "trialing"
	EntitlementGrace    EntitlementStatus = "grace"
	EntitlementPastDue  EntitlementStatus = "past_due"
	EntitlementCanceled EntitlementStatus = "canceled"
	EntitlementExpired  EntitlementStatus = "expired"
	EntitlementRevoked  EntitlementStatus = "revoked"
)

type Entitlement struct {
	ID         string            `json:"entitlementId"`
	SubjectID  string            `json:"subjectId"`
	ProductID  string            `json:"productId"`
	PlanID     string            `json:"planId"`
	ToolScope  string            `json:"toolScope"` // toolId 或 "*"
	Status     EntitlementStatus `json:"status"`
	StartsAt   time.Time         `json:"startsAt"`
	ExpiresAt  *time.Time        `json:"expiresAt,omitempty"`
	GraceUntil *time.Time        `json:"graceUntil,omitempty"`
	UpdatedAt  time.Time         `json:"updatedAt"`
}

// AllowsNewDownload 判定该权益状态是否允许发起新的付费下载。
// canceled/expired 不删除本地工具、也不阻止已装版本运行——只拒绝新的付费下载。
func (e *Entitlement) AllowsNewDownload(now time.Time) bool {
	switch e.Status {
	case EntitlementActive, EntitlementTrialing:
		return e.ExpiresAt == nil || now.Before(*e.ExpiresAt)
	case EntitlementGrace, EntitlementPastDue:
		return e.GraceUntil != nil && now.Before(*e.GraceUntil)
	default: // canceled / expired / revoked
		return false
	}
}

type DownloadGrant struct {
	ID             string `json:"grantId"`
	SubjectID      string `json:"subjectId,omitempty"`
	ArtifactID     string `json:"artifactId"`
	ArtifactSHA256 string `json:"artifactSha256"`
	Size           int64  `json:"size"`
	// 临时 URL；不作为 artifact 身份，审计日志不记录完整值
	DownloadURL   string    `json:"downloadUrl"`
	ExpiresAt     time.Time `json:"expiresAt"`
	SupportsRange bool      `json:"supportsRange"`
	CreatedAt     time.Time `json:"createdAt"`
}

func (g *DownloadGrant) Expired(now time.Time) bool { return !now.Before(g.ExpiresAt) }

// ---------- 计费 ----------

type BillingEvent struct {
	// provider 事件 ID：数据库唯一约束，保证 webhook 幂等
	EventID  string `json:"eventId"`
	Provider string `json:"provider"`
	Kind     string `json:"kind"`
	// provider 对象版本/时间，用于乱序处理
	ObjectTime time.Time `json:"objectTime"`
	Processed  bool      `json:"processed"`
	ReceivedAt time.Time `json:"receivedAt"`
}

type Subscription struct {
	ID         string `json:"id"`
	CustomerID string `json:"customerId"`
	ProductID  string `json:"productId"`
	PlanID     string `json:"planId"`
	Status     string `json:"status"` // provider 归一化后的状态
	// provider 侧对象更新时间：晚到的旧事件不得覆盖新状态
	ObjectTime time.Time `json:"objectTime"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// ---------- 审计 ----------

type AuditEvent struct {
	Seq    int64     `json:"seq"`
	At     time.Time `json:"at"`
	Actor  string    `json:"actor"`
	Action string    `json:"action"`
	// 摘要字段，不包含 token / 完整临时 URL / 用户文件路径
	Detail string `json:"detail"`
}

// ---------- 任务队列 ----------

type JobStatus string

const (
	JobQueued  JobStatus = "queued"
	JobRunning JobStatus = "running"
	JobDone    JobStatus = "done"
	JobFailed  JobStatus = "failed"
)

type Job struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"` // scan-artifact | publish-metadata
	Payload   string    `json:"payload"`
	Status    JobStatus `json:"status"`
	Attempts  int       `json:"attempts"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
