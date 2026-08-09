// 可用性检查故障测试：对象不存在 / 存储超时 / 部分失败 / 全部失败 /
// 状态过期 / 服务恢复 / 大量制品不造成请求风暴。
package availability_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"useful.dev/source/internal/availability"
	"useful.dev/source/internal/catalog"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository/memory"
	"useful.dev/source/internal/storage"
)

// stubStore 可编程 Storage：按键返回成功/错误。
type stubStore struct {
	sizes map[string]int64 // key → size；缺失返回 os.ErrNotExist 语义
	err   error            // 非 nil 时所有 Head 返回该错误
	heads int              // Head 调用计数（风暴测试）
}

func (s *stubStore) Head(_ context.Context, key string) (storage.ObjectInfo, error) {
	s.heads++
	if s.err != nil {
		return storage.ObjectInfo{}, s.err
	}
	size, ok := s.sizes[key]
	if !ok {
		return storage.ObjectInfo{}, fmt.Errorf("open %s: The system cannot find the file", key)
	}
	return storage.ObjectInfo{Size: size}, nil
}

func (s *stubStore) Put(context.Context, string, io.Reader, int64) error { return nil }
func (s *stubStore) PutIfAbsentOrSame(context.Context, string, io.Reader, int64) error {
	return nil
}
func (s *stubStore) Get(context.Context, string) (io.ReadCloser, storage.ObjectInfo, error) {
	return nil, storage.ObjectInfo{}, fmt.Errorf("not implemented")
}
func (s *stubStore) DeleteStaging(context.Context, string) error           { return nil }
func (s *stubStore) CopyToPublished(context.Context, string, string) error { return nil }
func (s *stubStore) CreateDownloadURL(context.Context, string, time.Duration) (string, error) {
	return "", nil
}
func (s *stubStore) SupportsRange() bool { return false }

