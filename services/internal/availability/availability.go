// Package availability 后台制品可用性检查。
// 设计约束（ADR-012）：
//   - 绝不在 catalog 查询时同步探测；只读最近检查记录；
//   - 检查目标只有本源自己的存储键（动态源=数据库记录 vs 对象存储一致性），
//     绝不探测用户输入的任意 URL —— 从结构上杜绝 SSRF；
//   - 用 Head（元信息）而不是下载完整对象；
//   - 每轮扫描有数量上限 + 新鲜结果跳过 —— 大量制品不会造成请求风暴；
//   - 瞬时错误（超时/存储故障）先 degraded，连续失败达到阈值才 unavailable；
//     对象缺失/大小不符是硬错误，直接 unavailable；
//   - 检查结果带过期时间：catalog 读到过期记录显示 unknown。
package availability

import (
	"context"
	"errors"
	"os"
	"sort"
	"strings"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository"
	"useful.dev/source/internal/storage"
)

type Checker struct {
	Repo     repository.Repository
	Store    storage.Storage
	SourceID string
	// 单个对象检查超时
	Timeout time.Duration
	// 结果有效期（过期显示 unknown）
	TTL time.Duration
	// 新鲜结果跳过窗口（防重复探测）
	RecheckAfter time.Duration
	// 每轮最多检查的对象数（防请求风暴）
	MaxPerSweep int
	// 连续瞬时失败达到该值 → unavailable（此前为 degraded）
	FailureThreshold int
}

// Defaults 生产可用的保守默认值。
func Defaults(repo repository.Repository, store storage.Storage, sourceID string) *Checker {
	return &Checker{
		Repo: repo, Store: store, SourceID: sourceID,
		Timeout: 10 * time.Second, TTL: 30 * time.Minute,
		RecheckAfter: 5 * time.Minute, MaxPerSweep: 200, FailureThreshold: 3,
	}
}

// Sweep 执行一轮检查，返回本轮实际探测的对象数。
func (c *Checker) Sweep(ctx context.Context, now time.Time) (int, error) {
	arts, err := c.Repo.Artifacts().ListPublished(ctx)
	if err != nil {
		return 0, err
	}
	// 最久未检查的优先；新鲜结果跳过
	type todo struct {
		sha       string
		size      int64
		checkedAt time.Time
		prev      *domain.AvailabilityCheck
	}
	var queue []todo
	for _, a := range arts {
		prev, err := c.Repo.Availability().Get(ctx, a.SHA256)
		if err == nil && now.Sub(prev.CheckedAt) < c.RecheckAfter {
			continue
		}
		var at time.Time
		if prev != nil {
			at = prev.CheckedAt
		}
		queue = append(queue, todo{sha: a.SHA256, size: a.Size, checkedAt: at, prev: prev})
	}
	sort.Slice(queue, func(i, j int) bool { return queue[i].checkedAt.Before(queue[j].checkedAt) })
	if len(queue) > c.MaxPerSweep {
		queue = queue[:c.MaxPerSweep]
	}

	checked := 0
	for _, item := range queue {
		if ctx.Err() != nil {
			return checked, ctx.Err()
		}
		c.checkOne(ctx, item.sha, item.size, item.prev, now)
		checked++
	}
	return checked, nil
}

func (c *Checker) checkOne(ctx context.Context, sha string, wantSize int64, prev *domain.AvailabilityCheck, now time.Time) {
	key := storage.PublishedKey(sha)
	opCtx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()

	rec := &domain.AvailabilityCheck{
		SourceID: c.SourceID, ArtifactSHA256: sha, Target: key,
		CheckedAt: now, ExpiresAt: now.Add(c.TTL),
	}
	if prev != nil {
		rec.LastSuccessAt = prev.LastSuccessAt
		rec.LastFailureAt = prev.LastFailureAt
		rec.ConsecutiveFailures = prev.ConsecutiveFailures
	}

	info, err := c.Store.Head(opCtx, key)
	switch {
	case err == nil && info.Size == wantSize:
		t := now
		rec.Status = domain.AvailabilityHealthy
		rec.LastSuccessAt = &t
		rec.ConsecutiveFailures = 0
		rec.ErrorCategory = domain.AvailErrNone
	case err == nil: // 对象存在但大小不符：数据损坏，硬错误
		t := now
		rec.Status = domain.AvailabilityUnavailable
		rec.LastFailureAt = &t
		rec.ConsecutiveFailures++
		rec.ErrorCategory = domain.AvailErrSizeMismatch
	default:
		t := now
		rec.LastFailureAt = &t
		rec.ConsecutiveFailures++
		rec.ErrorCategory = classify(err)
		if rec.ErrorCategory == domain.AvailErrNotFound {
			// 对象缺失：硬错误，直接 unavailable
			rec.Status = domain.AvailabilityUnavailable
		} else if rec.ConsecutiveFailures >= c.FailureThreshold {
			rec.Status = domain.AvailabilityUnavailable
		} else {
			rec.Status = domain.AvailabilityDegraded
		}
	}
	_ = c.Repo.Availability().Upsert(ctx, rec)
}

// classify 存储错误归类（不泄漏路径等细节）。
func classify(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return domain.AvailErrTimeout
	case errors.Is(err, os.ErrNotExist):
		return domain.AvailErrNotFound
	case strings.Contains(err.Error(), "cannot find"):
		return domain.AvailErrNotFound
	default:
		return domain.AvailErrStorageError
	}
}

// Run 周期执行 Sweep 直到 ctx 结束（worker/开发内嵌循环使用）。
func (c *Checker) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	// 启动即执行一次，让新部署尽快有真实状态
	_, _ = c.Sweep(ctx, time.Now().UTC())
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = c.Sweep(ctx, time.Now().UTC())
		}
	}
}
