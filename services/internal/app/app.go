// Package app 装配 server/worker 共享的依赖（配置→仓库→存储→服务）。
package app

import (
	"context"
	"crypto/rand"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"useful.dev/source/internal/auth"
	"useful.dev/source/internal/billing"
	"useful.dev/source/internal/catalog"
	"useful.dev/source/internal/config"
	"useful.dev/source/internal/downloads"
	"useful.dev/source/internal/metrics"
	"useful.dev/source/internal/publishers"
	"useful.dev/source/internal/repository"
	"useful.dev/source/internal/repository/memory"
	"useful.dev/source/internal/repository/postgres"
	"useful.dev/source/internal/storage"
	"useful.dev/source/internal/storage/fsstore"
	"useful.dev/source/internal/tufmeta"
)

type App struct {
	Cfg       *config.Config
	Log       *slog.Logger
	Repo      repository.Repository
	Store     storage.Storage
	Catalog   *catalog.Service
	Publisher *publishers.Service
	Grants    *downloads.Service
	Billing   billing.BillingProvider
	Webhooks  *billing.Processor
	OAuth     *auth.Server
	Signer    *auth.Signer
	Metrics   *metrics.Registry
}

// Build 装配全部依赖。migrationsDir 非空时（postgres）自动应用迁移。
func Build(ctx context.Context, cfg *config.Config, migrationsDir string) (*App, error) {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// 仓库
	var repo repository.Repository
	if cfg.DatabaseURL != "" {
		pg, err := postgres.Open(ctx, cfg.DatabaseURL, migrationsDir)
		if err != nil {
			return nil, fmt.Errorf("连接 PostgreSQL 失败: %w", err)
		}
		repo = pg
	} else {
		if cfg.Environment == config.EnvProduction {
			return nil, fmt.Errorf("生产环境必须使用 PostgreSQL")
		}
		log.Warn("未配置 DATABASE_URL，使用内存仓库（仅开发）")
		repo = memory.New()
	}

	// 存储（S3 adapter 在 s3store 包；首版 compose 默认 filesystem）
	secret := []byte(cfg.DownloadTokenSecret)
	if len(secret) == 0 {
		var buf [32]byte
		_, _ = rand.Read(buf[:])
		secret = buf[:]
		log.Warn("未配置 DOWNLOAD_TOKEN_SECRET，已生成随机秘钥（重启后旧下载 URL 失效；仅开发）")
	}
	var store storage.Storage
	switch cfg.StorageDriver {
	case "filesystem":
		fs, err := fsstore.New(cfg.StoragePath, secret)
		if err != nil {
			return nil, err
		}
		store = fs
	default:
		return nil, fmt.Errorf("storage driver %q 尚未在此部署形态启用", cfg.StorageDriver)
	}

	// TUF 在线密钥（开发文件密钥；生产接 KMS signer）
	if cfg.Environment == config.EnvDevelopment {
		log.Warn("使用开发文件密钥签署 TUF metadata（keys 目录），生产环境请使用 KMS")
	}
	tk, err := tufmeta.LoadOrCreateFileKey(cfg.TUFKeysDir, "targets")
	if err != nil {
		return nil, err
	}
	sk, err := tufmeta.LoadOrCreateFileKey(cfg.TUFKeysDir, "snapshot")
	if err != nil {
		return nil, err
	}
	tsk, err := tufmeta.LoadOrCreateFileKey(cfg.TUFKeysDir, "timestamp")
	if err != nil {
		return nil, err
	}

	cat := &catalog.Service{Repo: repo, SourceID: cfg.SourceID}
	// 发布者签名验证器：Ed25519 + 可选 Sigstore。
	// Sigstore 信任根未配置时 Sigstore 验证 fail closed（Ed25519 不受影响）。
	var sigstore *publishers.SigstoreVerifier
	if cfg.SigstoreTrustDir != "" {
		tr, err := publishers.LoadTrustRoot(cfg.SigstoreTrustDir)
		if err != nil {
			return nil, fmt.Errorf("加载 Sigstore 信任根失败: %w", err)
		}
		sigstore = &publishers.SigstoreVerifier{Trust: tr, RequireTransparencyLog: true}
		log.Info("已加载 Sigstore 信任根（在线透明日志验证）", "dir", cfg.SigstoreTrustDir)
	}
	pub := &publishers.Service{
		Repo: repo, Store: store, Catalog: cat,
		TargetsKey: tk, SnapshotKey: sk, TimestampKey: tsk,
		TargetsExpireDays: 90, SnapshotExpireDays: 14, TimestampExpireDays: 2,
		AutoApprove: cfg.AutoApprove, MaxUpload: cfg.MaxUploadSize,
		Verifier: &publishers.DefaultVerifier{Sigstore: sigstore},
	}
	grants := &downloads.Service{
		Repo: repo, Store: store,
		TTL: time.Duration(cfg.DownloadGrantTTLSeconds) * time.Second,
	}

	var bp billing.BillingProvider
	switch cfg.BillingProvider {
	case "fake":
		bp = &billing.Fake{Secret: []byte("fake-webhook-secret-dev")}
	default:
		bp = billing.Disabled{}
	}

	// OAuth 签名秘钥（源专属）：未配置时开发环境随机生成
	oauthSecret := []byte(cfg.OAuthSigningSecret)
	if len(oauthSecret) == 0 {
		var buf [32]byte
		_, _ = rand.Read(buf[:])
		oauthSecret = buf[:]
		log.Warn("未配置 OAUTH_SIGNING_SECRET，已生成随机秘钥（重启后旧令牌失效；仅开发）")
	}
	signer := auth.NewSigner(oauthSecret, strings.TrimRight(cfg.BaseURL, "/"))
	oauthSrv := auth.NewServer(cfg, signer)

	a := &App{
		Cfg: cfg, Log: log, Repo: repo, Store: store,
		Catalog: cat, Publisher: pub, Grants: grants,
		Billing:  bp,
		Webhooks: &billing.Processor{Repo: repo, Provider: bp},
		OAuth:    oauthSrv,
		Signer:   signer,
		Metrics:  metrics.New(),
	}

	// 开发环境自动初始化 TUF root（生产：root 离线，由运维预置 metadata/1.root.json）
	if err := a.ensureRoot(ctx, tk, sk, tsk); err != nil {
		return nil, err
	}
	if err := a.Publisher.ReconcilePublications(ctx); err != nil {
		return nil, fmt.Errorf("reconcile publisher publication intents: %w", err)
	}
	return a, nil
}

