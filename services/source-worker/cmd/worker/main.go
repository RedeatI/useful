// source-worker：扫描/发布任务处理器（与主 API 分离；共享 domain/repository）。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/signal"
	"time"

	"useful.dev/source/internal/app"
	"useful.dev/source/internal/availability"
	"useful.dev/source/internal/config"
	"useful.dev/source/internal/domain"
)

func main() {
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
	a.Log.Info("source-worker 启动", "env", string(cfg.Environment))

	// 制品可用性后台检查（HEAD-only，限额 + 新鲜跳过，见 ADR-012）
	go availability.Defaults(a.Repo, a.Store, cfg.SourceID).Run(ctx, time.Minute)

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			a.Log.Info("source-worker 退出")
			return
		case <-ticker.C:
			for {
				job, err := a.Repo.Jobs().ClaimNext(ctx, []string{"scan-artifact"})
				if errors.Is(err, domain.ErrNotFound) {
					break
				}
				if err != nil {
					a.Log.Error("认领任务失败", "err", err.Error())
					break
				}
				runJob(ctx, a, job)
			}
		}
	}
}

func runJob(ctx context.Context, a *app.App, job *domain.Job) {
	var payload struct {
		ArtifactID string `json:"artifactId"`
	}
	if err := json.Unmarshal([]byte(job.Payload), &payload); err != nil {
		_ = a.Repo.Jobs().Complete(ctx, job.ID, "payload 解析失败")
		return
	}
	if err := a.Publisher.RunScan(ctx, payload.ArtifactID); err != nil {
		a.Log.Error("扫描失败", "job", job.ID, "artifact", payload.ArtifactID, "err", err.Error())
		_ = a.Repo.Jobs().Complete(ctx, job.ID, err.Error())
		return
	}
	a.Log.Info("扫描完成", "job", job.ID, "artifact", payload.ArtifactID)
	_ = a.Repo.Jobs().Complete(ctx, job.ID, "")
}
