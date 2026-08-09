// 来源与制品可用性状态（Phase RC：真实 sourceAvailable）。
// 状态由后台健康检查任务写入并带过期时间；catalog 只从有时间戳的
// 真实检查结果推导，过期结果显示 unknown 而不是沿用旧的 healthy。
package domain

import "time"

type AvailabilityStatus string

const (
	AvailabilityUnknown     AvailabilityStatus = "unknown"
	AvailabilityHealthy     AvailabilityStatus = "healthy"
	AvailabilityDegraded    AvailabilityStatus = "degraded"
	AvailabilityUnavailable AvailabilityStatus = "unavailable"
)

// 错误类别（HTTP 状态或存储错误归类，不含敏感细节）。
const (
	AvailErrNone         = ""
	AvailErrNotFound     = "not-found"
	AvailErrTimeout      = "timeout"
	AvailErrStorageError = "storage-error"
	AvailErrSizeMismatch = "size-mismatch"
)

// AvailabilityCheck 单个制品对象的最近健康检查记录。
type AvailabilityCheck struct {
	SourceID       string `json:"sourceId"`
	ArtifactSHA256 string `json:"artifactSha256"`
	// 检查目标（存储键；绝不是用户输入的任意 URL —— 防 SSRF）
	Target              string             `json:"target"`
	Status              AvailabilityStatus `json:"status"`
	LastSuccessAt       *time.Time         `json:"lastSuccessAt,omitempty"`
	LastFailureAt       *time.Time         `json:"lastFailureAt,omitempty"`
	ConsecutiveFailures int                `json:"consecutiveFailures"`
	ErrorCategory       string             `json:"errorCategory,omitempty"`
	CheckedAt           time.Time          `json:"checkedAt"`
	// 结果过期时间：过期后 Effective 返回 unknown
	ExpiresAt time.Time `json:"expiresAt"`
}

// Effective 返回考虑过期后的状态：过期结果不沿用，显示 unknown。
func (c *AvailabilityCheck) Effective(now time.Time) AvailabilityStatus {
	if c == nil || !now.Before(c.ExpiresAt) {
		return AvailabilityUnknown
	}
	return c.Status
}
