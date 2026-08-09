// Phase 9 发布者安全测试：
// 发布者 Ed25519 签名（匹配/不匹配）、未审核原生 worker 发布门禁、
// 撤回端点（新用户不能下载、已装用户可见公告）、密钥轮换连续性、
// SBOM 存在性、catalog 真实 review 字段。
package app_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"testing"

	"archive/zip"
	"bytes"
	"fmt"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/publishers"
)

// newSigningPublisher 生成真实 Ed25519 密钥对并注册为发布者，返回 (keyID, priv)。
func newSigningPublisher(t *testing.T, e *env, id string) (string, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyID := "ed25519:" + hex.EncodeToString(pub)
	if err := e.repo.Publishers().Create(context.Background(), &domain.Publisher{
		ID: id, DisplayName: id, KeyID: keyID,
	}); err != nil {
		t.Fatal(err)
	}
	return keyID, priv
}

// makeUsefulWorkerArtifact 构造含原生可执行载荷（payload/tool.exe）的 .useful。
func makeUsefulWorkerArtifact(t *testing.T, id, version string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mw, _ := zw.Create("manifest.json")
	_, _ = mw.Write([]byte(fmt.Sprintf(
		`{"schemaVersion":1,"id":%q,"name":"W","version":%q,"entry":{"type":"worker","path":"payload/tool.exe"}}`,
		id, version)))
	fw, _ := zw.Create("payload/tool.exe")
	_, _ = fw.Write([]byte("MZ fake native payload"))
	_ = zw.Close()
	return buf.Bytes()
}

// makeUsefulSbomArtifact 构造含 sbom/sbom.cdx.json 的 .useful。
func makeUsefulSbomArtifact(t *testing.T, id, version string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mw, _ := zw.Create("manifest.json")
	_, _ = mw.Write([]byte(fmt.Sprintf(
		`{"schemaVersion":1,"id":%q,"name":"S","version":%q,"entry":{"type":"web","path":"index.html"}}`,
		id, version)))
	sw, _ := zw.Create("sbom/sbom.cdx.json")
	_, _ = sw.Write([]byte(`{"bomFormat":"CycloneDX","specVersion":"1.5"}`))
	fw, _ := zw.Create("index.html")
	_, _ = fw.Write([]byte("<html></html>"))
	_ = zw.Close()
	return buf.Bytes()
}

// uploadFor 用指定发布者上传内容，返回 uploadSessionId。
func (e *env) uploadFor(keyID string, useful []byte) string {
	e.t.Helper()
	sum := sha256.Sum256(useful)
	created := decode[map[string]string](e.t, e.postJSON("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": keyID,
		"sha256":         hex.EncodeToString(sum[:]),
		"size":           len(useful),
	}, true))
	req, _ := http.NewRequest("PUT", e.http.URL+created["uploadUrl"], bytes.NewReader(useful))
	req.Header.Set("Authorization", "Bearer "+e.adminBearer)
	resp, err := e.http.Client().Do(req)
	if err != nil || resp.StatusCode != 200 {
		e.t.Fatalf("上传失败: %v", err)
	}
	resp.Body.Close()
	return created["uploadSessionId"]
}

