// 关键解析器的 Go 原生 fuzz（供应链要求）。
// 目标：域校验器、metadata 名、target 路径、可用性错误分类。
// 不变量：任何输入都不 panic；接受的输入满足严格格式约束（防注入/路径穿越）。
package domain

import (
	"strings"
	"testing"
)

func FuzzIsLowercaseID(f *testing.F) {
	seeds := []string{"", "a", "com.useful.hello", "A", "..", "a/b", "a b",
		"9", "-x", "x-", strings.Repeat("a", 500), "中文", "a.b-c_d"}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		ok := IsLowercaseID(s) // 不得 panic
		if ok {
			// 接受的 ID：长度受限、仅小写字母数字与 ._-，首尾为字母数字
			if len(s) == 0 || len(s) > 200 {
				t.Fatalf("接受了非法长度: %q", s)
			}
			for _, c := range s {
				if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-') {
					t.Fatalf("接受了含非法字符的 ID: %q", s)
				}
			}
			first, last := rune(s[0]), rune(s[len(s)-1])
			okChar := func(c rune) bool { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') }
			if !okChar(first) || !okChar(last) {
				t.Fatalf("接受了首尾非字母数字的 ID: %q", s)
			}
		}
	})
}

func FuzzIsSHA256(f *testing.F) {
	f.Add("")
	f.Add(strings.Repeat("a", 64))
	f.Add(strings.Repeat("A", 64))
	f.Add(strings.Repeat("g", 64))
	f.Add("abc")
	f.Fuzz(func(t *testing.T, s string) {
		ok := IsSHA256(s)
		if ok {
			if len(s) != 64 {
				t.Fatalf("接受了非 64 长度: %q", s)
			}
			for _, c := range s {
				if !((c >= 'a' && c <= 'f') || (c >= '0' && c <= '9')) {
					t.Fatalf("接受了非小写 hex: %q", s)
				}
			}
		}
	})
}

func FuzzIsPublisherKey(f *testing.F) {
	f.Add("ed25519:" + strings.Repeat("ab", 32))
	f.Add("sigstore:release-bot-identity-v1")
	f.Add("rsa:xxxx")
	f.Add("")
	f.Add("ed25519:")
	f.Fuzz(func(t *testing.T, s string) {
		ok := IsPublisherKey(s) // 不得 panic
		if ok && !IsEd25519PublisherKey(s) && !IsSigstorePublisherKey(s) {
			t.Fatalf("接受了非 canonical publisher key: %q", s)
		}
	})
}

func FuzzIsSemver(f *testing.F) {
	for _, s := range []string{"1.0.0", "0.0.0", "1.2.3-beta.1+build", "01.0.0",
		"1", "1.0", "v1.0.0", "", strings.Repeat("9", 400)} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		_ = IsSemver(s) // 仅要求不 panic
	})
}
