// Package publishers 的发布者签名验证（与 TUF 软件源验证完全分离）。
//
// 发布者用长期 Ed25519 私钥对制品签名；后端用登记的公钥验证。
// publisherKeyId 形如 "ed25519:<hex>"，公钥即其 hex 部分。
// 签名覆盖的规范化载荷 = "useful-artifact-v1\n<toolId>\n<version>\n<sha256>"，
// 绑定工具身份与制品摘要，防止签名被移花接木到别的制品。
package publishers

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"strings"

	"useful.dev/source/internal/domain"
)

// SigningPayload 构造发布者签名覆盖的规范化字节。
func SigningPayload(toolID, version, sha256 string) []byte {
	return []byte(fmt.Sprintf("useful-artifact-v1\n%s\n%s\n%s", toolID, version, strings.ToLower(sha256)))
}

// ParsePublisherKey 从 "ed25519:<hex>" 解析出 Ed25519 公钥。
func ParsePublisherKey(publisherKeyID string) (ed25519.PublicKey, error) {
	const prefix = "ed25519:"
	if !domain.IsEd25519PublisherKey(publisherKeyID) {
		return nil, fmt.Errorf("发布者密钥必须是 canonical ed25519:[a-f0-9]{64}")
	}
	raw, err := hex.DecodeString(publisherKeyID[len(prefix):])
	if err != nil {
		return nil, fmt.Errorf("发布者公钥不是合法 hex: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("发布者公钥长度必须为 %d 字节", ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

// VerifyPublisherSignature 验证 sigHex 是 publisherKeyID 对应私钥对
// (toolID, version, sha256) 载荷的有效签名。
func VerifyPublisherSignature(publisherKeyID, toolID, version, sha256, sigHex string) error {
	pub, err := ParsePublisherKey(publisherKeyID)
	if err != nil {
		return err
	}
	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		return fmt.Errorf("签名不是合法 hex: %w", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("签名长度必须为 %d 字节", ed25519.SignatureSize)
	}
	if !ed25519.Verify(pub, SigningPayload(toolID, version, sha256), sig) {
		return fmt.Errorf("发布者签名验证失败")
	}
	return nil
}

// VerifyKeyRotation 验证密钥轮换的连续性：
// 新公钥必须被现有受信私钥交叉签名（对新公钥 hex 的签名）。
// 无法证明连续性时，调用方应视为新发布者，不继承原发布者信誉。
// crossSig = 旧私钥对 "useful-key-rotation-v1\n<newKeyId>" 的签名。
func VerifyKeyRotation(oldPublisherKeyID, newPublisherKeyID, crossSigHex string) error {
	oldPub, err := ParsePublisherKey(oldPublisherKeyID)
	if err != nil {
		return err
	}
	// 新密钥也必须格式合法
	if _, err := ParsePublisherKey(newPublisherKeyID); err != nil {
		return err
	}
	sig, err := hex.DecodeString(crossSigHex)
	if err != nil {
		return fmt.Errorf("交叉签名不是合法 hex: %w", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("交叉签名长度非法")
	}
	payload := []byte("useful-key-rotation-v1\n" + newPublisherKeyID)
	if !ed25519.Verify(oldPub, payload, sig) {
		return fmt.Errorf("密钥轮换交叉签名验证失败（无法证明连续性）")
	}
	return nil
}
