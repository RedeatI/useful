//go:build pgintegration

package postgres

import (
	"context"
	"os"
	"testing"
)

func TestMigrationReplayIsIdempotent(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("未设置 TEST_DATABASE_URL")
	}

	first, err := Open(context.Background(), dsn, "../../../migrations")
	if err != nil {
		t.Fatalf("首次迁移失败: %v", err)
	}
	if err := first.db.Close(); err != nil {
		t.Fatalf("关闭首次数据库连接失败: %v", err)
	}

	second, err := Open(context.Background(), dsn, "../../../migrations")
	if err != nil {
		t.Fatalf("迁移幂等重放失败: %v", err)
	}
	if err := second.db.Close(); err != nil {
		t.Fatalf("关闭重放数据库连接失败: %v", err)
	}
}
