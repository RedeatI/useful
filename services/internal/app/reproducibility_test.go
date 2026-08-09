// 复现构建 catalog 推导测试：reproducibleBuildVerified 只有真实 verified 才为 true。
package app_test

import (
	"context"
	"testing"
	"time"

	"useful.dev/source/internal/catalog"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository/memory"
)

func publishRepro(t *testing.T, repo *memory.Store, id, sha, reproStatus string, claimed bool) {
	t.Helper()
	now := time.Now().UTC()
	_ = repo.Tools().Upsert(context.Background(), &domain.Tool{
		PublisherKeyID: "ed25519:pubpubpubpubpubpub", ToolID: id,
		Name: id, AccessMode: "free", CreatedAt: now,
	})
	_ = repo.Artifacts().Create(context.Background(), &domain.Artifact{
		ID: "art-" + id, PublisherKeyID: "ed25519:pubpubpubpubpubpub", ToolID: id,
		Version: "1.0.0", Channel: "stable", Platform: "windows", Arch: "x64",
		SHA256: sha, ManifestDigest: sha, Size: 10,
		Status: domain.ArtifactPublished, CreatedAt: now, PublishedAt: &now,
		Permissions:         []string{},
		ReproducibleClaimed: claimed, ReproStatus: reproStatus, ReproStrategy: "dual-build",
	})
}

func TestCatalog_ReproducibleOnlyTrueWhenVerified(t *testing.T) {
	repo := memory.New()
	// 工具 A：仅作者声明 claimed（未验证）
	publishRepro(t, repo, "tool-claimed", "aa"+padSha("claimed"), "claimed", true)
	// 工具 B：官方 verified
	publishRepro(t, repo, "tool-verified", "bb"+padSha("verified"), "verified", true)
	// 工具 C：无任何信息
	publishRepro(t, repo, "tool-unknown", "cc"+padSha("unknown"), "", false)

	cat := &catalog.Service{Repo: repo, SourceID: "com.test.src"}
	snap, err := cat.BuildSnapshot(context.Background(), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range snap.Entries {
		switch e.Identity.ToolID {
		case "tool-claimed":
			if e.Review["reproducibleBuildVerified"] {
				t.Fatal("仅声明不得 reproducibleBuildVerified=true")
			}
			if e.ReproducibleBuild == nil || e.ReproducibleBuild.Status != "claimed" {
				t.Fatalf("应展示 claimed 状态，得到 %+v", e.ReproducibleBuild)
			}
		case "tool-verified":
			if !e.Review["reproducibleBuildVerified"] {
				t.Fatal("官方 verified 应 reproducibleBuildVerified=true")
			}
			if e.ReproducibleBuild.Status != "verified" || e.ReproducibleBuild.Strategy != "dual-build" {
				t.Fatalf("应展示 verified + 策略，得到 %+v", e.ReproducibleBuild)
			}
		case "tool-unknown":
			if e.Review["reproducibleBuildVerified"] || e.ReproducibleBuild.Status != "unknown" {
				t.Fatalf("无信息应 unknown，得到 %+v", e.ReproducibleBuild)
			}
		}
	}
}

// padSha 生成 64 hex 摘要（前缀已占 2 位）。
func padSha(seed string) string {
	s := ""
	for len(s) < 62 {
		s += seed
	}
	// 只保留 hex 字符
	out := make([]byte, 0, 62)
	for i := 0; i < len(s) && len(out) < 62; i++ {
		c := s[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
			out = append(out, c)
		} else {
			out = append(out, 'a'+c%6)
		}
	}
	for len(out) < 62 {
		out = append(out, 'a')
	}
	return string(out)
}
