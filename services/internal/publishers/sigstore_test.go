// Sigstore 验证测试：真实 X.509 链 + Ed25519 签名 + Rekor SET 透明日志证明。
// 正向 + 负向（身份冒充/错误 issuer/错误 digest/过期证书/日志证明缺失/无信任根）。
package publishers

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/url"
	"testing"
	"time"
)

// testPKI 生成一次性 Fulcio 风格 CA、叶证书、Rekor 密钥（全部离线，标 NOT-FOR-PRODUCTION）。
type testPKI struct {
	fulcioRoots *x509.CertPool
	rekorPriv   ed25519.PrivateKey
	rekorPub    ed25519.PublicKey
	caCert      *x509.Certificate
	caPriv      *ecdsa.PrivateKey
}

func newTestPKI(t *testing.T) *testPKI {
	t.Helper()
	caPriv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "NOT-FOR-PRODUCTION Test Fulcio CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caPriv.PublicKey, caPriv)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)
	roots := x509.NewCertPool()
	roots.AddCert(caCert)

	rekorPub, rekorPriv, _ := ed25519.GenerateKey(rand.Reader)
	return &testPKI{fulcioRoots: roots, rekorPriv: rekorPriv, rekorPub: rekorPub, caCert: caCert, caPriv: caPriv}
}

// issueLeaf 签发带 issuer 扩展与 SAN 的叶证书（Ed25519 签名密钥）。
func (p *testPKI) issueLeaf(t *testing.T, issuer, sanEmail, sanURI string, notBefore, notAfter time.Time) (ed25519.PrivateKey, []byte) {
	t.Helper()
	leafPub, leafPriv, _ := ed25519.GenerateKey(rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "sigstore-leaf"},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
	}
	if issuer != "" {
		tmpl.ExtraExtensions = append(tmpl.ExtraExtensions, pkix.Extension{
			Id: oidFulcioIssuerV1, Value: []byte(issuer),
		})
	}
	if sanEmail != "" {
		tmpl.EmailAddresses = []string{sanEmail}
	}
	if sanURI != "" {
		u, _ := url.Parse(sanURI)
		tmpl.URIs = []*url.URL{u}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.caCert, leafPub, p.caPriv)
	if err != nil {
		t.Fatal(err)
	}
	return leafPriv, der
}

// makeBundle 用叶私钥对 artifact 摘要签名，并用 Rekor 密钥签 SET。
func (p *testPKI) makeBundle(t *testing.T, leafPriv ed25519.PrivateKey, certDER []byte, artifactSHA256 string, integrated int64, withSET bool) []byte {
	t.Helper()
	digest, _ := hex.DecodeString(artifactSHA256)
	sig := ed25519.Sign(leafPriv, digest)

	var b sigstoreBundle
	b.MediaType = "application/vnd.dev.sigstore.bundle+json;version=0.3"
	b.VerificationMaterial.Certificate.RawBytes = base64.StdEncoding.EncodeToString(certDER)
	b.MessageSignature.MessageDigest.Algorithm = "SHA2_256"
	b.MessageSignature.MessageDigest.Digest = base64.StdEncoding.EncodeToString(digest)
	b.MessageSignature.Signature = base64.StdEncoding.EncodeToString(sig)

	logIndex := "12345"
	entry := struct {
		LogIndex         string `json:"logIndex"`
		IntegratedTime   string `json:"integratedTime"`
		InclusionPromise struct {
			SignedEntryTimestamp string `json:"signedEntryTimestamp"`
		} `json:"inclusionPromise"`
	}{LogIndex: logIndex, IntegratedTime: itoa(integrated)}
	if withSET {
		set := ed25519.Sign(p.rekorPriv, SETPayload(logIndex, integrated, digest, certDER))
		entry.InclusionPromise.SignedEntryTimestamp = base64.StdEncoding.EncodeToString(set)
	}
	b.VerificationMaterial.TlogEntries = append(b.VerificationMaterial.TlogEntries, entry)

	raw, _ := json.Marshal(b)
	return raw
}

func itoa(n int64) string {
	return big.NewInt(n).String()
}

