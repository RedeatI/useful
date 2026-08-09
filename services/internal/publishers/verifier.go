// Package publishers 的发布者签名验证接口（Ed25519 与 Sigstore 身份签名并存）。
//
// 发布者签名与软件源 TUF 签名完全分离：TUF 保证"这个源确实发布了这个字节"，
// 发布者签名/Sigstore 身份保证"这个制品确实由某发布者身份产出"。二者都通过
// 才构成完整信任，UI 分别展示，绝不合并成单一 safe 布尔。
package publishers

import "context"

// PublisherSignatureResult 验证结果（供 catalog 独立状态字段与审计）。
type PublisherSignatureResult struct {
	Verified bool
	// 验证方式：ed25519 | sigstore
	Method string
	// Sigstore 专属：解析出的身份（供 UI 展示与审计）
	Issuer  string
	Subject string
	// 是否经过透明日志证明（在线/离线差异需明确）
	TransparencyLogVerified bool
	// 失败时的可解释原因（不含敏感证书细节）
	FailureReason string
}

// PublisherSignatureVerifier 统一验证接口。默认 fail closed。
type PublisherSignatureVerifier interface {
	// VerifyEd25519 验证 Ed25519 发布者签名覆盖 (toolID, version, sha256)。
	VerifyEd25519(ctx context.Context, publisherKeyID, toolID, version, sha256, sigHex string) PublisherSignatureResult
	// VerifySigstoreBundle 验证 Sigstore bundle 并将身份绑定到指定 publisher 策略。
	VerifySigstoreBundle(ctx context.Context, policy IdentityPolicy, artifactSHA256 string, bundleJSON []byte) PublisherSignatureResult
}
