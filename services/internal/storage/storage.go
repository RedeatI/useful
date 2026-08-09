// Package storage 定义对象存储接口与内容寻址键。
// 上传先进 staging（隔离区），审核发布后 CopyToPublished 到不可变区。
// 上传/下载全程流式，不把完整制品载入内存。
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"
)

// ErrObjectConflict means an immutable/versioned key already exists with
// different bytes. Callers must allocate a fresh key; overwriting is forbidden.
var ErrObjectConflict = errors.New("immutable object key contains different bytes")

// ObjectInfo 元信息。
type ObjectInfo struct {
	Size int64
}

// Storage 对象存储接口（FilesystemStorage / S3Storage 实现）。
type Storage interface {
	// Put 流式写入对象（staging 或 published 键）。
	Put(ctx context.Context, key string, r io.Reader, size int64) error
	// PutIfAbsentOrSame atomically creates an immutable/versioned object. An
	// existing byte-identical object is idempotent; different bytes return
	// ErrObjectConflict and are never overwritten.
	PutIfAbsentOrSame(ctx context.Context, key string, r io.Reader, size int64) error
	// Get 流式读取对象。调用方负责 Close。
	Get(ctx context.Context, key string) (io.ReadCloser, ObjectInfo, error)
	// Head 查询对象元信息。
	Head(ctx context.Context, key string) (ObjectInfo, error)
	// DeleteStaging 删除 staging 对象（拒绝删除 published 键）。
	DeleteStaging(ctx context.Context, key string) error
	// CopyToPublished 把 staging 对象复制到已发布内容寻址键（不可变）。
	CopyToPublished(ctx context.Context, stagingKey, publishedKey string) error
	// CreateDownloadURL 生成短期下载 URL（绑定对象，不作为身份）。
	CreateDownloadURL(ctx context.Context, key string, expiry time.Duration) (string, error)
	// SupportsRange 是否支持 HTTP Range。
	SupportsRange() bool
}

// PublishedKey 内容寻址：artifacts/sha256/ab/cd/<full-sha256>。
func PublishedKey(sha256 string) string {
	return fmt.Sprintf("artifacts/sha256/%s/%s/%s", sha256[:2], sha256[2:4], sha256)
}

// StagingKey 上传会话的隔离区键。
func StagingKey(sessionID string) string {
	return fmt.Sprintf("staging/%s", sessionID)
}

// IsStagingKey 判定键属于 staging 区。
func IsStagingKey(key string) bool {
	return len(key) > 8 && key[:8] == "staging/"
}
