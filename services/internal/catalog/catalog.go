// Package catalog 从已发布制品构建目录快照与本地搜索。
// 条目身份 = publisherKeyId + toolId；商业信息只在 offer。
package catalog

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository"
)

type Service struct {
	Repo     repository.Repository
	SourceID string
	// 快照缓存 TTL；0 时用 DefaultCacheTTL。发布状态变更时显式 Invalidate。
	CacheTTL time.Duration

	mu       sync.Mutex
	cached   *Snapshot
	cachedAt time.Time
}

// DefaultCacheTTL 快照缓存默认有效期。发布侧变更会显式失效，
// TTL 只兑底可用性检查等后台状态的新鲜度。
const DefaultCacheTTL = 30 * time.Second

// Entry 输出结构与 TRP catalog-entry schema 对齐。
type Entry struct {
	Identity struct {
		PublisherKeyID string `json:"publisherKeyId"`
		ToolID         string `json:"toolId"`
	} `json:"identity"`
	Name           string            `json:"name"`
	Summary        string            `json:"summary"`
	License        string            `json:"license,omitempty"`
	Channels       []string          `json:"channels"`
	Latest         map[string]string `json:"latest"`
	Artifacts      []EntryArtifact   `json:"artifacts"`
	Offer          map[string]any    `json:"offer"`
	Review         map[string]bool   `json:"review"`
	IsNativeWorker bool              `json:"isNativeWorker"`
	// 可用性：后台健康检查推导（带时间戳；过期显示 unknown）
	Availability *AvailabilityView `json:"availability,omitempty"`
	// 复现构建：作者声明与官方验证严格分离（UI 不得合并）
	ReproducibleBuild *ReproducibleBuildView `json:"reproducibleBuild,omitempty"`
	// 安全公告（已安装用户可见）
	Advisories []AdvisoryView `json:"advisories,omitempty"`
	UpdatedAt  string         `json:"updatedAt"`
}

// ReproducibleBuildView 复现构建视图：作者声明与官方验证分开展示。
type ReproducibleBuildView struct {
	// 状态机：unknown|claimed|verification-pending|verified|failed
	Status string `json:"status"`
	// 验证策略：dual-build|provenance（verified 时存在）
	Strategy string `json:"strategy,omitempty"`
}

// AvailabilityView catalog 中的可用性视图（UI 显示最后检查时间与状态来源）。
type AvailabilityView struct {
	Status    string `json:"status"` // unknown|healthy|degraded|unavailable
	CheckedAt string `json:"checkedAt,omitempty"`
	// 状态来源：background-check（本源后台任务）
	Source string `json:"source"`
}

type AdvisoryView struct {
	Severity         string   `json:"severity"`
	Summary          string   `json:"summary"`
	AffectedVersions []string `json:"affectedVersions"`
	CreatedAt        string   `json:"createdAt"`
}

type EntryArtifact struct {
	Version        string   `json:"version"`
	Channel        string   `json:"channel"`
	Platform       string   `json:"platform"`
	Arch           string   `json:"arch"`
	ArtifactSHA256 string   `json:"artifactSha256"`
	ManifestDigest string   `json:"manifestDigest"`
	Size           int64    `json:"size"`
	Permissions    []string `json:"permissions"`
	PublishedAt    string   `json:"publishedAt,omitempty"`
	Withdrawn      bool     `json:"withdrawn"`
	// 发布者签名验证（与软件源签名分离）
	PublisherSignatureVerified bool `json:"publisherSignatureVerified"`
	// 签名方式：ed25519 | sigstore（UI 分别展示，不合并）
	SignatureMethod string `json:"signatureMethod,omitempty"`
	// 已验证身份：Ed25519 为 publisherKeyId，Sigstore 为 issuer + subject。
	SignatureIdentity string `json:"signatureIdentity,omitempty"`
}

type Snapshot struct {
	SchemaVersion string  `json:"schemaVersion"`
	SourceID      string  `json:"sourceId"`
	GeneratedAt   string  `json:"generatedAt"`
	Entries       []Entry `json:"entries"`
}

