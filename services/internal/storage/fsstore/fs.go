// Package fsstore 提供 FilesystemStorage：本地开发用对象存储适配器。
// 流式读写、原子落盘（临时文件+rename）、HMAC 短期下载令牌（由 HTTP 层兑换）。
package fsstore

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"useful.dev/source/internal/storage"
)

type FilesystemStorage struct {
	root   string
	secret []byte
}

func New(root string, tokenSecret []byte) (*FilesystemStorage, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &FilesystemStorage{root: root, secret: tokenSecret}, nil
}

// 键只允许受控字符，防路径穿越；join 后再做根目录包含校验（最终防线）。
func (f *FilesystemStorage) pathOf(key string) (string, error) {
	if strings.Contains(key, "..") || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") {
		return "", fmt.Errorf("非法对象键: %q", key)
	}
	rootAbs, err := filepath.Abs(f.root)
	if err != nil {
		return "", err
	}
	p := filepath.Join(rootAbs, filepath.FromSlash(key))
	pAbs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if pAbs != rootAbs && !strings.HasPrefix(pAbs, rootAbs+string(filepath.Separator)) {
		return "", fmt.Errorf("对象键越界: %q", key)
	}
	return pAbs, nil
}

func (f *FilesystemStorage) Put(_ context.Context, key string, r io.Reader, size int64) error {
	p, err := f.pathOf(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".upload-*")
	if err != nil {
		return err
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()
	n, err := io.Copy(tmp, io.LimitReader(r, size+1))
	if err != nil {
		return err
	}
	if size >= 0 && n != size {
		return fmt.Errorf("写入大小与声明不符: 声明 %d 实际 %d", size, n)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.r.Read(p)
	if err == nil && r.ctx.Err() != nil {
		return n, r.ctx.Err()
	}
	return n, err
}

func (f *FilesystemStorage) PutIfAbsentOrSame(ctx context.Context, key string, r io.Reader, size int64) error {
	if size < 0 {
		return fmt.Errorf("写入大小非法: %d", size)
	}
	p, err := f.pathOf(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".immutable-*")
	if err != nil {
		return err
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	writtenHash := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, writtenHash), io.LimitReader(&contextReader{ctx: ctx, r: r}, size+1))
	if err != nil {
		return err
	}
	if n != size {
		return fmt.Errorf("写入大小与声明不符: 声明 %d 实际 %d", size, n)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// A hard link publishes the fully written temporary inode with O_EXCL-like
	// cross-process semantics. It never replaces an existing path.
	if err := os.Link(tmp.Name(), p); err == nil {
		return nil
	} else if !os.IsExist(err) {
		return err
	}

	existing, err := os.Open(p)
	if err != nil {
		return err
	}
	defer existing.Close()
	st, err := existing.Stat()
	if err != nil {
		return err
	}
	if st.Size() != size {
		return storage.ErrObjectConflict
	}
	existingHash := sha256.New()
	if _, err := io.Copy(existingHash, &contextReader{ctx: ctx, r: existing}); err != nil {
		return err
	}
	if !hmac.Equal(existingHash.Sum(nil), writtenHash.Sum(nil)) {
		return storage.ErrObjectConflict
	}
	return nil
}

func (f *FilesystemStorage) Get(_ context.Context, key string) (io.ReadCloser, storage.ObjectInfo, error) {
	p, err := f.pathOf(key)
	if err != nil {
		return nil, storage.ObjectInfo{}, err
	}
	fh, err := os.Open(p)
	if err != nil {
		return nil, storage.ObjectInfo{}, err
	}
	st, err := fh.Stat()
	if err != nil {
		fh.Close()
		return nil, storage.ObjectInfo{}, err
	}
	return fh, storage.ObjectInfo{Size: st.Size()}, nil
}

func (f *FilesystemStorage) Head(_ context.Context, key string) (storage.ObjectInfo, error) {
	p, err := f.pathOf(key)
	if err != nil {
		return storage.ObjectInfo{}, err
	}
	st, err := os.Stat(p)
	if err != nil {
		return storage.ObjectInfo{}, err
	}
	return storage.ObjectInfo{Size: st.Size()}, nil
}

func (f *FilesystemStorage) DeleteStaging(_ context.Context, key string) error {
	if !storage.IsStagingKey(key) {
		return fmt.Errorf("只允许删除 staging 对象: %q", key)
	}
	p, err := f.pathOf(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (f *FilesystemStorage) CopyToPublished(ctx context.Context, stagingKey, publishedKey string) error {
	if !storage.IsStagingKey(stagingKey) {
		return fmt.Errorf("来源必须是 staging 键")
	}
	if storage.IsStagingKey(publishedKey) {
		return fmt.Errorf("目标必须是 published 键")
	}
	src, info, err := f.Get(ctx, stagingKey)
	if err != nil {
		return err
	}
	defer src.Close()
	return f.PutIfAbsentOrSame(ctx, publishedKey, src, info.Size)
}

// blobToken 短期下载令牌载荷。
type blobToken struct {
	Key     string `json:"k"`
	Expires int64  `json:"e"`
}

// CreateDownloadURL 生成 /v1/blobs/<token> 相对 URL；由 HTTP 层校验并流式返回。
func (f *FilesystemStorage) CreateDownloadURL(_ context.Context, key string, expiry time.Duration) (string, error) {
	if _, err := f.pathOf(key); err != nil {
		return "", err
	}
	payload, err := json.Marshal(blobToken{Key: key, Expires: time.Now().Add(expiry).Unix()})
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, f.secret)
	mac.Write(payload)
	token := base64.RawURLEncoding.EncodeToString(payload) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return "/v1/blobs/" + token, nil
}

// ResolveToken 校验令牌并返回对象键（过期/伪造返回错误）。
func (f *FilesystemStorage) ResolveToken(token string, now time.Time) (string, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return "", fmt.Errorf("令牌格式非法")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("令牌格式非法")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("令牌格式非法")
	}
	mac := hmac.New(sha256.New, f.secret)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return "", fmt.Errorf("令牌签名无效")
	}
	var t blobToken
	if err := json.Unmarshal(payload, &t); err != nil {
		return "", fmt.Errorf("令牌格式非法")
	}
	if now.Unix() >= t.Expires {
		return "", fmt.Errorf("令牌已过期")
	}
	return t.Key, nil
}

// PathOf 暴露给 HTTP 层做 http.ServeContent（Range 支持）。
func (f *FilesystemStorage) PathOf(key string) (string, error) { return f.pathOf(key) }

func (f *FilesystemStorage) SupportsRange() bool { return true }
