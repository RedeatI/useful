// catalog 快照缓存行为：TTL 命中、过期重建、显式失效、搜索走缓存。
package catalog

import (
	"context"
	"fmt"
	"testing"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository/memory"
)

func seedOneTool(t *testing.T, repo *memory.Store, id string) {
	t.Helper()
	now := time.Now().UTC()
	pub := "ed25519:" + fmt.Sprintf("%064x", 1)
	sha := fmt.Sprintf("%064x", len(id)+1000)
	if err := repo.Tools().Upsert(context.Background(), &domain.Tool{
		PublisherKeyID: pub, ToolID: id, Name: id, AccessMode: "free", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := repo.Artifacts().Create(context.Background(), &domain.Artifact{
		ID: "a-" + id, PublisherKeyID: pub, ToolID: id, Version: "1.0.0",
		Channel: "stable", Platform: "windows", Arch: "x64", SHA256: sha,
		ManifestDigest: sha, Size: 1, Status: domain.ArtifactPublished,
		PublishedAt: &now, CreatedAt: now, Permissions: []string{},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCachedSnapshotHitAndInvalidate(t *testing.T) {
	repo := memory.New()
	seedOneTool(t, repo, "com.test.a")
	svc := &Service{Repo: repo, SourceID: "com.test.src", CacheTTL: time.Minute}
	now := time.Now().UTC()

	s1, err := svc.CachedSnapshot(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(s1.Entries) != 1 {
		t.Fatalf("期望 1 条目，得到 %d", len(s1.Entries))
	}

	// TTL 内新增发布不可见（缓存命中，返回同一份快照）
	seedOneTool(t, repo, "com.test.b")
	s2, _ := svc.CachedSnapshot(context.Background(), now.Add(time.Second))
	if len(s2.Entries) != 1 {
		t.Fatalf("TTL 内应命中缓存，得到 %d 条目", len(s2.Entries))
	}

	// 显式失效后立即可见（发布侧变更路径）
	svc.Invalidate()
	s3, _ := svc.CachedSnapshot(context.Background(), now.Add(2*time.Second))
	if len(s3.Entries) != 2 {
		t.Fatalf("Invalidate 后应重建，得到 %d 条目", len(s3.Entries))
	}
}

func TestCachedSnapshotTTLExpiry(t *testing.T) {
	repo := memory.New()
	seedOneTool(t, repo, "com.test.a")
	svc := &Service{Repo: repo, SourceID: "com.test.src", CacheTTL: 10 * time.Second}
	now := time.Now().UTC()

	if _, err := svc.CachedSnapshot(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	seedOneTool(t, repo, "com.test.b")

	// TTL 过期后自动重建，兜底后台状态（可用性）新鲜度
	s, _ := svc.CachedSnapshot(context.Background(), now.Add(11*time.Second))
	if len(s.Entries) != 2 {
		t.Fatalf("TTL 过期后应重建，得到 %d 条目", len(s.Entries))
	}
}

func TestSearchUsesCachedSnapshot(t *testing.T) {
	repo := memory.New()
	seedOneTool(t, repo, "com.test.a")
	svc := &Service{Repo: repo, SourceID: "com.test.src", CacheTTL: time.Minute}
	now := time.Now().UTC()

	if _, err := svc.Search(context.Background(), "", 10, now); err != nil {
		t.Fatal(err)
	}
	seedOneTool(t, repo, "com.test.b")
	out, err := svc.Search(context.Background(), "", 10, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("搜索应走缓存快照，得到 %d 条目", len(out))
	}
}
