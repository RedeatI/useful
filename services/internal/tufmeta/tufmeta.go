// Package tufmeta 生成并签署 TUF 风格 metadata（与 useful source CLI /
// Rust 客户端 BuiltinTufBackend 完全互操作：OLPC canonical JSON + Ed25519）。
//
// 密钥策略：root 私钥默认离线、绝不入库、绝不由服务器持有；服务器只持有
// targets/snapshot/timestamp 在线密钥（开发环境为文件密钥并打印警告）。
package tufmeta

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const SpecVersion = "1.0.0"

// CanonicalJSON OLPC 规范化序列化（TUF 签名输入）。仅允许整数。
func CanonicalJSON(v any) ([]byte, error) {
	var sb strings.Builder
	if err := writeCanonical(&sb, v); err != nil {
		return nil, err
	}
	return []byte(sb.String()), nil
}

func writeCanonicalString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, c := range s {
		switch c {
		case '\\':
			sb.WriteString(`\\`)
		case '"':
			sb.WriteString(`\"`)
		default:
			sb.WriteRune(c)
		}
	}
	sb.WriteByte('"')
}

func writeCanonical(sb *strings.Builder, v any) error {
	switch t := v.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if t {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case string:
		writeCanonicalString(sb, t)
	case int:
		fmt.Fprintf(sb, "%d", t)
	case int64:
		fmt.Fprintf(sb, "%d", t)
	case uint64:
		fmt.Fprintf(sb, "%d", t)
	case float64:
		// 来自 json.Unmarshal 的数字：仅允许整数值
		if t != float64(int64(t)) {
			return fmt.Errorf("canonical JSON 仅允许整数: %v", t)
		}
		fmt.Fprintf(sb, "%d", int64(t))
	case json.Number:
		if _, err := t.Int64(); err != nil {
			return fmt.Errorf("canonical JSON 仅允许整数: %s", t)
		}
		sb.WriteString(t.String())
	case []any:
		sb.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				sb.WriteByte(',')
			}
			if err := writeCanonical(sb, item); err != nil {
				return err
			}
		}
		sb.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeCanonicalString(sb, k)
			sb.WriteByte(':')
			if err := writeCanonical(sb, t[k]); err != nil {
				return err
			}
		}
		sb.WriteByte('}')
	default:
		// 结构体等：先转 map 再序列化
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		var m any
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.UseNumber()
		if err := dec.Decode(&m); err != nil {
			return err
		}
		return writeCanonical(sb, m)
	}
	return nil
}

// ---------- 密钥 ----------

type Key struct {
	KeyID     string
	PublicHex string
	Private   ed25519.PrivateKey // 可为 nil（只验签）
}

func keyObject(publicHex string) map[string]any {
	return map[string]any{
		"keytype": "ed25519",
		"scheme":  "ed25519",
		"keyval":  map[string]any{"public": publicHex},
	}
}

// KeyIDOf 与 CLI/Rust 一致：sha256(canonical(公钥对象))。
func KeyIDOf(publicHex string) (string, error) {
	c, err := CanonicalJSON(keyObject(publicHex))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(c)
	return hex.EncodeToString(sum[:]), nil
}

// GenerateKey 生成 Ed25519 密钥（crypto/ed25519 标准库，不自写原语）。
func GenerateKey() (*Key, error) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, err
	}
	publicHex := hex.EncodeToString(pub)
	keyid, err := KeyIDOf(publicHex)
	if err != nil {
		return nil, err
	}
	return &Key{KeyID: keyid, PublicHex: publicHex, Private: priv}, nil
}

// LoadOrCreateFileKey 开发文件密钥（PKCS#8 PEM）。生产应换 KMS signer。
// role 仅接受内部常量（targets/snapshot/timestamp），不接受外部输入。
func LoadOrCreateFileKey(dir, role string) (*Key, error) {
	if role != "targets" && role != "snapshot" && role != "timestamp" && role != "root" {
		return nil, fmt.Errorf("非法角色名: %q", role)
	}
	p := filepath.Join(dir, role+".pem")
	if raw, err := os.ReadFile(p); err == nil {
		block, _ := pem.Decode(raw)
		if block == nil {
			return nil, fmt.Errorf("%s: PEM 解析失败", p)
		}
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		priv, ok := parsed.(ed25519.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("%s: 不是 Ed25519 私钥", p)
		}
		publicHex := hex.EncodeToString(priv.Public().(ed25519.PublicKey))
		keyid, err := KeyIDOf(publicHex)
		if err != nil {
			return nil, err
		}
		return &Key{KeyID: keyid, PublicHex: publicHex, Private: priv}, nil
	}
	k, err := GenerateKey()
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(k.Private)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return k, nil
}

// ---------- metadata 构建与签名 ----------