// TestPublisherSignatureVerified：正确签名 → publisherSignatureVerified=true，
// 且 catalog review 与 entry artifact 均如实反映。
func TestPublisherSignatureVerified(t *testing.T) {
	e := newEnv(t)
	keyID, priv := newSigningPublisher(t, e, "signer-pub")
	useful := makeUsefulArtifact(t, "com.test.signed", "1.0.0", 100)
	sum := sha256.Sum256(useful)
	shaHex := hex.EncodeToString(sum[:])
	sig := ed25519.Sign(priv, publishers.SigningPayload("com.test.signed", "1.0.0", shaHex))

	sessID := e.uploadFor(keyID, useful)
	rel := e.postJSON("/v1/publisher/releases", map[string]any{
		"uploadSessionId": sessID,
		"toolId":          "com.test.signed", "name": "Signed", "version": "1.0.0",
		"channel": "stable", "platform": "windows", "arch": "x86_64", "accessMode": "free",
		"publisherSignature": hex.EncodeToString(sig),
	}, true)
	if rel.StatusCode != 201 {
		b, _ := io.ReadAll(rel.Body)
		t.Fatalf("签名正确应 201，实际 %d %s", rel.StatusCode, b)
	}
	art := decode[map[string]any](t, rel)
	if art["publisherSignatureVerified"] != true {
		t.Fatal("publisherSignatureVerified 应为 true")
	}
	if art["publisherSignature"] != hex.EncodeToString(sig) {
		t.Fatal("Artifact 必须保留已验证、规范化的 Ed25519 proof")
	}
	if art["signatureIdentity"] != keyID {
		t.Fatal("Ed25519 signatureIdentity 必须等于自描述 publisherKeyId")
	}
	e.scanAndApprove(art["id"].(string))

	// TUF-signed target custom 必须绑定 proof、身份、工具、版本与目标摘要。
	tsResp, _ := e.http.Client().Get(e.http.URL + "/metadata/timestamp.json")
	timestamp := decode[map[string]any](t, tsResp)
	snapshotVersion := int64(timestamp["signed"].(map[string]any)["meta"].(map[string]any)["snapshot.json"].(map[string]any)["version"].(float64))
	snapResp, _ := e.http.Client().Get(fmt.Sprintf("%s/metadata/%d.snapshot.json", e.http.URL, snapshotVersion))
	snapshot := decode[map[string]any](t, snapResp)
	targetsVersion := int64(snapshot["signed"].(map[string]any)["meta"].(map[string]any)["targets.json"].(map[string]any)["version"].(float64))
	targetsResp, _ := e.http.Client().Get(fmt.Sprintf("%s/metadata/%d.targets.json", e.http.URL, targetsVersion))
	targetsDoc := decode[map[string]any](t, targetsResp)
	targets := targetsDoc["signed"].(map[string]any)["targets"].(map[string]any)
	if len(targets) != 1 {
		t.Fatalf("期望唯一稳定 target，得到 %d", len(targets))
	}
	var target map[string]any
	var targetName string
	for name, raw := range targets {
		targetName = name
		target = raw.(map[string]any)
	}
	custom := target["custom"].(map[string]any)
	if custom["publisherKeyId"] != keyID || custom["toolId"] != "com.test.signed" ||
		custom["version"] != "1.0.0" || custom["channel"] != "stable" ||
		custom["platform"] != "windows" || custom["arch"] != "x86_64" ||
		custom["artifactSha256"] != shaHex || custom["publisherSignature"] != hex.EncodeToString(sig) ||
		custom["publisherSignatureVerified"] != true || custom["publisherSignatureMethod"] != "ed25519" ||
		custom["publisherSignaturePayloadVersion"] != "useful-artifact-v1" || custom["signatureIdentity"] != keyID {
		t.Fatalf("TUF publisher trust custom 绑定不完整: %#v", custom)
	}
	targetResp, err := e.http.Client().Get(e.http.URL + "/targets/" + shaHex + "." + targetName)
	if err != nil {
		t.Fatal(err)
	}
	targetResp.Body.Close()
	if targetResp.StatusCode != http.StatusOK {
		t.Fatalf("稳定 target identity 应可精确解析并下载，实际 %d", targetResp.StatusCode)
	}

	// catalog：review.publisherSignatureVerified=true（来自真实字段，非硬编码）
	resp, _ := e.http.Client().Get(e.http.URL + "/v1/catalog/snapshot")
	snap := decode[map[string]any](t, resp)
	for _, raw := range snap["entries"].([]any) {
		entry := raw.(map[string]any)
		if entry["identity"].(map[string]any)["toolId"] != "com.test.signed" {
			continue
		}
		review := entry["review"].(map[string]any)
		if review["publisherSignatureVerified"] != true {
			t.Fatal("catalog review.publisherSignatureVerified 应为 true")
		}
		if review["securityScanPassed"] != true || review["officialReviewPassed"] != true {
			t.Fatal("扫描/审核状态应为 true")
		}
		arts := entry["artifacts"].([]any)
		if arts[0].(map[string]any)["publisherSignatureVerified"] != true {
			t.Fatal("entry artifact 的 publisherSignatureVerified 应为 true")
		}
		return
	}
	t.Fatal("目录缺少 com.test.signed 条目")
}

