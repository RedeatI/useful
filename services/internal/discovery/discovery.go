// Package discovery 生成 /.well-known/useful-repository.json。
// discovery 不构成信任根；source.id 不构成官方身份。
package discovery

import (
	"strings"

	"useful.dev/source/internal/config"
)

// Build 组装 discovery 文档。rootSHA256 为 metadata/1.root.json 的摘要。
func Build(cfg *config.Config, rootSHA256 string) map[string]any {
	base := strings.TrimRight(cfg.BaseURL, "/")
	authEnabled := cfg.BillingProvider != "disabled"
	caps := map[string]any{
		"catalog":         true,
		"remoteSearch":    true,
		"authentication":  authEnabled,
		"entitlements":    authEnabled,
		"paidDownloads":   authEnabled,
		"publisherPortal": true,
		"privateTools":    false,
		"staticMirror":    false,
		"nativeWorkers":   false,
	}
	doc := map[string]any{
		"schemaVersion": "1.0",
		"source": map[string]any{
			"id":       cfg.SourceID,
			"name":     cfg.SourceName,
			"operator": cfg.SourceOperator,
		},
		"repository": map[string]any{
			"profile":         "tuf-v1",
			"metadataBaseUrl": base + "/metadata/",
			"targetsBaseUrl":  base + "/targets/",
			"rootUrl":         base + "/metadata/1.root.json",
			"rootSha256":      rootSHA256,
		},
		"api": map[string]any{
			"baseUrl": base + "/v1",
		},
		"capabilities": caps,
	}
	// 仅 authorization-code + PKCE S256；启用认证时公布 OAuth 配置
	if authEnabled {
		doc["auth"] = map[string]any{
			"type":     "oauth2-pkce",
			"issuer":   base,
			"clientId": "useful-desktop",
			"scopes":   []string{"profile", "entitlements", "downloads"},
		}
	}
	return doc
}
