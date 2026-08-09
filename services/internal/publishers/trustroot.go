// Sigstore 信任根加载：从目录读取 Fulcio CA 根与 Rekor 公钥。
// 生产公共实例密钥属 Owner Gate（由 TUF 分发）；目录未配置时 Sigstore 验证 fail closed。
package publishers

import (
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
)

// LoadTrustRoot 从目录读取 fulcio-root.pem（可含多张 CA）与 rekor.pub。
// rekor.pub 缺失时透明日志无法在线验证（离线模式仍可用，见 SigstoreVerifier）。
func LoadTrustRoot(dir string) (*TrustRoot, error) {
	fulcioPEM, err := os.ReadFile(filepath.Join(dir, "fulcio-root.pem"))
	if err != nil {
		return nil, fmt.Errorf("读取 fulcio-root.pem 失败: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(fulcioPEM) {
		return nil, fmt.Errorf("fulcio-root.pem 无有效证书")
	}
	tr := &TrustRoot{FulcioRoots: roots}

	if rekorPEM, err := os.ReadFile(filepath.Join(dir, "rekor.pub")); err == nil {
		block, _ := pem.Decode(rekorPEM)
		if block == nil {
			return nil, fmt.Errorf("rekor.pub 不是有效 PEM")
		}
		pub, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("rekor.pub 解析失败: %w", err)
		}
		tr.RekorPublicKey = pub
	}
	return tr, nil
}