// TestPublisherSignatureMismatchRejected：发布者密钥不匹配时拒绝（Phase 9 验收）。
func TestPublisherSignatureMismatchRejected(t *testing.T) {
	e := newEnv(t)
	keyID, _ := newSigningPublisher(t, e, "victim-pub")
	// 攻击者用自己的私钥冒签
	_, attacker, _ := ed25519.GenerateKey(rand.Reader)
	useful := makeUsefulArtifact(t, "com.test.forged", "1.0.0", 100)
	sum := sha256.Sum256(useful)
	sig := ed25519.Sign(attacker, publishers.SigningPayload("com.test.forged", "1.0.0", hex.EncodeToString(sum[:])))

	sessID := e.uploadFor(keyID, useful)
	rel := e.postJSON("/v1/publisher/releases", map[string]any{
		"uploadSessionId": sessID,
		"toolId":          "com.test.forged", "name": "Forged", "version": "1.0.0",
		"channel": "stable", "platform": "windows", "arch": "x86_64",
		"publisherSignature": hex.EncodeToString(sig),
	}, true)
	defer rel.Body.Close()
	if rel.StatusCode != http.StatusBadRequest {
		t.Fatalf("签名不匹配必须 400，实际 %d", rel.StatusCode)
	}
	// 未签名字段也不得残留 staged 制品
	if _, err := e.repo.Artifacts().GetByIdentity(context.Background(),
		keyID, "com.test.forged", "1.0.0", "windows", "x86_64"); err == nil {
		t.Fatal("签名不匹配不得入库")
	}
}

// TestUnreviewedNativeWorkerNotAutoPublished：未审核原生 worker 即使 AutoApprove
// 也不能公开发布；人工审核通过后才发布（Phase 9 验收）。
func TestUnreviewedNativeWorkerNotAutoPublished(t *testing.T) {
	e := newEnv(t)
	e.pub.AutoApprove = true // 开发模式自动发布
	useful := makeUsefulWorkerArtifact(t, "com.test.native", "1.0.0")
	artID := e.uploadAndRelease(useful, "com.test.native", "1.0.0", "free")
	if err := e.pub.RunScan(context.Background(), artID); err != nil {
		t.Fatal(err)
	}
	art, _ := e.repo.Artifacts().Get(context.Background(), artID)
	if !art.IsNativeWorker {
		t.Fatal("应检测为原生 worker")
	}
	if art.Status == domain.ArtifactPublished {
		t.Fatal("未审核原生 worker 不得自动发布")
	}
	if art.Status != domain.ArtifactScanned {
		t.Fatalf("应停在 scanned 等待人工审核，实际 %s", art.Status)
	}
	// 对照组：非原生 worker 在 AutoApprove 下自动发布
	webArtifact := makeUsefulArtifact(t, "com.test.webonly", "1.0.0", 10)
	webID := e.uploadAndRelease(webArtifact, "com.test.webonly", "1.0.0", "free")
	if err := e.pub.RunScan(context.Background(), webID); err != nil {
		t.Fatal(err)
	}
	web, _ := e.repo.Artifacts().Get(context.Background(), webID)
	if web.Status != domain.ArtifactPublished {
		t.Fatalf("非原生 worker 应自动发布，实际 %s", web.Status)
	}
	// 人工审核后原生 worker 才发布，且 officialReviewPassed 置位
	resp := e.postJSON("/v1/publisher/releases/"+artID+"/review",
		map[string]string{"decision": "approved"}, true)
	resp.Body.Close()
	art, _ = e.repo.Artifacts().Get(context.Background(), artID)
	if art.Status != domain.ArtifactPublished || !art.OfficialReviewPassed {
		t.Fatalf("人工审核后应发布并置 officialReviewPassed，实际 %s %v",
			art.Status, art.OfficialReviewPassed)
	}
}

