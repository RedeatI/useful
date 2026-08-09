// Package billing 定义 BillingProvider 接口与 Disabled / Fake 实现。
// 支付平台绝不写死在 domain 层；不处理/保存银行卡数据；结账用平台托管页面。
// Webhook：验签、原始体校验、event id 唯一、幂等、乱序防护。
package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository"
)

var ErrDisabled = errors.New("billing disabled")

// CheckoutSession 托管结账会话（URL 指向支付平台页面）。
type CheckoutSession struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// WebhookEvent 归一化后的 webhook 事件。
type WebhookEvent struct {
	EventID        string    `json:"eventId"`
	Kind           string    `json:"kind"` // subscription.updated 等
	SubscriptionID string    `json:"subscriptionId"`
	CustomerID     string    `json:"customerId"`
	ProductID      string    `json:"productId"`
	PlanID         string    `json:"planId"`
	Status         string    `json:"status"`     // provider 原始状态
	ObjectTime     time.Time `json:"objectTime"` // provider 对象版本时间（乱序处理依据）
}

// BillingProvider 支付适配器接口。
type BillingProvider interface {
	Name() string
	CreateCheckoutSession(ctx context.Context, customerID, productID, planID string) (*CheckoutSession, error)
	CreateCustomerPortalSession(ctx context.Context, customerID string) (string, error)
	GetSubscription(ctx context.Context, id string) (*domain.Subscription, error)
	CancelSubscription(ctx context.Context, id string) error
	// ParseWebhook 解析原始请求体（不做信任判断）。
	ParseWebhook(body []byte) (*WebhookEvent, error)
	// VerifyWebhook 用原始请求体验证签名头。
	VerifyWebhook(body []byte, signature string) error
	// NormalizeSubscriptionState 把 provider 状态映射为权益状态。
	NormalizeSubscriptionState(providerStatus string) domain.EntitlementStatus
}

// ---------- DisabledBillingProvider ----------

// Disabled：paidDownloads capability=false；一切计费操作被拒绝；免费源全部正常。
type Disabled struct{}

func (Disabled) Name() string { return "disabled" }
func (Disabled) CreateCheckoutSession(context.Context, string, string, string) (*CheckoutSession, error) {
	return nil, ErrDisabled
}
func (Disabled) CreateCustomerPortalSession(context.Context, string) (string, error) {
	return "", ErrDisabled
}
func (Disabled) GetSubscription(context.Context, string) (*domain.Subscription, error) {
	return nil, ErrDisabled
}
func (Disabled) CancelSubscription(context.Context, string) error { return ErrDisabled }
func (Disabled) ParseWebhook([]byte) (*WebhookEvent, error)       { return nil, ErrDisabled }
func (Disabled) VerifyWebhook([]byte, string) error               { return ErrDisabled }
func (Disabled) NormalizeSubscriptionState(string) domain.EntitlementStatus {
	return domain.EntitlementExpired
}

// ---------- FakeBillingProvider ----------

// Fake：测试/演示用。Webhook 体为 JSON，签名 = HMAC-SHA256(body, secret)。
// 生产环境启用会在 config.Validate 被拒绝。
type Fake struct {
	Secret []byte
}

func (Fake) Name() string { return "fake" }

func (f *Fake) CreateCheckoutSession(_ context.Context, customerID, productID, planID string) (*CheckoutSession, error) {
	id := fmt.Sprintf("cs_fake_%s_%s_%s", customerID, productID, planID)
	return &CheckoutSession{ID: id, URL: "https://billing.invalid/checkout/" + id}, nil
}

func (f *Fake) CreateCustomerPortalSession(_ context.Context, customerID string) (string, error) {
	return "https://billing.invalid/portal/" + customerID, nil
}

func (f *Fake) GetSubscription(context.Context, string) (*domain.Subscription, error) {
	return nil, domain.ErrNotFound
}

func (f *Fake) CancelSubscription(context.Context, string) error { return nil }

func (f *Fake) ParseWebhook(body []byte) (*WebhookEvent, error) {
	var ev WebhookEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return nil, fmt.Errorf("%w: webhook 体解析失败", domain.ErrInvalidInput)
	}
	if ev.EventID == "" || ev.SubscriptionID == "" {
		return nil, fmt.Errorf("%w: webhook 缺少必需字段", domain.ErrInvalidInput)
	}
	return &ev, nil
}

