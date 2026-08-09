// Sigstore bundle 解析 fuzz：任何畸形 bundle 都不得 panic，且默认 fail closed。
package publishers

import "testing"

func FuzzVerifySigstoreBundle(f *testing.F) {
	seeds := [][]byte{
		[]byte(``),
		[]byte(`{}`),
		[]byte(`{"verificationMaterial":{}}`),
		[]byte(`{"verificationMaterial":{"certificate":{"rawBytes":"!!!notbase64"}}}`),
		[]byte(`{"messageSignature":{"signature":"abc"}}`),
		[]byte(`{"verificationMaterial":{"tlogEntries":[{"integratedTime":"-1"}]}}`),
		[]byte(`{"verificationMaterial":{"certificate":{"rawBytes":"AAAA"}},"messageSignature":{"messageDigest":{"digest":"AAAA"},"signature":"AAAA"}}`),
	}
	for _, s := range seeds {
		f.Add(s)
	}
	// 无信任根时必须 fail closed；有信任根但畸形输入也不得 panic 或误判通过。
	verifierNoTrust := &SigstoreVerifier{}
	policy := IdentityPolicy{PublisherKeyID: "sigstore:x", Issuer: "https://x", SANExact: "a@b"}
	art := "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

	f.Fuzz(func(t *testing.T, bundle []byte) {
		res := verifierNoTrust.Verify(policy, art, bundle)
		if res.Verified {
			t.Fatalf("无信任根竟验证通过（fail closed 失效）: %q", bundle)
		}
	})
}
