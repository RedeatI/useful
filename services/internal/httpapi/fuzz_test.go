// HTTP 路径校验 fuzz（防路径穿越）：metadata 名与 target 路径解析对任意输入
// 都不得 panic；接受的输入必须满足严格白名单（无 / .. \ 盘符）。
package httpapi

import (
	"strings"
	"testing"

	"useful.dev/source/internal/domain"
)

func FuzzMetadataName(f *testing.F) {
	for _, s := range []string{
		"1.root.json", "timestamp.json", "../etc/passwd", "a/b.json",
		"..\\win.json", "C:\\x.json", "", strings.Repeat("a", 128) + ".json",
		"UPPER.json", "ok-name.json", "no-ext",
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, name string) {
		ok := metadataNameOK(name) // 不得 panic
		if ok {
			if len(name) == 0 || len(name) > 64 {
				t.Fatalf("接受非法长度: %q", name)
			}
			if strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
				t.Fatalf("接受了含路径穿越字符的名: %q", name)
			}
			if !strings.HasSuffix(name, ".json") {
				t.Fatalf("接受了非 .json: %q", name)
			}
			for _, c := range name {
				if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '-') {
					t.Fatalf("接受了非白名单字符: %q", name)
				}
			}
		}
	})
}

// FuzzTargetPath 模拟 handleTarget 的 <sha256>.<name> 解析：绝不接受非法 sha 前缀。
func FuzzTargetPath(f *testing.F) {
	for _, s := range []string{
		strings.Repeat("a", 64) + ".tool.useful",
		"short.useful", "../../x", strings.Repeat("g", 64) + ".x",
		"", ".useful", strings.Repeat("0", 64),
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, name string) {
		dot := strings.Index(name, ".")
		accepted := dot == 64 && domain.IsSHA256(name[:64])
		if accepted {
			sha := name[:64]
			if len(sha) != 64 || !domain.IsSHA256(sha) {
				t.Fatalf("接受了非法 sha 前缀: %q", name)
			}
		}
	})
}
