// Sigstore 身份签名验证（可选发布者签名方式；不替代软件源 TUF 签名）。
//
// 本实现做真实的密码学验证，不是"存在一个有效证书就通过"：
//  1. 从 bundle 解析签名证书（DER），用配置的 Fulcio CA 根验证证书链；
//  2. 证书有效期必须覆盖签名时间（integratedTime）；
//  3. 从证书扩展提取 issuer（OID 1.3.6.1.4.1.57264.1.1）与 SAN；
//  4. 用证书公钥验证 messageSignature 覆盖的 artifact 摘要；
//  5. 用配置的 Rekor 公钥验证透明日志条目时间戳签名（SET）——离线可用日志证明；
//  6. 将 (issuer, SAN) 与该 Publisher 配置的身份策略匹配（精确或受控模式）；
//  7. bundle 中的 messageDigest 必须等于当前 artifact 的 SHA-256（绑定）。
//
// 任一环节缺失或失败：默认 fail closed，返回可解释原因。
package publishers

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"useful.dev/source/internal/domain"
)

// Fulcio 证书中 OIDC issuer 的扩展 OID（Sigstore 约定）。
var oidFulcioIssuerV1 = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 1}

// IdentityPolicy 发布者的 Sigstore 身份策略。
// 精确匹配 SANExact；或受控模式 SANPattern（仅允许单个 '*' 通配一段，
// 绝不允许无限制正则，避免过宽匹配导致身份冒充）。
type IdentityPolicy struct {
	// 绑定到的发布者（验证成功后身份归属）
	PublisherKeyID string
	// 允许的 OIDC issuer（精确）
	Issuer string
	// 允许的 subject/SAN（精确，优先）
	SANExact string
	// 允许的 subject/SAN 模式（受控：仅 "prefix*suffix" 形式）
	SANPattern string
}

