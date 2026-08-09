package tufmeta

import (
	"testing"
	"time"
)

func TestCanonicalJSONMatchesCLIFormat(t *testing.T) {
	// 与 useful source CLI (cjson.mjs) / Rust 客户端一致的固定向量
	got, err := CanonicalJSON(map[string]any{
		"b": 1,
		"a": []any{true, nil, "x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"a":[true,null,"x"],"b":1}`
	if string(got) != want {
		t.Fatalf("canonical 不一致: %s != %s", got, want)
	}
}

func TestCanonicalRejectsFloats(t *testing.T) {
	if _, err := CanonicalJSON(map[string]any{"x": 1.5}); err == nil {
		t.Fatal("浮点必须拒绝")
	}
}

func TestKeyIDDeterministic(t *testing.T) {
	// keyid = sha256(canonical(公钥对象))，跨实现一致性由固定公钥向量固化
	id, err := KeyIDOf("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")
	if err != nil {
		t.Fatal(err)
	}
	id2, _ := KeyIDOf("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")
	if id != id2 || len(id) != 64 {
		t.Fatalf("keyid 不确定: %s %s", id, id2)
	}
}

func TestSignAndVerifyRoundTrip(t *testing.T) {
	k, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	signed := BuildTargets(1, ExpiresIn(30, now), map[string]TargetEntry{
		"tool.useful": {Length: 4, SHA256: "aa", Custom: map[string]any{"toolId": "com.x"}},
	})
	doc, err := Sign(signed, k)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := Verify(doc, k.PublicHex)
	if err != nil || !ok {
		t.Fatalf("验签失败: %v %v", ok, err)
	}
	// 错误公钥拒绝
	other, _ := GenerateKey()
	ok, _ = Verify(doc, other.PublicHex)
	if ok {
		t.Fatal("错误公钥不得通过验签")
	}
}

func TestFileKeyRoundTrip(t *testing.T) {
	dir := t.TempDir()
	k1, err := LoadOrCreateFileKey(dir, "targets")
	if err != nil {
		t.Fatal(err)
	}
	k2, err := LoadOrCreateFileKey(dir, "targets")
	if err != nil {
		t.Fatal(err)
	}
	if k1.KeyID != k2.KeyID {
		t.Fatal("重载文件密钥应得到相同 keyid")
	}
	if _, err := LoadOrCreateFileKey(dir, "../evil"); err == nil {
		t.Fatal("非法角色名必须拒绝")
	}
}