type Signed map[string]any

// BuildRoot root.signed（consistent_snapshot 强制开启）。
func BuildRoot(version int64, expires time.Time, roles map[string][]*Key, thresholds map[string]int) Signed {
	keys := map[string]any{}
	roleDefs := map[string]any{}
	for role, list := range roles {
		ids := []any{}
		for _, k := range list {
			keys[k.KeyID] = keyObject(k.PublicHex)
			ids = append(ids, k.KeyID)
		}
		th := 1
		if t, ok := thresholds[role]; ok {
			th = t
		}
		roleDefs[role] = map[string]any{"keyids": ids, "threshold": th}
	}
	return Signed{
		"_type":               "root",
		"spec_version":        SpecVersion,
		"consistent_snapshot": true,
		"version":             version,
		"expires":             expires.UTC().Format("2006-01-02T15:04:05Z"),
		"keys":                keys,
		"roles":               roleDefs,
	}
}

type TargetEntry struct {
	Length int64
	SHA256 string
	Custom map[string]any
}

func BuildTargets(version int64, expires time.Time, targets map[string]TargetEntry) Signed {
	m := map[string]any{}
	for name, t := range targets {
		e := map[string]any{
			"length": t.Length,
			"hashes": map[string]any{"sha256": t.SHA256},
		}
		if t.Custom != nil {
			e["custom"] = t.Custom
		}
		m[name] = e
	}
	return Signed{
		"_type": "targets", "spec_version": SpecVersion,
		"version": version, "expires": expires.UTC().Format("2006-01-02T15:04:05Z"),
		"targets": m,
	}
}

func metaEntry(bytes []byte, version int64) map[string]any {
	sum := sha256.Sum256(bytes)
	return map[string]any{
		"version": version,
		"length":  int64(len(bytes)),
		"hashes":  map[string]any{"sha256": hex.EncodeToString(sum[:])},
	}
}

func BuildSnapshot(version int64, expires time.Time, targetsBytes []byte, targetsVersion int64) Signed {
	return Signed{
		"_type": "snapshot", "spec_version": SpecVersion,
		"version": version, "expires": expires.UTC().Format("2006-01-02T15:04:05Z"),
		"meta": map[string]any{"targets.json": metaEntry(targetsBytes, targetsVersion)},
	}
}

func BuildTimestamp(version int64, expires time.Time, snapshotBytes []byte, snapshotVersion int64) Signed {
	return Signed{
		"_type": "timestamp", "spec_version": SpecVersion,
		"version": version, "expires": expires.UTC().Format("2006-01-02T15:04:05Z"),
		"meta": map[string]any{"snapshot.json": metaEntry(snapshotBytes, snapshotVersion)},
	}
}

// Sign 用一组密钥对 signed 部分签名并序列化为最终 metadata 字节。
func Sign(signed Signed, keys ...*Key) ([]byte, error) {
	msg, err := CanonicalJSON(map[string]any(signed))
	if err != nil {
		return nil, err
	}
	sigs := []map[string]any{}
	for _, k := range keys {
		if k.Private == nil {
			return nil, fmt.Errorf("密钥 %s 无私钥", k.KeyID)
		}
		sigs = append(sigs, map[string]any{
			"keyid": k.KeyID,
			"sig":   hex.EncodeToString(ed25519.Sign(k.Private, msg)),
		})
	}
	doc := map[string]any{"signatures": sigs, "signed": map[string]any(signed)}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

// Verify 验证一份 metadata 的某个签名（测试与自检用）。
func Verify(docBytes []byte, publicHex string) (bool, error) {
	var doc struct {
		Signatures []struct {
			KeyID string `json:"keyid"`
			Sig   string `json:"sig"`
		} `json:"signatures"`
		Signed json.RawMessage `json:"signed"`
	}
	if err := json.Unmarshal(docBytes, &doc); err != nil {
		return false, err
	}
	var signed any
	dec := json.NewDecoder(strings.NewReader(string(doc.Signed)))
	dec.UseNumber()
	if err := dec.Decode(&signed); err != nil {
		return false, err
	}
	msg, err := CanonicalJSON(signed)
	if err != nil {
		return false, err
	}
	pub, err := hex.DecodeString(publicHex)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false, fmt.Errorf("公钥非法")
	}
	for _, s := range doc.Signatures {
		sig, err := hex.DecodeString(s.Sig)
		if err != nil {
			continue
		}
		if ed25519.Verify(ed25519.PublicKey(pub), msg, sig) {
			return true, nil
		}
	}
	return false, nil
}

// ExpiresIn 辅助：从 now 起 d 天。
func ExpiresIn(days int, now time.Time) time.Time {
	return now.Add(time.Duration(days) * 24 * time.Hour)
}
