// Package config 从环境变量装载 source-server / source-worker 配置。
// 生产环境启用 fake 支付会在启动时被直接拒绝。
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Environment string

const (
	EnvDevelopment Environment = "development"
	EnvProduction  Environment = "production"
)

type Config struct {
	Environment Environment
	HTTPAddr    string
	// PostgreSQL DSN；为空时（仅开发/测试）使用内存仓库。
	DatabaseURL string

	// 源身份（自报信息，不构成官方身份）
	SourceID       string
	SourceName     string
	SourceOperator string
	// 对外基础地址（discovery 中的 metadata/targets/api 前缀）
	BaseURL string

	// storage: filesystem | s3
	StorageDriver string
	StoragePath   string // filesystem 根目录
	S3Endpoint    string
	S3Region      string
	S3Bucket      string
	S3AccessKey   string
	S3SecretKey   string

	// billing: disabled | fake
	BillingProvider string

	// TUF 在线密钥目录（targets/snapshot/timestamp 的开发文件密钥；
	// root 私钥默认离线，绝不由服务器持有）
	TUFKeysDir string

	// 限额
	MaxUploadSize           int64
	MaxRequestBody          int64
	DownloadGrantTTLSeconds int64
	// 下载令牌 HMAC 秘钥（生产必须显式提供）
	DownloadTokenSecret string
	// 发布者/管理端点令牌（仅限开发模式 bootstrap；生产禁用，除非紧急恢复模式）
	AdminToken string
	// 紧急恢复模式：默认关闭；开启时必须同时提供短期有效期（≤ 24h）。
	// 只允许最小管理能力，启动日志高亮，所有操作写审计。
	EmergencyAdminMode  bool
	EmergencyAdminUntil time.Time
	// OAuth 令牌签名秘钥（源专属；为空时开发环境随机生成，生产必须显式提供）
	OAuthSigningSecret string
	// Sigstore 信任根目录（fulcio-root.pem + rekor.pub；为空时 Sigstore 验证 fail closed）。
	// 生产公共实例密钥属 Owner Gate，由 TUF 分发。
	SigstoreTrustDir string
	// 开发模式：扫描通过后自动审核发布
	AutoApprove bool
}

func getenv(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func getint(key string, def int64) int64 {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

// Load 读取并校验配置。
func Load() (*Config, error) {
	c := &Config{
		Environment:             Environment(getenv("ENVIRONMENT", string(EnvDevelopment))),
		HTTPAddr:                getenv("HTTP_ADDR", ":8080"),
		DatabaseURL:             getenv("DATABASE_URL", ""),
		SourceID:                getenv("SOURCE_ID", "com.example.dev-source"),
		SourceName:              getenv("SOURCE_NAME", "Dev Source"),
		SourceOperator:          getenv("SOURCE_OPERATOR", "Self-hosted"),
		BaseURL:                 getenv("BASE_URL", "http://127.0.0.1:8080"),
		StorageDriver:           getenv("STORAGE_DRIVER", "filesystem"),
		StoragePath:             getenv("STORAGE_PATH", "./data/storage"),
		S3Endpoint:              getenv("S3_ENDPOINT", ""),
		S3Region:                getenv("S3_REGION", "us-east-1"),
		S3Bucket:                getenv("S3_BUCKET", ""),
		S3AccessKey:             getenv("S3_ACCESS_KEY", ""),
		S3SecretKey:             getenv("S3_SECRET_KEY", ""),
		BillingProvider:         getenv("BILLING_PROVIDER", "disabled"),
		TUFKeysDir:              getenv("TUF_KEYS_DIR", "./data/tuf-keys"),
		MaxUploadSize:           getint("MAX_UPLOAD_SIZE", 256<<20),
		MaxRequestBody:          getint("MAX_REQUEST_BODY", 1<<20),
		DownloadGrantTTLSeconds: getint("DOWNLOAD_GRANT_TTL_SECONDS", 600),
		DownloadTokenSecret:     getenv("DOWNLOAD_TOKEN_SECRET", ""),
		AdminToken:              getenv("ADMIN_TOKEN", ""),
		EmergencyAdminMode:      getenv("EMERGENCY_ADMIN_MODE", "false") == "true",
		OAuthSigningSecret:      getenv("OAUTH_SIGNING_SECRET", ""),
		SigstoreTrustDir:        getenv("SIGSTORE_TRUST_DIR", ""),
		AutoApprove:             getenv("AUTO_APPROVE", "false") == "true",
	}
	if v := strings.TrimSpace(os.Getenv("EMERGENCY_ADMIN_UNTIL")); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return nil, fmt.Errorf("EMERGENCY_ADMIN_UNTIL 必须为 RFC3339: %w", err)
		}
		c.EmergencyAdminUntil = t
	}
	return c, c.Validate()
}

