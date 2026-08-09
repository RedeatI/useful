// rateLimiter 行为：限流正确性 + 静默 IP 桶清理（防长期运行无界增长）。
package httpapi

import (
	"fmt"
	"testing"
	"time"
)

func TestRateLimiterAllowsWithinLimit(t *testing.T) {
	rl := newRateLimiter(3, time.Minute)
	now := time.Now()
	for i := 0; i < 3; i++ {
		if !rl.allow("1.2.3.4", now) {
			t.Fatalf("第 %d 次请求不应被限流", i+1)
		}
	}
	if rl.allow("1.2.3.4", now) {
		t.Fatal("超限请求应被拒绝")
	}
	// 其他 IP 不受影响
	if !rl.allow("5.6.7.8", now) {
		t.Fatal("不同 IP 不应被连带限流")
	}
	// 窗口滑过后恢复
	if !rl.allow("1.2.3.4", now.Add(2*time.Minute)) {
		t.Fatal("窗口滑过后应恢复")
	}
}

func TestRateLimiterPurgesIdleBuckets(t *testing.T) {
	rl := newRateLimiter(10, time.Minute)
	now := time.Now()
	// 大量一次性 IP 命中
	for i := 0; i < 1000; i++ {
		rl.allow(fmt.Sprintf("10.0.%d.%d", i/256, i%256), now)
	}
	if len(rl.hits) != 1000 {
		t.Fatalf("预期 1000 个桶，得到 %d", len(rl.hits))
	}
	// 两个窗口期后任一请求触发摊还清理：静默桶必须被回收
	rl.allow("fresh-ip", now.Add(3*time.Minute))
	if len(rl.hits) > 2 {
		t.Fatalf("静默 IP 桶未清理，仍有 %d 个", len(rl.hits))
	}
}