// ValidateIdentityPolicy validates the future Sigstore publisher label and its
// tightly bounded identity selector. First publication remains Ed25519-only;
// this policy is registration data, not an installable client proof.
func ValidateIdentityPolicy(policy IdentityPolicy) error {
	if !domain.IsSigstorePublisherKey(policy.PublisherKeyID) {
		return fmt.Errorf("publisherKeyId is not a canonical Sigstore label")
	}
	if len(policy.Issuer) == 0 || len(policy.Issuer) > 2048 {
		return fmt.Errorf("Sigstore issuer is required")
	}
	issuer, err := url.Parse(policy.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil {
		return fmt.Errorf("Sigstore issuer must be an absolute HTTPS URL")
	}
	if (policy.SANExact == "") == (policy.SANPattern == "") {
		return fmt.Errorf("exactly one Sigstore SAN selector is required")
	}
	if len(policy.SANExact) > 2048 || len(policy.SANPattern) > 2048 {
		return fmt.Errorf("Sigstore SAN selector is too long")
	}
	if policy.SANExact != "" {
		if strings.Contains(policy.SANExact, "*") {
			return fmt.Errorf("Sigstore exact SAN cannot contain a wildcard")
		}
		return nil
	}
	star := strings.IndexByte(policy.SANPattern, '*')
	if star <= 0 || star == len(policy.SANPattern)-1 || strings.IndexByte(policy.SANPattern[star+1:], '*') >= 0 {
		return fmt.Errorf("Sigstore SAN pattern must contain one bounded wildcard")
	}
	return nil
}

// matchSAN 受控匹配：优先精确；模式仅支持单个 '*'。
func (p IdentityPolicy) matchSAN(san string) bool {
	if p.SANExact != "" {
		return p.SANExact == san
	}
	if p.SANPattern == "" {
		return false
	}
	star := strings.IndexByte(p.SANPattern, '*')
	if star < 0 || strings.IndexByte(p.SANPattern[star+1:], '*') >= 0 {
		return false // 必须恰好一个 '*'
	}
	prefix, suffix := p.SANPattern[:star], p.SANPattern[star+1:]
	if len(san) < len(prefix)+len(suffix) {
		return false
	}
	return strings.HasPrefix(san, prefix) && strings.HasSuffix(san, suffix)
}

// TrustRoot Sigstore 信任根（生产由 TUF 分发，属 Owner Gate；测试注入）。
type TrustRoot struct {
	// Fulcio 签发 CA 根（验证签名证书链）
	FulcioRoots *x509.CertPool
	// Rekor 透明日志公钥（验证条目时间戳签名）
	RekorPublicKey crypto.PublicKey
}

// sigstoreBundle 简化的 Sigstore bundle（对齐 protobuf bundle 的关键字段）。
type sigstoreBundle struct {
	MediaType            string `json:"mediaType"`
	VerificationMaterial struct {
		Certificate struct {
			RawBytes string `json:"rawBytes"` // base64 DER
		} `json:"certificate"`
		TlogEntries []struct {
			LogIndex         string `json:"logIndex"`
			IntegratedTime   string `json:"integratedTime"` // unix 秒（字符串）
			InclusionPromise struct {
				SignedEntryTimestamp string `json:"signedEntryTimestamp"` // base64
			} `json:"inclusionPromise"`
		} `json:"tlogEntries"`
	} `json:"verificationMaterial"`
	MessageSignature struct {
		MessageDigest struct {
			Algorithm string `json:"algorithm"`
			Digest    string `json:"digest"` // base64(sha256 raw)
		} `json:"messageDigest"`
		Signature string `json:"signature"` // base64
	} `json:"messageSignature"`
}

// SigstoreVerifier 基于注入信任根的验证器。TrustRoot 为空 → fail closed。
type SigstoreVerifier struct {
	Trust *TrustRoot
	// RequireTransparencyLog 在线验证要求日志证明；离线可置 false 并在结果标注。
	RequireTransparencyLog bool
}

func fail(reason string) PublisherSignatureResult {
	return PublisherSignatureResult{Verified: false, Method: "sigstore", FailureReason: reason}
}

// Verify 执行完整验证链。
func (v *SigstoreVerifier) Verify(policy IdentityPolicy, artifactSHA256 string, bundleJSON []byte) PublisherSignatureResult {
	if v.Trust == nil || v.Trust.FulcioRoots == nil {
		return fail("未配置 Sigstore 信任根（fail closed）")
	}
	var b sigstoreBundle
	if err := json.Unmarshal(bundleJSON, &b); err != nil {
		return fail("bundle 解析失败")
	}

	// 1) 解析签名证书
	certDER, err := base64.StdEncoding.DecodeString(b.VerificationMaterial.Certificate.RawBytes)
	if err != nil {
		return fail("证书不是合法 base64 DER")
	}
	leaf, err := x509.ParseCertificate(certDER)
	if err != nil {
		return fail("证书解析失败")
	}

	// 5)（先取时间）透明日志条目时间戳 —— 作为签名时间锚点
	if len(b.VerificationMaterial.TlogEntries) == 0 {
		return fail("缺少透明日志条目")
	}
	entry := b.VerificationMaterial.TlogEntries[0]
	integrated, err := parseUnix(entry.IntegratedTime)
	if err != nil {
		return fail("integratedTime 非法")
	}
	signingTime := time.Unix(integrated, 0).UTC()

	// 2) 证书链验证 + 有效期覆盖签名时间
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:       v.Trust.FulcioRoots,
		CurrentTime: signingTime,
		KeyUsages:   []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
	}); err != nil {
		return fail("证书链验证失败或有效期不覆盖签名时间")
	}

	// 3) 提取 issuer 与 SAN
	issuer := extractIssuer(leaf)
	san := extractSAN(leaf)
	if issuer == "" || san == "" {
		return fail("证书缺少 issuer 或 SAN")
	}

	// 7) 绑定：messageDigest 必须等于当前 artifact 摘要
	wantDigest, err := hex.DecodeString(strings.ToLower(artifactSHA256))
	if err != nil || len(wantDigest) != sha256.Size {
		return fail("artifact 摘要非法")
	}
	gotDigest, err := base64.StdEncoding.DecodeString(b.MessageSignature.MessageDigest.Digest)
	if err != nil || !bytesEqual(gotDigest, wantDigest) {
		return fail("bundle 摘要与 artifact 不绑定")
	}

	// 4) 用证书公钥验证签名覆盖 artifact 摘要
	sig, err := base64.StdEncoding.DecodeString(b.MessageSignature.Signature)
	if err != nil {
		return fail("签名不是合法 base64")
	}
	if !verifyDigestSignature(leaf.PublicKey, wantDigest, sig) {
		return fail("artifact 签名验证失败")
	}

	// 6) 身份策略匹配（issuer 精确 + SAN 精确/受控模式）
	if policy.Issuer != issuer {
		return fail("issuer 不符合发布者身份策略")
	}
	if !policy.matchSAN(san) {
		return fail("subject/SAN 不符合发布者身份策略")
	}

	// 5) 透明日志证明：验证 Rekor SET 覆盖条目
	tlogVerified := false
	if v.Trust.RekorPublicKey != nil {
		setSig, err := base64.StdEncoding.DecodeString(entry.InclusionPromise.SignedEntryTimestamp)
		if err == nil && verifySET(v.Trust.RekorPublicKey, entry.LogIndex, integrated, wantDigest, certDER, setSig) {
			tlogVerified = true
		}
	}
	if v.RequireTransparencyLog && !tlogVerified {
		return fail("透明日志证明缺失或无效（在线验证要求）")
	}

	return PublisherSignatureResult{
		Verified: true, Method: "sigstore",
		Issuer: issuer, Subject: san,
		TransparencyLogVerified: tlogVerified,
	}
}

