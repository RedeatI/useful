// catalog 规模基准：真实构建大规模快照，测量耗时与分配。
// 运行：go test ./internal/catalog/ -bench=. -benchmem -run=^$
package catalog

import (
	"context"
	"fmt"
	"testing"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository/memory"
)

// seedCatalog 造 n 个已发布工具（各一个 stable 制品），含少量同名冲突与可用性记录。
func seedCatalog(b *testing.B, n int) *memory.Store {
	b.Helper()
	repo := memory.New()
	now := time.Now().UTC()
	for i := 0; i < n; i++ {
		pub := fmt.Sprintf("ed25519:%064x", i%50) // 50 个发布者（制造同名/多发布者分布）
		tool := fmt.Sprintf("com.bench.tool-%06d", i)
		sha := fmt.Sprintf("%064x", i)
		_ = repo.Tools().Upsert(context.Background(), &domain.Tool{
			PublisherKeyID: pub, ToolID: tool, Name: tool, AccessMode: "free", CreatedAt: now,
		})
		_ = repo.Artifacts().Create(context.Background(), &domain.Artifact{
			ID: "a" + sha, PublisherKeyID: pub, ToolID: tool, Version: "1.0.0",
			Channel: "stable", Platform: "windows", Arch: "x64", SHA256: sha,
			ManifestDigest: sha, Size: 1024, Status: domain.ArtifactPublished,
			PublishedAt: &now, CreatedAt: now, Permissions: []string{},
			PublisherSignatureVerified: true, SecurityScanPassed: true, OfficialReviewPassed: true,
		})
		// 每 10 个写一条可用性记录，验证推导路径在规模下的开销
		if i%10 == 0 {
			_ = repo.Availability().Upsert(context.Background(), &domain.AvailabilityCheck{
				SourceID: "com.bench.src", ArtifactSHA256: sha, Target: "t",
				Status: domain.AvailabilityHealthy, CheckedAt: now, ExpiresAt: now.Add(time.Hour),
			})
		}
	}
	return repo
}

func benchSnapshot(b *testing.B, n int) {
	repo := seedCatalog(b, n)
	svc := &Service{Repo: repo, SourceID: "com.bench.src"}
	now := time.Now().UTC()
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		snap, err := svc.BuildSnapshot(context.Background(), now)
		if err != nil {
			b.Fatal(err)
		}
		if len(snap.Entries) == 0 {
			b.Fatal("empty snapshot")
		}
	}
}

func BenchmarkCatalogSnapshot1k(b *testing.B)   { benchSnapshot(b, 1000) }
func BenchmarkCatalogSnapshot10k(b *testing.B)  { benchSnapshot(b, 10000) }
func BenchmarkCatalogSnapshot100k(b *testing.B) { benchSnapshot(b, 100000) }

func BenchmarkCatalogSearch100k(b *testing.B) {
	repo := seedCatalog(b, 100000)
	svc := &Service{Repo: repo, SourceID: "com.bench.src"}
	now := time.Now().UTC()
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		out, err := svc.Search(context.Background(), "tool-050000", 100, now)
		if err != nil {
			b.Fatal(err)
		}
		_ = out
	}
}