func rfc3339(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

// BuildSnapshot 聚合 published（含 withdrawn 标记）制品为目录快照。
// 无缓存；所有仓库数据一次性加载建索引，避免逐工具 N+1 查询。
func (s *Service) BuildSnapshot(ctx context.Context, now time.Time) (*Snapshot, error) {
	arts, err := s.Repo.Artifacts().ListPublished(ctx)
	if err != nil {
		return nil, err
	}
	withdrawn, err := s.Repo.Artifacts().ListByStatus(ctx, domain.ArtifactWithdrawn)
	if err != nil {
		return nil, err
	}
	arts = append(arts, withdrawn...)

	// 可用性检查结果一次性加载（绝不在 catalog 查询时同步探测）
	availBySHA := map[string]*domain.AvailabilityCheck{}
	if checks, err := s.Repo.Availability().ListAll(ctx); err == nil {
		for _, c := range checks {
			availBySHA[c.ArtifactSHA256] = c
		}
	}

	type key struct{ pub, tool string }

	// 工具登记与公告同样一次性加载，消除每组一次的 N+1 查询
	// （10 万条目规模下 N+1 是性能悬崖）。
	toolByKey := map[key]*domain.Tool{}
	if tools, err := s.Repo.Tools().List(ctx); err == nil {
		for _, t := range tools {
			toolByKey[key{t.PublisherKeyID, t.ToolID}] = t
		}
	} else {
		return nil, err
	}
	advByKey := map[key][]*domain.SecurityAdvisory{}
	if advs, err := s.Repo.Advisories().ListAll(ctx); err == nil {
		for _, ad := range advs {
			k := key{ad.PublisherKeyID, ad.ToolID}
			advByKey[k] = append(advByKey[k], ad)
		}
	}

	groups := map[key][]*domain.Artifact{}
	for _, a := range arts {
		k := key{a.PublisherKeyID, a.ToolID}
		groups[k] = append(groups[k], a)
	}

	entries := []Entry{}
	for k, rows := range groups {
		tool, ok := toolByKey[k]
		if !ok {
			continue // 无工具登记的制品不进目录
		}
		var e Entry
		e.Identity.PublisherKeyID = k.pub
		e.Identity.ToolID = k.tool
		e.Name = tool.Name
		e.Summary = tool.Summary
		e.License = tool.License
		e.IsNativeWorker = tool.IsNativeWorker
		e.UpdatedAt = rfc3339(now)
		e.Offer = map[string]any{
			"accessMode":  tool.AccessMode,
			"productId":   nil,
			"planIds":     []string{},
			"purchaseUrl": nil,
		}
		if tool.ProductID != "" {
			e.Offer["productId"] = tool.ProductID
		}
		// 各独立状态：来自真实制品字段，不合并成单一 safe 布尔。
		// 聚合规则：仅看未撤回的已发布制品，全部通过才置 true。
		pubSigAll, scanAll, reviewAll := true, true, true
		reproAllVerified := true
		var reproClaimed bool
		var reproStrategy string
		publishedCount := 0
		chSet := map[string]bool{}
		latest := map[string]string{}
		statusCount := map[domain.AvailabilityStatus]int{}
		var lastChecked time.Time
		for _, a := range rows {
			chSet[a.Channel] = true
			if a.Status == domain.ArtifactPublished {
				publishedCount++
				pubSigAll = pubSigAll && a.PublisherSignatureVerified
				scanAll = scanAll && a.SecurityScanPassed
				reviewAll = reviewAll && a.OfficialReviewPassed
				// 复现构建：只有真实 verified 才算通过；作者声明单独记录
				// （字面量 "verified" 对应 publishers.ReproVerified；避免 import 循环）
				reproAllVerified = reproAllVerified && a.ReproStatus == "verified"
				if a.ReproducibleClaimed {
					reproClaimed = true
				}
				if a.ReproStrategy != "" {
					reproStrategy = a.ReproStrategy
				}
				if cur, ok := latest[a.Channel]; !ok || semverLess(cur, a.Version) {
					latest[a.Channel] = a.Version
				}
				check := availBySHA[a.SHA256]
				statusCount[check.Effective(now)]++
				if check != nil && check.CheckedAt.After(lastChecked) {
					lastChecked = check.CheckedAt
				}
			}
			pa := ""
			if a.PublishedAt != nil {
				pa = rfc3339(*a.PublishedAt)
			}
			e.Artifacts = append(e.Artifacts, EntryArtifact{
				Version: a.Version, Channel: a.Channel,
				Platform: a.Platform, Arch: a.Arch,
				ArtifactSHA256: a.SHA256, ManifestDigest: a.ManifestDigest,
				Size: a.Size, Permissions: a.Permissions,
				PublishedAt:                pa,
				Withdrawn:                  a.Status == domain.ArtifactWithdrawn,
				PublisherSignatureVerified: a.PublisherSignatureVerified,
				SignatureMethod:            a.SignatureMethod,
				SignatureIdentity:          a.SignatureIdentity,
			})
		}
		// 可用性聚合：全部 healthy → healthy；全部 unavailable → unavailable；
		// 任一 unknown（含过期）→ unknown；其余混合 → degraded。
		entryStatus := aggregateStatus(statusCount, publishedCount)
		if publishedCount > 0 {
			av := &AvailabilityView{Status: string(entryStatus), Source: "background-check"}
			if !lastChecked.IsZero() {
				av.CheckedAt = rfc3339(lastChecked)
			}
			e.Availability = av
		}
		e.Review = map[string]bool{
			"repositorySignatureVerified": true, // 快照由本源 TUF 链签发
			"publisherSignatureVerified":  publishedCount > 0 && pubSigAll,
			"officialReviewPassed":        publishedCount > 0 && reviewAll,
			"securityScanPassed":          publishedCount > 0 && scanAll,
			// 只在有时间戳的真实检查全部 healthy 时才为 true
			"sourceAvailable": entryStatus == domain.AvailabilityHealthy,
			// 只有全部已发布制品的复现构建均官方 verified 时才为 true
			"reproducibleBuildVerified": publishedCount > 0 && reproAllVerified,
		}
		// 复现构建视图：作者声明与官方验证分开展示（绝不合并）
		if publishedCount > 0 {
			var rstatus string
			switch {
			case reproAllVerified:
				rstatus = "verified"
			case reproClaimed:
				rstatus = "claimed"
			default:
				rstatus = "unknown"
			}
			view := &ReproducibleBuildView{Status: rstatus}
			if rstatus == "verified" {
				view.Strategy = reproStrategy
			}
			e.ReproducibleBuild = view
		}
		// 安全公告：已安装用户可见（即使版本已全部撤回也携带）
		for _, ad := range advByKey[k] {
			e.Advisories = append(e.Advisories, AdvisoryView{
				Severity:         string(ad.Severity),
				Summary:          ad.Summary,
				AffectedVersions: ad.AffectedVersions,
				CreatedAt:        rfc3339(ad.CreatedAt),
			})
		}
		if len(latest) == 0 && len(e.Advisories) == 0 {
			continue // 全部撤回且无公告：不进目录
		}
		// 全部撤回但有公告：保留条目（latest 为空），已安装用户可见通知
		for ch := range chSet {
			e.Channels = append(e.Channels, ch)
		}
		sort.Strings(e.Channels)
		sort.Slice(e.Artifacts, func(i, j int) bool {
			return e.Artifacts[i].Version < e.Artifacts[j].Version
		})
		e.Latest = latest
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Identity.ToolID != entries[j].Identity.ToolID {
			return entries[i].Identity.ToolID < entries[j].Identity.ToolID
		}
		return entries[i].Identity.PublisherKeyID < entries[j].Identity.PublisherKeyID
	})
	return &Snapshot{
		SchemaVersion: "1.0",
		SourceID:      s.SourceID,
		GeneratedAt:   rfc3339(now),
		Entries:       entries,
	}, nil
}

