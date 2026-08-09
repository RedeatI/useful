package metrics

import (
	"strings"
	"sync"
	"testing"
)

func TestMetrics_CounterAndGauge(t *testing.T) {
	r := New()
	r.Inc(PublishFailures)
	r.Inc(PublishFailures)
	r.Add(WebhookFailures, 3)
	r.SetGauge(JobQueueDepth, 7)
	if r.Get(PublishFailures) != 2 {
		t.Fatalf("publish failures 应为 2，得到 %d", r.Get(PublishFailures))
	}
	if r.Get(WebhookFailures) != 3 {
		t.Fatalf("webhook failures 应为 3")
	}
	if r.Get(JobQueueDepth) != 7 {
		t.Fatalf("queue depth 应为 7")
	}
}

func TestMetrics_RenderPrometheus(t *testing.T) {
	r := New()
	r.Inc(OAuthFailures)
	out := r.Render()
	// 预注册指标即使为 0 也应出现（便于告警规则）
	for _, name := range []string{PublishFailures, ScanFailures, MetadataFailures,
		DownloadAuthFailures, OAuthFailures, WebhookFailures, JobQueueDepth,
		SourceHealthy, SourceUnavailable, BackupAgeSeconds} {
		if !strings.Contains(out, name) {
			t.Fatalf("/metrics 缺少预注册指标 %s", name)
		}
	}
	if !strings.Contains(out, OAuthFailures+" 1") {
		t.Fatalf("oauth failures 渲染错误:\n%s", out)
	}
	if !strings.Contains(out, "# TYPE "+JobQueueDepth+" gauge") {
		t.Fatalf("gauge 类型标注缺失")
	}
}

func TestMetrics_ConcurrentSafe(t *testing.T) {
	r := New()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				r.Inc(ScanFailures)
			}
		}()
	}
	wg.Wait()
	if r.Get(ScanFailures) != 5000 {
		t.Fatalf("并发计数错误，应为 5000，得到 %d", r.Get(ScanFailures))
	}
}