// TestWithdrawEndpointAndAdvisoryVisible：HTTP 撤回后新用户不能下载；
// 发布公告后 catalog 条目与 advisories 端点对已安装用户可见（Phase 9 验收）。
func TestWithdrawEndpointAndAdvisoryVisible(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "com.test.vuln", "1.0.0", 10)
	artID := e.uploadAndRelease(useful, "com.test.vuln", "1.0.0", "free")
	e.scanAndApprove(artID)

	// HTTP 撤回端点
	resp := e.postJSON("/v1/publisher/releases/"+artID+"/withdraw",
		map[string]string{"reason": "安全漏洞"}, true)
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("撤回失败: %d %s", resp.StatusCode, b)
	}
	resp.Body.Close()

	// 新用户不能下载
	grant := e.postJSON("/v1/download-grants", map[string]string{
		"toolId": "com.test.vuln", "publisherKeyId": publisherKey,
		"version": "1.0.0", "platform": "windows", "arch": "x86_64", "channel": "stable",
	}, false)
	grant.Body.Close()
	if grant.StatusCode != http.StatusForbidden {
		t.Fatalf("撤回版本不得可下载，实际 %d", grant.StatusCode)
	}
	// 记录保留（禁止删除）
	if _, err := e.repo.Artifacts().Get(context.Background(), artID); err != nil {
		t.Fatal("撤回后记录必须保留")
	}

	// 发布安全公告
	advResp := e.postJSON("/v1/publisher/advisories", map[string]any{
		"publisherKeyId": publisherKey, "toolId": "com.test.vuln",
		"severity": "high", "summary": "1.0.0 存在任意文件读取漏洞，请停止使用",
		"affectedVersions": []string{"1.0.0"},
	}, true)
	if advResp.StatusCode != 201 {
		b, _ := io.ReadAll(advResp.Body)
		t.Fatalf("公告创建失败: %d %s", advResp.StatusCode, b)
	}
	advResp.Body.Close()

	// 公告端点公开可读（无需管理令牌：已安装用户轮询用）
	getAdv, _ := e.http.Client().Get(e.http.URL +
		"/v1/tools/" + publisherKey + "/com.test.vuln/advisories")
	advs := decode[map[string]any](t, getAdv)
	if len(advs["advisories"].([]any)) != 1 {
		t.Fatal("advisories 端点应返回 1 条公告")
	}

	// catalog：版本全部撤回仍保留条目（携带公告，已装用户可见）
	snapResp, _ := e.http.Client().Get(e.http.URL + "/v1/catalog/snapshot")
	snap := decode[map[string]any](t, snapResp)
	found := false
	for _, raw := range snap["entries"].([]any) {
		entry := raw.(map[string]any)
		if entry["identity"].(map[string]any)["toolId"] != "com.test.vuln" {
			continue
		}
		found = true
		list, ok := entry["advisories"].([]any)
		if !ok || len(list) != 1 {
			t.Fatal("catalog 条目应携带公告")
		}
		adv := list[0].(map[string]any)
		if adv["severity"] != "high" {
			t.Fatalf("公告严重级别不符: %v", adv["severity"])
		}
		arts := entry["artifacts"].([]any)
		if arts[0].(map[string]any)["withdrawn"] != true {
			t.Fatal("制品应标记 withdrawn")
		}
	}
	if !found {
		t.Fatal("全部撤回但有公告的工具应保留在目录（已装用户可见通知）")
	}
}