// CachedSnapshot 返回带 TTL 的缓存快照；过期或被 Invalidate 后重建。
// 重建在锁内串行（单飞），高并发下不会对同一份快照重复全量聚合。
func (s *Service) CachedSnapshot(ctx context.Context, now time.Time) (*Snapshot, error) {
	ttl := s.CacheTTL
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached != nil && now.Sub(s.cachedAt) < ttl {
		return s.cached, nil
	}
	snap, err := s.BuildSnapshot(ctx, now)
	if err != nil {
		return nil, err
	}
	s.cached = snap
	s.cachedAt = now
	return snap, nil
}

// Invalidate 丢弃缓存快照。发布/撤回/公告/审核等状态变更后调用。
func (s *Service) Invalidate() {
	s.mu.Lock()
	s.cached = nil
	s.mu.Unlock()
}

// Search 目录内关键字搜索（名称/toolId/摘要），带分页上限。
// 走缓存快照：搜索是客户端高频路径，绝不每次请求全量重建。
func (s *Service) Search(ctx context.Context, q string, limit int, now time.Time) ([]Entry, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	snap, err := s.CachedSnapshot(ctx, now)
	if err != nil {
		return nil, err
	}
	kw := strings.ToLower(strings.TrimSpace(q))
	out := []Entry{}
	for _, e := range snap.Entries {
		if kw == "" ||
			strings.Contains(strings.ToLower(e.Name), kw) ||
			strings.Contains(strings.ToLower(e.Identity.ToolID), kw) ||
			strings.Contains(strings.ToLower(e.Summary), kw) {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

// aggregateStatus 条目级可用性聚合规则。
func aggregateStatus(counts map[domain.AvailabilityStatus]int, published int) domain.AvailabilityStatus {
	if published == 0 {
		return domain.AvailabilityUnknown
	}
	switch {
	case counts[domain.AvailabilityUnknown] > 0:
		return domain.AvailabilityUnknown
	case counts[domain.AvailabilityHealthy] == published:
		return domain.AvailabilityHealthy
	case counts[domain.AvailabilityUnavailable] == published:
		return domain.AvailabilityUnavailable
	default:
		return domain.AvailabilityDegraded
	}
}

// semverLess 简化 semver 比较（主.次.补丁数值序）。
func semverLess(a, b string) bool {
	pa := strings.SplitN(strings.SplitN(a, "-", 2)[0], ".", 3)
	pb := strings.SplitN(strings.SplitN(b, "-", 2)[0], ".", 3)
	for i := 0; i < 3 && i < len(pa) && i < len(pb); i++ {
		var na, nb int
		for _, c := range pa[i] {
			if c >= '0' && c <= '9' {
				na = na*10 + int(c-'0')
			}
		}
		for _, c := range pb[i] {
			if c >= '0' && c <= '9' {
				nb = nb*10 + int(c-'0')
			}
		}
		if na != nb {
			return na < nb
		}
	}
	return false
}