// SETPayload 构造 Rekor 条目时间戳签名覆盖的规范化字节。
// 绑定 logIndex、集成时间、artifact 摘要与签名证书。
func SETPayload(logIndex string, integratedTime int64, artifactDigest, certDER []byte) []byte {
	h := sha256.Sum256(certDER)
	return []byte(fmt.Sprintf("rekor-set-v1\n%s\n%d\n%s\n%s",
		logIndex, integratedTime, hex.EncodeToString(artifactDigest), hex.EncodeToString(h[:])))
}

func verifySET(pub crypto.PublicKey, logIndex string, integratedTime int64, artifactDigest, certDER, sig []byte) bool {
	payload := SETPayload(logIndex, integratedTime, artifactDigest, certDER)
	sum := sha256.Sum256(payload)
	switch k := pub.(type) {
	case ed25519.PublicKey:
		return ed25519.Verify(k, payload, sig)
	case *ecdsa.PublicKey:
		return ecdsa.VerifyASN1(k, sum[:], sig)
	default:
		return false
	}
}

// verifyDigestSignature 用叶证书公钥验证覆盖 artifact 摘要的签名。
func verifyDigestSignature(pub crypto.PublicKey, digest, sig []byte) bool {
	switch k := pub.(type) {
	case ed25519.PublicKey:
		// Ed25519 覆盖原始摘要字节
		return ed25519.Verify(k, digest, sig)
	case *ecdsa.PublicKey:
		return ecdsa.VerifyASN1(k, digest, sig)
	default:
		return false
	}
}

func extractIssuer(c *x509.Certificate) string {
	for _, ext := range c.Extensions {
		if ext.Id.Equal(oidFulcioIssuerV1) {
			// V1 issuer 为裸 UTF8（无 ASN.1 包装）
			return string(ext.Value)
		}
	}
	return ""
}

func extractSAN(c *x509.Certificate) string {
	if len(c.EmailAddresses) > 0 {
		return c.EmailAddresses[0]
	}
	if len(c.URIs) > 0 {
		return c.URIs[0].String()
	}
	return ""
}

func parseUnix(s string) (int64, error) {
	var n int64
	_, err := fmt.Sscanf(s, "%d", &n)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("非法时间")
	}
	return n, nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
