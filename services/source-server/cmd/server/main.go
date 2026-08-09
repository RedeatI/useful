// source-server：TRP v1 动态软件源后端（模块化单体，与 source-worker 共享 domain/repository）。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"time"

	"useful.dev/source/internal/app"
	authpkg "useful.dev/source/internal/auth"
	"useful.dev/source/internal/availability"
	"useful.dev/source/internal/config"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/httpapi"
)

func main() {
	initAdmin := flag.Bool("init-admin", false, "创建 instance-admin 身份并签发首个 API Token（明文只打印一次）后退出")
	initAdminID := flag.String("init-admin-id", "instance-admin", "-init-admin 创建的身份 ID")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		panic("配置错误: " + err.Error())
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	migrations := os.Getenv("MIGRATIONS_DIR")
	if migrations == "" {
		migrations = "./migrations"
	}
	a, err := app.Build(ctx, cfg, migrations)
	if err != nil {
		panic("装配失败: " + err.Error())
	}

	if *initAdmin {
		if err := runInitAdmin(ctx, a, *initAdminID); err != nil {
			fmt.Fprintln(os.Stderr, "init-admin 失败: "+err.Error())
			os.Exit(1)
		}
		return
	}

	if cfg.EmergencyAdminActive(time.Now()) {
		a.Log.Warn("⚠⚠⚠ 紧急恢复模式已启用：X-Admin-Token 临时有效，仅限身份/令牌管理，到期自动失效 ⚠⚠⚠",
			"until", cfg.EmergencyAdminUntil.Format(time.RFC3339))
	}

	// 内存仓库（无 DATABASE_URL）时无法跨进程共享队列：内嵌 worker 循环（仅开发）
	if cfg.DatabaseURL == "" {
		go inProcessWorker(ctx, a)
		go availability.Defaults(a.Repo, a.Store, cfg.SourceID).Run(ctx, time.Minute)
	}

	srv := &httpapi.Server{
		Cfg: cfg, Repo: a.Repo, Store: a.Store,
		Catalog: a.Catalog, Publisher: a.Publisher, Grants: a.Grants,
		Billing: a.Billing, WebhookProcessor: a.Webhooks,
		OAuth: a.OAuth, Signer: a.Signer, Metrics: a.Metrics, Log: a.Log,
	}
	hs := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
		// 上传走流式，写超时放宽；单请求仍受 MaxUploadSize 限制
		ReadTimeout:  10 * time.Minute,
		WriteTimeout: 10 * time.Minute,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = hs.Shutdown(shutdownCtx)
	}()
	a.Log.Info("source-server 启动", "addr", cfg.HTTPAddr, "billing", cfg.BillingProvider,
		"storage", cfg.StorageDriver, "env", string(cfg.Environment))
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		panic(err)
	}
}

// runInitAdmin 幂等创建 instance-admin 身份并签发 API Token。
// 明文只写 stdout 一次，绝不写日志/数据库。
func runInitAdmin(ctx context.Context, a *app.App, id string) error {
	identity := &domain.Identity{
		ID: id, DisplayName: "Instance Admin", Kind: "user",
		Roles: []domain.Role{domain.RoleInstanceAdmin}, CreatedAt: time.Now().UTC(),
	}
	if err := a.Repo.Identities().CreateIdentity(ctx, identity); err != nil {
		if !errors.Is(err, domain.ErrConflict) {
			return err
		}
		fmt.Println("身份已存在，为其签发新 token: " + id)
	}
	plaintext, hash, err := authpkg.NewAPIToken()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	tok := &domain.APIToken{
		ID: "tok_init_" + now.Format("20060102150405"), IdentityID: id, TokenHash: hash,
		Scopes: domain.AllScopes(), ExpiresAt: now.Add(90 * 24 * time.Hour), CreatedAt: now,
	}
	if err := a.Repo.Identities().CreateToken(ctx, tok); err != nil {
		return err
	}
	_ = a.Repo.Audit().Append(ctx, &domain.AuditEvent{
		At: now, Actor: "init-admin", Action: "api-token-created",
		Detail: "tokenId=" + tok.ID + " identity=" + id,
	})
	fmt.Println("✓ 已创建管理员 API Token（只显示这一次，服务端只存哈希）：")
	fmt.Println(plaintext)
	fmt.Println("  身份: " + id + "  过期: " + tok.ExpiresAt.Format(time.RFC3339))
	return nil
}

// inProcessWorker 开发模式（内存仓库）的内嵌扫描循环；生产部署用独立 source-worker。
func inProcessWorker(ctx context.Context, a *app.App) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for {
				job, err := a.Repo.Jobs().ClaimNext(ctx, []string{"scan-artifact"})
				if errors.Is(err, domain.ErrNotFound) || err != nil {
					break
				}
				var payload struct {
					ArtifactID string `json:"artifactId"`
				}
				if json.Unmarshal([]byte(job.Payload), &payload) != nil {
					_ = a.Repo.Jobs().Complete(ctx, job.ID, "payload 解析失败")
					continue
				}
				if err := a.Publisher.RunScan(ctx, payload.ArtifactID); err != nil {
					_ = a.Repo.Jobs().Complete(ctx, job.ID, err.Error())
					continue
				}
				_ = a.Repo.Jobs().Complete(ctx, job.ID, "")
			}
		}
	}
}
