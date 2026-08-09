package fsstore

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"useful.dev/source/internal/storage"
)

func newFS(t *testing.T) *FilesystemStorage {
	t.Helper()
	fs, err := New(t.TempDir(), []byte("test-secret"))
	if err != nil {
		t.Fatal(err)
	}
	return fs
}

func TestPutGetHeadStream(t *testing.T) {
	fs := newFS(t)
	ctx := context.Background()
	data := strings.Repeat("x", 4096)
	if err := fs.Put(ctx, "staging/s1", strings.NewReader(data), int64(len(data))); err != nil {
		t.Fatal(err)
	}
	info, err := fs.Head(ctx, "staging/s1")
	if err != nil || info.Size != int64(len(data)) {
		t.Fatalf("Head: %v %+v", err, info)
	}
	rc, _, err := fs.Get(ctx, "staging/s1")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	buf := make([]byte, len(data))
	n, _ := rc.Read(buf)
	if n != len(data) {
		t.Fatalf("读取 %d 字节", n)
	}
}

func TestSizeMismatchRejected(t *testing.T) {
	fs := newFS(t)
	err := fs.Put(context.Background(), "staging/s1", strings.NewReader("short"), 100)
	if err == nil {
		t.Fatal("大小不符必须拒绝")
	}
}

func TestDeleteStagingOnly(t *testing.T) {
	fs := newFS(t)
	ctx := context.Background()
	_ = fs.Put(ctx, "staging/s1", strings.NewReader("a"), 1)
	_ = fs.Put(ctx, storage.PublishedKey(strings.Repeat("ab", 32)), strings.NewReader("a"), 1)
	if err := fs.DeleteStaging(ctx, "staging/s1"); err != nil {
		t.Fatal(err)
	}
	if err := fs.DeleteStaging(ctx, storage.PublishedKey(strings.Repeat("ab", 32))); err == nil {
		t.Fatal("published 对象禁止删除")
	}
}

func TestCopyToPublishedImmutable(t *testing.T) {
	fs := newFS(t)
	ctx := context.Background()
	key := storage.PublishedKey(strings.Repeat("cd", 32))
	_ = fs.Put(ctx, "staging/s1", strings.NewReader("v1"), 2)
	if err := fs.CopyToPublished(ctx, "staging/s1", key); err != nil {
		t.Fatal(err)
	}
	// 同 bytes 幂等；不同 bytes 必须显式冲突且不可覆盖。
	_ = fs.Put(ctx, "staging/same", strings.NewReader("v1"), 2)
	if err := fs.CopyToPublished(ctx, "staging/same", key); err != nil {
		t.Fatalf("相同内容应幂等: %v", err)
	}
	_ = fs.Put(ctx, "staging/s2", strings.NewReader("v2"), 2)
	if err := fs.CopyToPublished(ctx, "staging/s2", key); !errors.Is(err, storage.ErrObjectConflict) {
		t.Fatalf("不同内容必须 no-clobber 冲突: %v", err)
	}
	rc, _, _ := fs.Get(ctx, key)
	defer rc.Close()
	buf := make([]byte, 2)
	_, _ = rc.Read(buf)
	if string(buf) != "v1" {
		t.Fatalf("published 对象被覆盖: %s", buf)
	}
	// staging → staging / published → staging 均拒绝
	if err := fs.CopyToPublished(ctx, key, "staging/s3"); err == nil {
		t.Fatal("published→staging 必须拒绝")
	}
}

func TestDownloadTokenLifecycle(t *testing.T) {
	fs := newFS(t)
	ctx := context.Background()
	key := storage.PublishedKey(strings.Repeat("ef", 32))
	_ = fs.Put(ctx, key, strings.NewReader("data"), 4)

	url, err := fs.CreateDownloadURL(ctx, key, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimPrefix(url, "/v1/blobs/")
	got, err := fs.ResolveToken(token, time.Now())
	if err != nil || got != key {
		t.Fatalf("令牌解析失败: %v %s", err, got)
	}
	// 过期
	if _, err := fs.ResolveToken(token, time.Now().Add(2*time.Minute)); err == nil {
		t.Fatal("过期令牌必须拒绝")
	}
	// 伪造（换一个 secret 的签名）
	other, _ := New(t.TempDir(), []byte("other-secret"))
	forged, _ := other.CreateDownloadURL(ctx, key, time.Minute)
	if _, err := fs.ResolveToken(strings.TrimPrefix(forged, "/v1/blobs/"), time.Now()); err == nil {
		t.Fatal("伪造令牌必须拒绝")
	}
}

func TestPathTraversalRejected(t *testing.T) {
	fs := newFS(t)
	for _, key := range []string{"../evil", "/abs", `a\b`, "staging/../../x"} {
		if _, err := fs.Head(context.Background(), key); err == nil {
			t.Fatalf("路径穿越键必须拒绝: %q", key)
		}
	}
}