func (f *Fake) VerifyWebhook(body []byte, signature string) error {
	mac := hmac.New(sha256.New, f.Secret)
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	sig, err := hex.DecodeString(signature)
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		_ = want
		return fmt.Errorf("%w: webhook 签名无效", domain.ErrForbidden)
	}
	return nil
}

// SignWebhook 供测试构造合法签名。
func (f *Fake) SignWebhook(body []byte) string {
	mac := hmac.New(sha256.New, f.Secret)
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func (Fake) NormalizeSubscriptionState(providerStatus string) domain.EntitlementStatus {
	switch providerStatus {
	case "active":
		return domain.EntitlementActive
	case "trialing":
		return domain.EntitlementTrialing
	case "past_due":
		return domain.EntitlementPastDue
	case "canceled":
		return domain.EntitlementCanceled
	case "revoked":
		return domain.EntitlementRevoked
	default:
		return domain.EntitlementExpired
	}
}

// ---------- Webhook 处理（provider 无关） ----------

// Processor 把已验签的 webhook 事件幂等地落库并更新订阅/权益。
type Processor struct {
	Repo     repository.Repository
	Provider BillingProvider
	Now      func() time.Time
}

// Handle 返回 (isDuplicate, error)。重复事件不重复发放权益。
func (p *Processor) Handle(ctx context.Context, body []byte, signature string) (bool, error) {
	if err := p.Provider.VerifyWebhook(body, signature); err != nil {
		return false, err
	}
	ev, err := p.Provider.ParseWebhook(body)
	if err != nil {
		return false, err
	}
	now := p.now()

	// 幂等：event_id 唯一约束（重放直接短路，不重复处理）
	insertErr := p.Repo.Billing().InsertEvent(ctx, &domain.BillingEvent{
		EventID:    ev.EventID,
		Provider:   p.Provider.Name(),
		Kind:       ev.Kind,
		ObjectTime: ev.ObjectTime,
		Processed:  false,
		ReceivedAt: now,
	})
	if errors.Is(insertErr, domain.ErrConflict) {
		return true, nil
	}
	if insertErr != nil {
		return false, insertErr
	}

	// 订阅状态：按 provider 对象时间处理乱序（旧事件不覆盖新状态）
	if err := p.Repo.Billing().UpsertSubscription(ctx, &domain.Subscription{
		ID:         ev.SubscriptionID,
		CustomerID: ev.CustomerID,
		ProductID:  ev.ProductID,
		PlanID:     ev.PlanID,
		Status:     ev.Status,
		ObjectTime: ev.ObjectTime,
		UpdatedAt:  now,
	}); err != nil {
		return false, err
	}

	// 权益派生（订阅乱序防护后再读回最新状态）
	sub, err := p.Repo.Billing().GetSubscription(ctx, ev.SubscriptionID)
	if err != nil {
		return false, err
	}
	status := p.Provider.NormalizeSubscriptionState(sub.Status)
	ent := &domain.Entitlement{
		ID:        "ent_" + ev.SubscriptionID,
		SubjectID: ev.CustomerID,
		ProductID: ev.ProductID,
		PlanID:    ev.PlanID,
		ToolScope: "*",
		Status:    status,
		StartsAt:  now,
		UpdatedAt: now,
	}
	if status == domain.EntitlementGrace || status == domain.EntitlementPastDue {
		g := now.Add(7 * 24 * time.Hour)
		ent.GraceUntil = &g
	}
	if err := p.Repo.Entitlements().Upsert(ctx, ent); err != nil {
		return false, err
	}
	if err := p.Repo.Billing().MarkEventProcessed(ctx, ev.EventID); err != nil {
		return false, err
	}
	// 审计（不含敏感载荷）
	_ = p.Repo.Audit().Append(ctx, &domain.AuditEvent{
		At: now, Actor: "webhook:" + p.Provider.Name(),
		Action: "billing." + ev.Kind, Detail: "subscription=" + ev.SubscriptionID,
	})
	return false, nil
}

func (p *Processor) now() time.Time {
	if p.Now != nil {
		return p.Now().UTC()
	}
	return time.Now().UTC()
}
