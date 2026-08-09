// DefaultVerifier 组合 Ed25519 与 Sigstore 验证，实现 PublisherSignatureVerifier。
package publishers

import "context"

type DefaultVerifier struct {
	Sigstore *SigstoreVerifier // 为 nil 时 Sigstore 验证 fail closed
}

func (d *DefaultVerifier) VerifyEd25519(_ context.Context, publisherKeyID, toolID, version, sha256, sigHex string) PublisherSignatureResult {
	if err := VerifyPublisherSignature(publisherKeyID, toolID, version, sha256, sigHex); err != nil {
		return PublisherSignatureResult{Verified: false, Method: "ed25519", FailureReason: err.Error()}
	}
	return PublisherSignatureResult{Verified: true, Method: "ed25519"}
}

func (d *DefaultVerifier) VerifySigstoreBundle(_ context.Context, policy IdentityPolicy, artifactSHA256 string, bundleJSON []byte) PublisherSignatureResult {
	if d.Sigstore == nil {
		return fail("未启用 Sigstore 验证（fail closed）")
	}
	return d.Sigstore.Verify(policy, artifactSHA256, bundleJSON)
}
