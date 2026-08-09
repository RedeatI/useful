package billing

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository/memory"
)

func event(id, subID, status string, objectTime time.Time) []byte {
	b, _ := json.Marshal(WebhookEvent{
		EventID: id, Kind: "subscription.updated",
		SubscriptionID: subID, CustomerID: "cus_1",
		ProductID: "prod_pro", PlanID: "plan_month",
		Status: status, ObjectTime: objectTime,
	})
	return b
}

func newProcessor() (*Processor, *Fake) {
	fake := &Fake{Secret: []byte("test-secret")}
	return &Processor{Repo: memory.New(), Provider: fake}, fake
}

func TestWebhookSignatureRejected(t *testing.T) {
	p, _ := newProcessor()
	body := event("evt_1", "sub_1", "active", time.Now())
	if _, err := p.Handle(context.Background(), body, "deadbeef"); err == nil {
		t.Fatal("伪造签名必须被拒绝")
	}
}

func TestWebhookIdempotencyAndReplay(t *testing.T) {
	p, fake := newProcessor()
	now := time.Now().UTC()
	body := event("evt_1", "sub_1", "active", now)
	sig := fake.SignWebhook(body)

	dup, err := p.Handle(context.Background(), body, sig)
	if err != nil || dup {
		t.Fatalf("首次处理失败: dup=%v err=%v", dup, err)
	}
	// 重放：同 event id → duplicate，不重复发放权益
	dup, err = p.Handle(context.Background(), body, sig)
	if err != nil {
		t.Fatalf("重放不应报错: %v", err)
	}
	if !dup {
		t.Fatal("重放必须被识别为 duplicate")
	}
	ents, _ := p.Repo.Entitlements().ListBySubject(context.Background(), "cus_1")
	if len(ents) != 1 {
		t.Fatalf("权益应只有一条，实际 %d", len(ents))
	}
	if ents[0].Status != domain.EntitlementActive {
		t.Fatalf("权益应为 active，实际 %s", ents[0].Status)
	}
}

func TestWebhookOutOfOrder(t *testing.T) {
	p, fake := newProcessor()
	t1 := time.Now().UTC()
	t0 := t1.Add(-time.Hour)

	// 新事件先到（canceled @t1），旧事件后到（active @t0）→ 状态保持 canceled
	newer := event("evt_new", "sub_1", "canceled", t1)
	older := event("evt_old", "sub_1", "active", t0)
	if _, err := p.Handle(context.Background(), newer, fake.SignWebhook(newer)); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Handle(context.Background(), older, fake.SignWebhook(older)); err != nil {
		t.Fatal(err)
	}
	sub, err := p.Repo.Billing().GetSubscription(context.Background(), "sub_1")
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != "canceled" {
		t.Fatalf("乱序旧事件不得覆盖新状态，实际 %s", sub.Status)
	}
}

func TestCanceledSubscriptionBlocksNewDownloadsOnly(t *testing.T) {
	p, fake := newProcessor()
	now := time.Now().UTC()
	activate := event("evt_1", "sub_1", "active", now)
	cancel := event("evt_2", "sub_1", "canceled", now.Add(time.Minute))
	_, _ = p.Handle(context.Background(), activate, fake.SignWebhook(activate))
	_, _ = p.Handle(context.Background(), cancel, fake.SignWebhook(cancel))

	ents, _ := p.Repo.Entitlements().ListBySubject(context.Background(), "cus_1")
	if len(ents) != 1 || ents[0].Status != domain.EntitlementCanceled {
		t.Fatalf("取消后权益应为 canceled: %+v", ents)
	}
	// 取消后：不允许新的付费下载（已安装本地版本继续运行——客户端语义，服务端只拒新授权）
	if ents[0].AllowsNewDownload(now.Add(2 * time.Minute)) {
		t.Fatal("canceled 权益不得允许新的付费下载")
	}
}

func TestPastDueGracePeriod(t *testing.T) {
	p, fake := newProcessor()
	now := time.Now().UTC()
	body := event("evt_1", "sub_1", "past_due", now)
	if _, err := p.Handle(context.Background(), body, fake.SignWebhook(body)); err != nil {
		t.Fatal(err)
	}
	ents, _ := p.Repo.Entitlements().ListBySubject(context.Background(), "cus_1")
	if len(ents) != 1 || ents[0].Status != domain.EntitlementPastDue {
		t.Fatalf("应为 past_due: %+v", ents)
	}
	// 宽限期内允许下载，宽限期后拒绝
	if !ents[0].AllowsNewDownload(now.Add(24 * time.Hour)) {
		t.Fatal("宽限期内应允许下载")
	}
	if ents[0].AllowsNewDownload(now.Add(8 * 24 * time.Hour)) {
		t.Fatal("宽限期后必须拒绝")
	}
}

func TestDisabledProviderRefusesEverything(t *testing.T) {
	d := Disabled{}
	if _, err := d.CreateCheckoutSession(context.Background(), "c", "p", "pl"); err == nil {
		t.Fatal("disabled 必须拒绝结账")
	}
	if err := d.VerifyWebhook(nil, ""); err == nil {
		t.Fatal("disabled 必须拒绝 webhook")
	}
}
