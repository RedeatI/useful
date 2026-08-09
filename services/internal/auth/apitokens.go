// API Token（usefuls_ 前缀）：生成、哈希与常量时间比对。
// 明文只在创建响应返回一次；服务端只保存 SHA-256。
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strings"
)

// APITokenPrefix 便于 secret scanning 识别与 Bearer 分流。
const APITokenPrefix = "usefuls_"

// NewAPIToken 生成 (明文, sha256hex)。明文 = usefuls_ + 32 字节随机 hex。
func NewAPIToken() (plaintext, hash string, err error) {
	var buf [32]byte
	if _, err = rand.Read(buf[:]); err != nil {
		return "", "", fmt.Errorf("生成随机数失败: %w", err)
	}
	plaintext = APITokenPrefix + hex.EncodeToString(buf[:])
	return plaintext, HashAPIToken(plaintext), nil
}

// HashAPIToken 明文 → sha256 hex（存库、查询用）。
func HashAPIToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// IsAPIToken 判断 bearer 值是否为 API Token（与 OAuth 访问令牌分流）。
func IsAPIToken(bearer string) bool { return strings.HasPrefix(bearer, APITokenPrefix) }

// EqualHash 常量时间比较两个哈希。
func EqualHash(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