// ensureRoot 若 storage 缺少 1.root.json：
// - 开发环境：生成 root 密钥（保存到 keys 目录并强警告）+ 写入 1.root.json + 初始 metadata。
// - 生产环境：拒绝启动并指引离线初始化。
func (a *App) ensureRoot(ctx context.Context, tk, sk, tsk *tufmeta.Key) error {
	if _, err := a.Store.Head(ctx, "metadata/1.root.json"); err == nil {
		return nil
	}
	if a.Cfg.Environment == config.EnvProduction {
		return fmt.Errorf("缺少 metadata/1.root.json：请用离线 root 密钥生成并上传（root 私钥绝不进服务器）")
	}
	a.Log.Warn("开发环境：自动生成 TUF root（root.pem 存 keys 目录，仅限开发！生产必须离线保管）")
	rootKey, err := tufmeta.LoadOrCreateFileKey(a.Cfg.TUFKeysDir, "root")
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	rootSigned := tufmeta.BuildRoot(1, tufmeta.ExpiresIn(3650, now), map[string][]*tufmeta.Key{
		"root": {rootKey}, "targets": {tk}, "snapshot": {sk}, "timestamp": {tsk},
	}, nil)
	rootBytes, err := tufmeta.Sign(rootSigned, rootKey)
	if err != nil {
		return err
	}
	if err := a.Store.Put(ctx, "metadata/1.root.json", strings.NewReader(string(rootBytes)), int64(len(rootBytes))); err != nil {
		return err
	}
	// 初始空 targets/snapshot/timestamp，让客户端可立即同步
	if err := a.Publisher.PublishMetadata(ctx); err != nil {
		return err
	}
	a.Log.Info("已初始化源 TUF metadata", "sourceId", a.Cfg.SourceID)
	return nil
}