// TestKeyRotationContinuity：交叉签名有效 → 轮换登记 rotated_from；
// 签名无效 → 拒绝（视为新发布者，不继承信誉）。
func TestKeyRotationContinuity(t *testing.T) {
	e := newEnv(t)
	oldKeyID, oldPriv := newSigningPublisher(t, e, "rotating-pub")
	newPub, _, _ := ed25519.GenerateKey(rand.Reader)
	newKeyID := "ed25519:" + hex.EncodeToString(newPub)

	// 无效交叉签名 → 403
	bad := e.postJSON("/v1/publisher/keys/rotate", map[string]string{
		"oldKeyId": oldKeyID, "newKeyId": newKeyID,
		"crossSignature": hex.EncodeToString(bytes.Repeat([]byte{0xab}, 64)),
	}, true)
	bad.Body.Close()
	if bad.StatusCode != http.StatusForbidden {
		t.Fatalf("无效交叉签名必须 403，实际 %d", bad.StatusCode)
	}

	// 有效交叉签名 → 登记成功，GetKey 可见 rotatedFrom
	crossSig := ed25519.Sign(oldPriv, []byte("useful-key-rotation-v1\n"+newKeyID))
	ok := e.postJSON("/v1/publisher/keys/rotate", map[string]string{
		"oldKeyId": oldKeyID, "newKeyId": newKeyID,
		"crossSignature": hex.EncodeToString(crossSig),
	}, true)
	if ok.StatusCode != 200 {
		b, _ := io.ReadAll(ok.Body)
		t.Fatalf("有效轮换应 200，实际 %d %s", ok.StatusCode, b)
	}
	ok.Body.Close()
	k, err := e.repo.Publishers().GetKey(context.Background(), newKeyID)
	if err != nil {
		t.Fatal("新密钥应已登记")
	}
	if k.RotatedFrom != oldKeyID {
		t.Fatalf("rotatedFrom 应指向旧密钥，实际 %q", k.RotatedFrom)
	}
}

// TestSBOMDetectedInScan：包内 sbom/ 存在 → 扫描记录 SBOM 摘要与 hasSbom。
func TestSBOMDetectedInScan(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulSbomArtifact(t, "com.test.sbom", "1.0.0")
	artID := e.uploadAndRelease(useful, "com.test.sbom", "1.0.0", "free")
	if err := e.pub.RunScan(context.Background(), artID); err != nil {
		t.Fatal(err)
	}
	art, _ := e.repo.Artifacts().Get(context.Background(), artID)
	if art.SBOMDigest == "" {
		t.Fatal("含 sbom/ 的包应记录 SBOMDigest")
	}
	if !bytes.Contains([]byte(art.ScanResultJSON), []byte(`"hasSbom":true`)) {
		t.Fatalf("扫描结果应含 hasSbom=true: %s", art.ScanResultJSON)
	}
	if art.Status != domain.ArtifactScanned {
		t.Fatalf("扫描应通过，实际 %s", art.Status)
	}
}

// TestUnsignedReleaseRejected：正常发布必须携带且通过一种 publisher proof。
func TestUnsignedReleaseRejected(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "com.test.nosig", "1.0.0", 10)
	sum := sha256.Sum256(useful)
	created := decode[map[string]string](t, e.postJSON("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey, "sha256": hex.EncodeToString(sum[:]), "size": len(useful),
	}, true))
	req, _ := http.NewRequest("PUT", e.http.URL+created["uploadUrl"], bytes.NewReader(useful))
	req.Header.Set("Authorization", "Bearer "+e.adminBearer)
	upload, err := e.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	upload.Body.Close()
	resp := e.postJSON("/v1/publisher/releases", map[string]any{
		"uploadSessionId": created["uploadSessionId"], "toolId": "com.test.nosig",
		"name": "No Signature", "version": "1.0.0", "channel": "stable",
		"platform": "windows", "arch": "x86_64",
	}, true)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺失 publisher proof 必须 400，实际 %d", resp.StatusCode)
	}
}