func shaOf(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

func publish(t *testing.T, repo *memory.Store, toolID, seed string, size int64) string {
	t.Helper()
	sha := shaOf(seed)
	now := time.Now().UTC()
	_ = repo.Tools().Upsert(context.Background(), &domain.Tool{
		PublisherKeyID: "ed25519:pubkeypubkeypubkey", ToolID: toolID,
		Name: toolID, AccessMode: "free", CreatedAt: now,
	})
	if err := repo.Artifacts().Create(context.Background(), &domain.Artifact{
		ID: "art-" + seed, PublisherKeyID: "ed25519:pubkeypubkeypubkey", ToolID: toolID,
		Version: "1.0.0", Channel: "stable", Platform: "windows", Arch: "x64",
		SHA256: sha, ManifestDigest: shaOf("m" + seed), Size: size,
		Status: domain.ArtifactPublished, CreatedAt: now, PublishedAt: &now,
		Permissions: []string{},
	}); err != nil {
		t.Fatal(err)
	}
	return sha
}

func newChecker(repo *memory.Store, store storage.Storage) *availability.Checker {
	c := availability.Defaults(repo, store, "com.test.src")
	c.RecheckAfter = 0 // 测试中每次 Sweep 都重查
	return c
}

func TestAvailability_HealthyAndMissing(t *testing.T) {
	repo := memory.New()
	store := &stubStore{sizes: map[string]int64{}}
	okSHA := publish(t, repo, "tool-ok", "ok", 100)
	missSHA := publish(t, repo, "tool-miss", "miss", 100)
	store.sizes[storage.PublishedKey(okSHA)] = 100

	c := newChecker(repo, store)
	now := time.Now().UTC()
	if _, err := c.Sweep(context.Background(), now); err != nil {
		t.Fatal(err)
	}

	ok, _ := repo.Availability().Get(context.Background(), okSHA)
	if ok.Effective(now) != domain.AvailabilityHealthy {
		t.Fatalf("存在对象应 healthy，得到 %s", ok.Status)
	}
	miss, _ := repo.Availability().Get(context.Background(), missSHA)
	if miss.Effective(now) != domain.AvailabilityUnavailable || miss.ErrorCategory != domain.AvailErrNotFound {
		t.Fatalf("缺失对象应 unavailable/not-found，得到 %s/%s", miss.Status, miss.ErrorCategory)
	}

	// catalog 推导：healthy 工具 true，缺失工具 false
	cat := &catalog.Service{Repo: repo, SourceID: "com.test.src"}
	snap, err := cat.BuildSnapshot(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range snap.Entries {
		want := e.Identity.ToolID == "tool-ok"
		if e.Review["sourceAvailable"] != want {
			t.Fatalf("%s sourceAvailable 应为 %v", e.Identity.ToolID, want)
		}
		if e.Availability == nil || e.Availability.CheckedAt == "" {
			t.Fatalf("%s 缺少可用性视图/检查时间", e.Identity.ToolID)
		}
	}
}

func TestAvailability_SizeMismatchIsHardFailure(t *testing.T) {
	repo := memory.New()
	store := &stubStore{sizes: map[string]int64{}}
	sha := publish(t, repo, "tool-bad", "bad", 100)
	store.sizes[storage.PublishedKey(sha)] = 55 // 与数据库记录不一致

	c := newChecker(repo, store)
	now := time.Now().UTC()
	_, _ = c.Sweep(context.Background(), now)
	rec, _ := repo.Availability().Get(context.Background(), sha)
	if rec.Status != domain.AvailabilityUnavailable || rec.ErrorCategory != domain.AvailErrSizeMismatch {
		t.Fatalf("大小不符应 unavailable/size-mismatch，得到 %s/%s", rec.Status, rec.ErrorCategory)
	}
}

func TestAvailability_TransientErrorsDegradeThenUnavailable(t *testing.T) {
	repo := memory.New()
	store := &stubStore{sizes: map[string]int64{}, err: context.DeadlineExceeded}
	sha := publish(t, repo, "tool-slow", "slow", 100)

	c := newChecker(repo, store)
	now := time.Now().UTC()

	// 失败 1、2 次 → degraded
	for i := 0; i < 2; i++ {
		_, _ = c.Sweep(context.Background(), now.Add(time.Duration(i)*time.Second))
	}
	rec, _ := repo.Availability().Get(context.Background(), sha)
	if rec.Status != domain.AvailabilityDegraded || rec.ErrorCategory != domain.AvailErrTimeout {
		t.Fatalf("前两次超时应 degraded/timeout，得到 %s/%s", rec.Status, rec.ErrorCategory)
	}

	// 第 3 次 → unavailable
	_, _ = c.Sweep(context.Background(), now.Add(3*time.Second))
	rec, _ = repo.Availability().Get(context.Background(), sha)
	if rec.Status != domain.AvailabilityUnavailable || rec.ConsecutiveFailures != 3 {
		t.Fatalf("连续 3 次失败应 unavailable，得到 %s (fails=%d)", rec.Status, rec.ConsecutiveFailures)
	}

	// 服务恢复 → healthy，连续失败清零
	store.err = nil
	store.sizes[storage.PublishedKey(sha)] = 100
	_, _ = c.Sweep(context.Background(), now.Add(4*time.Second))
	rec, _ = repo.Availability().Get(context.Background(), sha)
	if rec.Status != domain.AvailabilityHealthy || rec.ConsecutiveFailures != 0 {
		t.Fatalf("恢复后应 healthy/0，得到 %s/%d", rec.Status, rec.ConsecutiveFailures)
	}
	if rec.LastFailureAt == nil || rec.LastSuccessAt == nil {
		t.Fatal("应同时保留最近成功与最近失败时间")
	}
}

func TestAvailability_ExpiredBecomesUnknown(t *testing.T) {
	repo := memory.New()
	store := &stubStore{sizes: map[string]int64{}}
	sha := publish(t, repo, "tool-exp", "exp", 100)
	store.sizes[storage.PublishedKey(sha)] = 100

	c := newChecker(repo, store)
	c.TTL = time.Minute
	now := time.Now().UTC()
	_, _ = c.Sweep(context.Background(), now)

	rec, _ := repo.Availability().Get(context.Background(), sha)
	if rec.Effective(now) != domain.AvailabilityHealthy {
		t.Fatal("检查后应 healthy")
	}
	// TTL 过后：过期结果显示 unknown，不沿用旧 healthy
	later := now.Add(2 * time.Minute)
	if rec.Effective(later) != domain.AvailabilityUnknown {
		t.Fatal("过期结果应显示 unknown")
	}
	cat := &catalog.Service{Repo: repo, SourceID: "com.test.src"}
	snap, _ := cat.BuildSnapshot(context.Background(), later)
	if snap.Entries[0].Review["sourceAvailable"] {
		t.Fatal("过期检查不得给出 sourceAvailable=true")
	}
	if snap.Entries[0].Availability.Status != "unknown" {
		t.Fatalf("过期后视图应 unknown，得到 %s", snap.Entries[0].Availability.Status)
	}
}

func TestAvailability_PartialFailureIsDegradedEntry(t *testing.T) {
	repo := memory.New()
	store := &stubStore{sizes: map[string]int64{}}
	now := time.Now().UTC()
	// 同一工具两个版本：一个可用一个缺失 → 条目 degraded 而非 unavailable
	okSHA := publish(t, repo, "tool-mix", "mix1", 100)
	sha2 := shaOf("mix2")
	_ = repo.Artifacts().Create(context.Background(), &domain.Artifact{
		ID: "art-mix2", PublisherKeyID: "ed25519:pubkeypubkeypubkey", ToolID: "tool-mix",
		Version: "1.1.0", Channel: "stable", Platform: "windows", Arch: "x64",
		SHA256: sha2, ManifestDigest: shaOf("m-mix2"), Size: 100,
		Status: domain.ArtifactPublished, CreatedAt: now, PublishedAt: &now,
		Permissions: []string{},
	})
	store.sizes[storage.PublishedKey(okSHA)] = 100

	c := newChecker(repo, store)
	_, _ = c.Sweep(context.Background(), now)
	cat := &catalog.Service{Repo: repo, SourceID: "com.test.src"}
	snap, _ := cat.BuildSnapshot(context.Background(), now)
	e := snap.Entries[0]
	if e.Availability.Status != "degraded" {
		t.Fatalf("部分失败应 degraded，得到 %s", e.Availability.Status)
	}
	if e.Review["sourceAvailable"] {
		t.Fatal("degraded 不得为 sourceAvailable=true")
	}
}

func TestAvailability_NoRequestStorm(t *testing.T) {
	repo := memory.New()
	store := &stubStore{sizes: map[string]int64{}}
	for i := 0; i < 500; i++ {
		sha := publish(t, repo, fmt.Sprintf("tool-%03d", i), fmt.Sprintf("seed%d", i), 10)
		store.sizes[storage.PublishedKey(sha)] = 10
	}

	c := availability.Defaults(repo, store, "com.test.src")
	c.MaxPerSweep = 100
	now := time.Now().UTC()

	// 每轮最多 100 次 Head
	n, err := c.Sweep(context.Background(), now)
	if err != nil || n != 100 || store.heads != 100 {
		t.Fatalf("单轮应检查 100 个（限额），实际 n=%d heads=%d err=%v", n, store.heads, err)
	}

	// 新鲜结果在 RecheckAfter 窗口内跳过：立即再扫，探测下一批而不是重复
	n2, _ := c.Sweep(context.Background(), now.Add(time.Second))
	if n2 != 100 || store.heads != 200 {
		t.Fatalf("第二轮应检查下一批 100 个，实际 n=%d heads=%d", n2, store.heads)
	}

	// 全部检查完且都新鲜后：不再产生任何请求
	for i := 0; i < 3; i++ {
		_, _ = c.Sweep(context.Background(), now.Add(2*time.Second))
	}
	if store.heads > 500 {
		t.Fatalf("新鲜结果不应重复探测，heads=%d", store.heads)
	}
}

func TestAvailability_ErrorCategoryNeverLeaksPath(t *testing.T) {
	repo := memory.New()
	store := &stubStore{sizes: map[string]int64{}}
	sha := publish(t, repo, "tool-leak", "leak", 100)

	c := newChecker(repo, store)
	_, _ = c.Sweep(context.Background(), time.Now().UTC())
	rec, _ := repo.Availability().Get(context.Background(), sha)
	if strings.Contains(rec.ErrorCategory, "\\") || strings.Contains(rec.ErrorCategory, "/") {
		t.Fatalf("错误类别泄漏路径: %s", rec.ErrorCategory)
	}
}
