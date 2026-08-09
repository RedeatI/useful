// Package downloads 实现下载授权（DownloadGrant）。
// 免费工具直接发放短期 URL；付费工具必须检查所属源权益（不依赖客户端缓存）。
// URL 绑定 artifact digest 但不作为身份；审计不记录完整临时 URL。
package downloads

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/google/uuid"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/publishers"
	"useful.dev/source/internal/repository"
	"useful.dev/source/internal/storage"
)

type Service struct {
	Repo  repository.Repository
	Store storage.Storage
	TTL   time.Duration
	Now   func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

type GrantRequest struct {
	ToolID         string `json:"toolId"`
	PublisherKeyID string `json:"publisherKeyId"`
	Version        string `json:"version"`
	Platform       string `json:"platform"`
	Arch           string `json:"arch"`
	Channel        string `json:"channel"`
	// Phase 8 之前匿名；有权益校验需求时由 auth 层填充
	SubjectID string `json:"-"`
}

// Create 发放下载授权。
func (s *Service) Create(ctx context.Context, req *GrantRequest) (*domain.DownloadGrant, error) {
	if !domain.IsLowercaseID(req.ToolID) || !domain.IsPublisherKey(req.PublisherKeyID) ||
		!domain.IsSemver(req.Version) {
		return nil, fmt.Errorf("%w: 请求字段非法", domain.ErrInvalidInput)
	}
	art, err := s.Repo.Artifacts().GetByIdentity(ctx, req.PublisherKeyID, req.ToolID, req.Version, req.Platform, req.Arch)
	if err != nil {
		return nil, err
	}
	if art.Status != domain.ArtifactPublished {
		// 撤回版本不会被新用户安装
		return nil, fmt.Errorf("%w: 制品不可下载（状态 %s）", domain.ErrForbidden, art.Status)
	}
	if err := publishers.ValidateArtifactPublisherTrust(art); err != nil {
		return nil, err
	}
	if art.Channel != req.Channel {
		return nil, fmt.Errorf("%w: 频道不匹配", domain.ErrInvalidInput)
	}

	tool, err := s.Repo.Tools().Get(ctx, req.PublisherKeyID, req.ToolID)
	if err != nil {
		return nil, err
	}
	now := s.now()
	if tool.AccessMode != "free" {
		// 付费制品：检查所属源权益（客户端本地缓存不作数）
		if req.SubjectID == "" {
			return nil, fmt.Errorf("%w: 需要登录并持有权益", domain.ErrForbidden)
		}
		ents, err := s.Repo.Entitlements().ListBySubject(ctx, req.SubjectID)
		if err != nil {
			return nil, err
		}
		allowed := false
		for _, e := range ents {
			if (e.ToolScope == "*" || e.ToolScope == req.ToolID) &&
				(tool.ProductID == "" || e.ProductID == tool.ProductID) &&
				e.AllowsNewDownload(now) {
				allowed = true
				break
			}
		}
		if !allowed {
			// canceled/expired：已装版本继续运行，但不允许新的付费下载
			return nil, fmt.Errorf("%w: 无有效权益", domain.ErrForbidden)
		}
	}

	url, err := s.Store.CreateDownloadURL(ctx, storage.PublishedKey(art.SHA256), s.TTL)
	if err != nil {
		return nil, err
	}
	grant := &domain.DownloadGrant{
		ID:             "dg_" + uuid.NewString(),
		SubjectID:      req.SubjectID,
		ArtifactID:     art.ID,
		ArtifactSHA256: art.SHA256,
		Size:           art.Size,
		DownloadURL:    url,
		ExpiresAt:      now.Add(s.TTL),
		SupportsRange:  s.Store.SupportsRange(),
		CreatedAt:      now,
	}
	if err := s.Repo.Grants().Create(ctx, grant); err != nil {
		return nil, err
	}
	// 审计：只记 URL 摘要，不记完整临时 URL
	urlDigest := sha256.Sum256([]byte(url))
	_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
		At: now, Actor: orAnonymous(req.SubjectID), Action: "download.grant",
		Detail: fmt.Sprintf("%s@%s url_sha256=%s", req.ToolID, req.Version, hex.EncodeToString(urlDigest[:8])),
	})
	return grant, nil
}

// Get 查询授权（过期后返回 ErrNotFound 语义之外的明确状态由 HTTP 层表达）。
func (s *Service) Get(ctx context.Context, id string) (*domain.DownloadGrant, error) {
	return s.Repo.Grants().Get(ctx, id)
}

func orAnonymous(s string) string {
	if s == "" {
		return "anonymous"
	}
	return s
}
