// Package metrics 轻量进程内指标（Prometheus 文本格式，无外部依赖）。
// 覆盖 RC 要求的运维可观测性：发布/扫描/metadata/下载授权/OAuth/Webhook 失败、
// 任务队列深度、source health、backup 状态。
package metrics

import (
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
)

// 计数器名（append-only 语义：只增不减）。
const (
	PublishFailures      = "useful_publish_failures_total"
	ScanFailures         = "useful_scan_failures_total"
	MetadataFailures     = "useful_metadata_publish_failures_total"
	DownloadAuthFailures = "useful_download_authorization_failures_total"
	OAuthFailures        = "useful_oauth_failures_total"
	WebhookFailures      = "useful_webhook_failures_total"
	HTTPRequests         = "useful_http_requests_total"
)

// 仪表名（可增可减的瞬时值）。
const (
	JobQueueDepth     = "useful_job_queue_depth"
	SourceHealthy     = "useful_source_artifacts_healthy"
	SourceUnavailable = "useful_source_artifacts_unavailable"
	BackupAgeSeconds  = "useful_backup_age_seconds"
)

// Registry 并发安全的指标注册表。
type Registry struct {
	mu       sync.RWMutex
	counters map[string]*int64
	gauges   map[string]*int64
	help     map[string]string
}

func New() *Registry {
	r := &Registry{
		counters: map[string]*int64{},
		gauges:   map[string]*int64{},
		help:     map[string]string{},
	}
	// 预注册已知指标，保证即使未触发也在 /metrics 中出现（便于告警规则）
	for _, c := range []string{PublishFailures, ScanFailures, MetadataFailures,
		DownloadAuthFailures, OAuthFailures, WebhookFailures, HTTPRequests} {
		r.counters[c] = new(int64)
	}
	for _, g := range []string{JobQueueDepth, SourceHealthy, SourceUnavailable, BackupAgeSeconds} {
		r.gauges[g] = new(int64)
	}
	return r
}

// Inc 计数器 +1（未知名自动注册）。
func (r *Registry) Inc(name string) { r.Add(name, 1) }

func (r *Registry) Add(name string, delta int64) {
	r.mu.RLock()
	p, ok := r.counters[name]
	r.mu.RUnlock()
	if !ok {
		r.mu.Lock()
		if p, ok = r.counters[name]; !ok {
			p = new(int64)
			r.counters[name] = p
		}
		r.mu.Unlock()
	}
	atomic.AddInt64(p, delta)
}

// SetGauge 设置仪表瞬时值。
func (r *Registry) SetGauge(name string, v int64) {
	r.mu.RLock()
	p, ok := r.gauges[name]
	r.mu.RUnlock()
	if !ok {
		r.mu.Lock()
		if p, ok = r.gauges[name]; !ok {
			p = new(int64)
			r.gauges[name] = p
		}
		r.mu.Unlock()
	}
	atomic.StoreInt64(p, v)
}

// Get 读取计数器/仪表当前值（测试用）。
func (r *Registry) Get(name string) int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if p, ok := r.counters[name]; ok {
		return atomic.LoadInt64(p)
	}
	if p, ok := r.gauges[name]; ok {
		return atomic.LoadInt64(p)
	}
	return 0
}

// Render 输出 Prometheus 文本格式（稳定排序，便于测试与 diff）。
func (r *Registry) Render() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var b []byte
	emit := func(kind string, m map[string]*int64) {
		names := make([]string, 0, len(m))
		for n := range m {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			b = append(b, fmt.Sprintf("# TYPE %s %s\n%s %d\n", n, kind, n, atomic.LoadInt64(m[n]))...)
		}
	}
	emit("counter", r.counters)
	emit("gauge", r.gauges)
	return string(b)
}
