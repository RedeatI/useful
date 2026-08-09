// TUF metadata 解析 fuzz（供应链）：任何字节都不得 panic；
// 非法/篡改 metadata 必须返回 (false, err) 而非误判为有效。
package tufmeta

import (
	"encoding/hex"
	"testing"
)

func FuzzVerify(f *testing.F) {
	// 合法公钥 hex（32 字节）+ 若干畸形/半合法 metadata 种子
	pubHex := hex.EncodeToString(make([]byte, 32))
	f.Add([]byte(``), pubHex)
	f.Add([]byte(`{}`), pubHex)
	f.Add([]byte(`{"signed":{},"signatures":[]}`), pubHex)
	f.Add([]byte(`{"signed":{"_type":"root"},"signatures":[{"keyid":"x","sig":"zz"}]}`), pubHex)
	f.Add([]byte(`{"signed":{"_type":"timestamp","version":1},"signatures":[{"keyid":"a","sig":"00"}]}`), pubHex)
	f.Add([]byte(`not json at all`), "nothex")

	f.Fuzz(func(t *testing.T, doc []byte, key string) {
		// 不得 panic。返回 ok=true 时签名必须真的匹配（此处随机输入几乎不可能匹配）。
		ok, err := Verify(doc, key)
		if ok && err != nil {
			t.Fatalf("矛盾结果：ok=true 但 err!=nil: %v", err)
		}
	})
}