func sha256Of(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

const (
	testIssuer = "https://accounts.google.com"
	testSAN    = "release-bot@useful.example"
)

func trustFor(p *testPKI, requireTlog bool) *SigstoreVerifier {
	return &SigstoreVerifier{
		Trust:                  &TrustRoot{FulcioRoots: p.fulcioRoots, RekorPublicKey: p.rekorPub},
		RequireTransparencyLog: requireTlog,
	}
}

func exactPolicy() IdentityPolicy {
	return IdentityPolicy{PublisherKeyID: "sigstore:release-bot", Issuer: testIssuer, SANExact: testSAN}
}

func TestSigstore_ValidBundle(t *testing.T) {
	p := newTestPKI(t)
	art := sha256Of("artifact-bytes")
	now := time.Now().Unix()
	leafPriv, certDER := p.issueLeaf(t, testIssuer, testSAN, "",
		time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	bundle := p.makeBundle(t, leafPriv, certDER, art, now, true)

	res := trustFor(p, true).Verify(exactPolicy(), art, bundle)
	if !res.Verified {
		t.Fatalf("有效 bundle 应通过，失败原因: %s", res.FailureReason)
	}
	if res.Issuer != testIssuer || res.Subject != testSAN {
		t.Fatalf("身份解析错误: %s / %s", res.Issuer, res.Subject)
	}
	if !res.TransparencyLogVerified {
		t.Fatal("应验证透明日志证明")
	}
}

func TestSigstore_IdentityImpersonation(t *testing.T) {
	p := newTestPKI(t)
	art := sha256Of("artifact-bytes")
	now := time.Now().Unix()
	// 攻击者用合法 CA 签发的证书，但 SAN 是别人
	leafPriv, certDER := p.issueLeaf(t, testIssuer, "attacker@evil.example", "",
		time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	bundle := p.makeBundle(t, leafPriv, certDER, art, now, true)

	res := trustFor(p, true).Verify(exactPolicy(), art, bundle)
	if res.Verified {
		t.Fatal("身份冒充必须被拒绝")
	}
}

func TestSigstore_WrongIssuer(t *testing.T) {
	p := newTestPKI(t)
	art := sha256Of("artifact-bytes")
	now := time.Now().Unix()
	leafPriv, certDER := p.issueLeaf(t, "https://evil-issuer.example", testSAN, "",
		time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	bundle := p.makeBundle(t, leafPriv, certDER, art, now, true)

	res := trustFor(p, true).Verify(exactPolicy(), art, bundle)
	if res.Verified {
		t.Fatal("错误 issuer 必须被拒绝")
	}
}

func TestSigstore_WrongDigestNotBound(t *testing.T) {
	p := newTestPKI(t)
	art := sha256Of("artifact-bytes")
	other := sha256Of("different-artifact")
	now := time.Now().Unix()
	leafPriv, certDER := p.issueLeaf(t, testIssuer, testSAN, "",
		time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	// bundle 对 other 摘要签名，但校验针对 art
	bundle := p.makeBundle(t, leafPriv, certDER, other, now, true)

	res := trustFor(p, true).Verify(exactPolicy(), art, bundle)
	if res.Verified {
		t.Fatal("摘要不绑定必须被拒绝")
	}
}

func TestSigstore_ExpiredCertificate(t *testing.T) {
	p := newTestPKI(t)
	art := sha256Of("artifact-bytes")
	// 证书有效期在过去；签名时间也在过去但晚于证书失效
	certNotAfter := time.Now().Add(-2 * time.Hour)
	signTime := time.Now().Add(-time.Hour).Unix() // 晚于 certNotAfter
	leafPriv, certDER := p.issueLeaf(t, testIssuer, testSAN, "",
		time.Now().Add(-3*time.Hour), certNotAfter)
	bundle := p.makeBundle(t, leafPriv, certDER, art, signTime, true)

	res := trustFor(p, true).Verify(exactPolicy(), art, bundle)
	if res.Verified {
		t.Fatal("签名时间不在证书有效期内必须被拒绝")
	}
}

func TestSigstore_UntrustedCA(t *testing.T) {
	p := newTestPKI(t)
	rogue := newTestPKI(t) // 另一套 CA
	art := sha256Of("artifact-bytes")
	now := time.Now().Unix()
	leafPriv, certDER := rogue.issueLeaf(t, testIssuer, testSAN, "",
		time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	bundle := rogue.makeBundle(t, leafPriv, certDER, art, now, true)

	// 用 p 的信任根验证 rogue 签发的证书 → 链验证失败
	res := trustFor(p, true).Verify(exactPolicy(), art, bundle)
	if res.Verified {
		t.Fatal("非受信 CA 签发的证书必须被拒绝")
	}
}

func TestSigstore_MissingTransparencyLog(t *testing.T) {
	p := newTestPKI(t)
	art := sha256Of("artifact-bytes")
	now := time.Now().Unix()
	leafPriv, certDER := p.issueLeaf(t, testIssuer, testSAN, "",
		time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	bundle := p.makeBundle(t, leafPriv, certDER, art, now, false) // 无 SET

	// 在线模式（要求日志证明）→ 拒绝
	if trustFor(p, true).Verify(exactPolicy(), art, bundle).Verified {
		t.Fatal("在线验证缺少日志证明必须被拒绝")
	}
	// 离线模式（不强制）→ 通过但标注未验证日志
	off := trustFor(p, false).Verify(exactPolicy(), art, bundle)
	if !off.Verified || off.TransparencyLogVerified {
		t.Fatal("离线验证应通过且明确标注日志未验证")
	}
}

func TestSigstore_TamperedSET(t *testing.T) {
	p := newTestPKI(t)
	art := sha256Of("artifact-bytes")
	now := time.Now().Unix()
	leafPriv, certDER := p.issueLeaf(t, testIssuer, testSAN, "",
		time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	bundle := p.makeBundle(t, leafPriv, certDER, art, now, true)

	// 篡改：解析后改 logIndex 使 SET 覆盖内容不符
	var b sigstoreBundle
	_ = json.Unmarshal(bundle, &b)
	b.VerificationMaterial.TlogEntries[0].LogIndex = "99999"
	tampered, _ := json.Marshal(b)

	res := trustFor(p, true).Verify(exactPolicy(), art, tampered)
	if res.Verified {
		t.Fatal("篡改的 SET 必须被拒绝")
	}
}

func TestSigstore_NoTrustRootFailsClosed(t *testing.T) {
	art := sha256Of("artifact-bytes")
	v := &SigstoreVerifier{} // 无信任根
	if v.Verify(exactPolicy(), art, []byte(`{}`)).Verified {
		t.Fatal("无信任根必须 fail closed")
	}
	// DefaultVerifier 未启用 Sigstore 也 fail closed
	d := &DefaultVerifier{}
	if d.VerifySigstoreBundle(context.Background(), exactPolicy(), art, []byte(`{}`)).Verified {
		t.Fatal("未启用 Sigstore 必须 fail closed")
	}
}

func TestSigstore_ControlledPatternMatch(t *testing.T) {
	p := newTestPKI(t)
	art := sha256Of("artifact-bytes")
	now := time.Now().Unix()
	uri := "https://github.com/useful/release/.github/workflows/publish.yml@refs/tags/v1"
	leafPriv, certDER := p.issueLeaf(t, testIssuer, "", uri,
		time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	bundle := p.makeBundle(t, leafPriv, certDER, art, now, true)

	// 受控模式：前缀*后缀，只允许一个 '*'
	policy := IdentityPolicy{
		PublisherKeyID: "sigstore:gh", Issuer: testIssuer,
		SANPattern: "https://github.com/useful/release/*@refs/tags/v1",
	}
	if !trustFor(p, true).Verify(policy, art, bundle).Verified {
		t.Fatal("受控模式匹配应通过")
	}

	// 过宽模式（两个 '*'）应被拒绝
	bad := policy
	bad.SANPattern = "https://github.com/*/release/*@refs/tags/v1"
	bad.SANExact = ""
	if trustFor(p, true).Verify(bad, art, bundle).Verified {
		t.Fatal("多通配模式必须被拒绝（防过宽匹配）")
	}
}

func TestSigstore_ECDSARekorKey(t *testing.T) {
	// 覆盖 verifySET 的 ECDSA 分支：Rekor 用 ECDSA 密钥
	p := newTestPKI(t)
	ecPriv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p.rekorPub = nil
	art := sha256Of("artifact-bytes")
	now := time.Now().Unix()
	leafPriv, certDER := p.issueLeaf(t, testIssuer, testSAN, "",
		time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	digest, _ := hex.DecodeString(art)
	sig := ed25519.Sign(leafPriv, digest)

	var b sigstoreBundle
	b.VerificationMaterial.Certificate.RawBytes = base64.StdEncoding.EncodeToString(certDER)
	b.MessageSignature.MessageDigest.Digest = base64.StdEncoding.EncodeToString(digest)
	b.MessageSignature.Signature = base64.StdEncoding.EncodeToString(sig)
	logIndex := "77"
	payload := SETPayload(logIndex, now, digest, certDER)
	sum := sha256.Sum256(payload)
	setSig, _ := ecdsa.SignASN1(rand.Reader, ecPriv, sum[:])
	entry := struct {
		LogIndex         string `json:"logIndex"`
		IntegratedTime   string `json:"integratedTime"`
		InclusionPromise struct {
			SignedEntryTimestamp string `json:"signedEntryTimestamp"`
		} `json:"inclusionPromise"`
	}{LogIndex: logIndex, IntegratedTime: itoa(now)}
	entry.InclusionPromise.SignedEntryTimestamp = base64.StdEncoding.EncodeToString(setSig)
	b.VerificationMaterial.TlogEntries = append(b.VerificationMaterial.TlogEntries, entry)
	raw, _ := json.Marshal(b)

	v := &SigstoreVerifier{
		Trust:                  &TrustRoot{FulcioRoots: p.fulcioRoots, RekorPublicKey: &ecPriv.PublicKey},
		RequireTransparencyLog: true,
	}
	res := v.Verify(exactPolicy(), art, raw)
	if !res.Verified || !res.TransparencyLogVerified {
		t.Fatalf("ECDSA Rekor 密钥应通过: %s", res.FailureReason)
	}
}

// 确保 asn1 导入被使用（OID 类型断言）。
var _ = asn1.ObjectIdentifier{}