// Validate 强制安全边界。
func (c *Config) Validate() error {
	switch c.Environment {
	case EnvDevelopment, EnvProduction:
	default:
		return fmt.Errorf("非法 ENVIRONMENT: %s", c.Environment)
	}
	switch c.BillingProvider {
	case "disabled", "fake":
	default:
		return fmt.Errorf("非法 BILLING_PROVIDER: %s（首版支持 disabled|fake）", c.BillingProvider)
	}
	// 生产环境误启用 fake provider：启动时检测并拒绝
	if c.Environment == EnvProduction && c.BillingProvider == "fake" {
		return fmt.Errorf("生产环境禁止启用 fake 支付 provider")
	}
	switch c.StorageDriver {
	case "filesystem":
	case "s3":
		if c.S3Bucket == "" {
			return fmt.Errorf("STORAGE_DRIVER=s3 需要 S3_BUCKET")
		}
	default:
		return fmt.Errorf("非法 STORAGE_DRIVER: %s", c.StorageDriver)
	}
	if c.Environment == EnvProduction {
		// 静态管理令牌在生产环境拒绝启动，除非显式启用紧急恢复模式
		if c.AdminToken != "" && !c.EmergencyAdminMode {
			return fmt.Errorf("生产环境禁止静态 ADMIN_TOKEN：请使用 API Token（见 -init-admin）；紧急恢复需显式 EMERGENCY_ADMIN_MODE=true")
		}
		if c.DownloadTokenSecret == "" {
			return fmt.Errorf("生产环境必须提供 DOWNLOAD_TOKEN_SECRET")
		}
		if c.AutoApprove {
			return fmt.Errorf("生产环境禁止 AUTO_APPROVE（必须人工审核）")
		}
		if c.BillingProvider != "disabled" && c.OAuthSigningSecret == "" {
			return fmt.Errorf("启用计费的生产环境必须提供 OAUTH_SIGNING_SECRET")
		}
		if c.DatabaseURL == "" {
			return fmt.Errorf("生产环境必须提供 DATABASE_URL")
		}
		if !strings.HasPrefix(c.BaseURL, "https://") {
			return fmt.Errorf("生产环境 BASE_URL 必须为 HTTPS")
		}
	}
	if c.EmergencyAdminMode {
		if c.AdminToken == "" {
			return fmt.Errorf("EMERGENCY_ADMIN_MODE 需要 ADMIN_TOKEN")
		}
		if c.EmergencyAdminUntil.IsZero() {
			return fmt.Errorf("EMERGENCY_ADMIN_MODE 必须提供 EMERGENCY_ADMIN_UNTIL（RFC3339，≤ 24h）")
		}
		if time.Until(c.EmergencyAdminUntil) > 24*time.Hour {
			return fmt.Errorf("EMERGENCY_ADMIN_UNTIL 有效期不得超过 24 小时")
		}
	}
	return nil
}

// EmergencyAdminActive 紧急恢复模式当前是否生效（过期自动失效）。
func (c *Config) EmergencyAdminActive(now time.Time) bool {
	return c.EmergencyAdminMode && c.AdminToken != "" && now.Before(c.EmergencyAdminUntil)
}
