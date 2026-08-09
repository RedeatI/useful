//go:build pgintegration

// PostgreSQL 仓库集成测试。需要真实数据库（运行：go test -tags pgintegration ./internal/repository/postgres）。
// 环境变量 TEST_DATABASE_URL 指向可写测试库（会应用 migrations）。
package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"useful.dev/source/internal/domain"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("未设置 TEST_DATABASE_URL")
	}
	s, err := Open(context.Background(), dsn, "../../../migrations")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestMetadataPublishLeaseSerializesAcrossStores(t *testing.T) {
	first := testStore(t)
	second := testStore(t)
	ctx := context.Background()
	lease1, err := first.Metadata().AcquirePublishLease(ctx)
	if err != nil {
		t.Fatal(err)
	}
	released1 := false
	defer func() {
		if !released1 {
			_ = lease1.Release()
		}
	}()

	waitCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, err := second.Metadata().AcquirePublishLease(waitCtx); err == nil {
		t.Fatal("second store must not acquire the fixed advisory lock while first lease is held")
	}
	version1, err := lease1.NextVersion(ctx, time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	if err := lease1.Release(); err != nil {
		t.Fatal(err)
	}
	released1 = true

	lease2, err := second.Metadata().AcquirePublishLease(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lease2.Release()
	version2, err := lease2.NextVersion(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if version2 <= version1 {
		t.Fatalf("persistent metadata version must increase across stores: first=%d second=%d", version1, version2)
	}
}

func TestArtifactUniqueConstraint(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	pk := "ed25519:" + strings.Repeat("ab", 32)
	_ = s.Publishers().Create(ctx, &domain.Publisher{ID: "p", DisplayName: "P", KeyID: pk, CreatedAt: now})
	_ = s.Tools().Upsert(ctx, &domain.Tool{PublisherKeyID: pk, ToolID: "com.x.t", Name: "T", AccessMode: "free", CreatedAt: now})
	a := &domain.Artifact{
		ID: "art1", PublisherKeyID: pk, ToolID: "com.x.t", Version: "1.0.0",
		Channel: "stable", Platform: "windows", Arch: "x86_64",
		SHA256: "aa", ManifestDigest: "bb", Size: 1, FileName: "t.useful",
		Permissions: []string{}, Status: domain.ArtifactStaged, CreatedAt: now,
	}
	if err := s.Artifacts().Create(ctx, a); err != nil {
		t.Fatal(err)
	}
	dup := *a
	dup.ID = "art2"
	if err := s.Artifacts().Create(ctx, &dup); err != domain.ErrConflict {
		t.Fatalf("同 identity+version+platform+arch 必须冲突: %v", err)
	}
}

func TestAuditAppendOnly(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.Audit().Append(ctx, &domain.AuditEvent{At: time.Now(), Actor: "t", Action: "x"}); err != nil {
		t.Fatal(err)
	}
	// 触发器禁止 UPDATE/DELETE
	if _, err := s.db.ExecContext(ctx, `UPDATE audit_logs SET actor='y'`); err == nil {
		t.Fatal("audit_logs 必须禁止 UPDATE")
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM audit_logs`); err == nil {
		t.Fatal("audit_logs 必须禁止 DELETE")
	}
}

func TestBillingEventUnique(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	e := &domain.BillingEvent{EventID: "evt_x", Provider: "fake", Kind: "k", ObjectTime: time.Now(), ReceivedAt: time.Now()}
	if err := s.Billing().InsertEvent(ctx, e); err != nil {
		t.Fatal(err)
	}
	if err := s.Billing().InsertEvent(ctx, e); err != domain.ErrConflict {
		t.Fatalf("重复 event_id 必须冲突: %v", err)
	}
}

func TestSubscriptionOutOfOrder(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	t1 := time.Now().UTC()
	_ = s.Billing().UpsertSubscription(ctx, &domain.Subscription{ID: "sub_o", CustomerID: "c", ProductID: "p", PlanID: "pl", Status: "canceled", ObjectTime: t1, UpdatedAt: t1})
	// 旧事件（更早 object_time）不得覆盖
	_ = s.Billing().UpsertSubscription(ctx, &domain.Subscription{ID: "sub_o", CustomerID: "c", ProductID: "p", PlanID: "pl", Status: "active", ObjectTime: t1.Add(-time.Hour), UpdatedAt: time.Now()})
	sub, _ := s.Billing().GetSubscription(ctx, "sub_o")
	if sub.Status != "canceled" {
		t.Fatalf("乱序旧事件不得覆盖: %s", sub.Status)
	}
}
