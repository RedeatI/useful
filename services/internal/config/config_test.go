package config

import "testing"

func base() *Config {
	return &Config{
		Environment: EnvDevelopment, HTTPAddr: ":0",
		SourceID: "com.example.s", SourceName: "S", SourceOperator: "Op",
		BaseURL: "http://127.0.0.1:8080", StorageDriver: "filesystem",
		StoragePath: ".", BillingProvider: "disabled", TUFKeysDir: ".",
		MaxUploadSize: 1 << 20, MaxRequestBody: 1 << 20, DownloadGrantTTLSeconds: 60,
	}
}

func TestFakeBillingRejectedInProduction(t *testing.T) {
	c := base()
	c.Environment = EnvProduction
	c.BillingProvider = "fake"
	c.DatabaseURL = "postgres://x"
	c.DownloadTokenSecret = "secret"
	c.BaseURL = "https://source.example"
	if err := c.Validate(); err == nil {
		t.Fatal("生产环境 fake 支付必须被拒绝")
	}
}

func TestProductionRequiresSecrets(t *testing.T) {
	c := base()
	c.Environment = EnvProduction
	c.DatabaseURL = "postgres://x"
	c.BaseURL = "https://source.example"
	if err := c.Validate(); err == nil {
		t.Fatal("生产环境缺少 DOWNLOAD_TOKEN_SECRET 必须被拒绝")
	}
	c.DownloadTokenSecret = "s"
	c.BaseURL = "http://source.example"
	if err := c.Validate(); err == nil {
		t.Fatal("生产环境非 HTTPS BaseURL 必须被拒绝")
	}
}

func TestProductionRejectsAutoApprove(t *testing.T) {
	c := base()
	c.Environment = EnvProduction
	c.DatabaseURL = "postgres://x"
	c.DownloadTokenSecret = "s"
	c.BaseURL = "https://source.example"
	c.AutoApprove = true
	if err := c.Validate(); err == nil {
		t.Fatal("生产环境 AUTO_APPROVE 必须被拒绝")
	}
}

func TestDevelopmentDefaultsValid(t *testing.T) {
	if err := base().Validate(); err != nil {
		t.Fatalf("开发默认配置应有效: %v", err)
	}
}
