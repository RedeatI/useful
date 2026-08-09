// 端到端集成测试：内存仓库 + 临时 filesystem storage + httptest。
// 覆盖：上传会话/哈希校验/包检查 → 扫描 → 审核发布 → discovery/catalog →
// 下载授权（免费/付费/权益）→ 流式下载 + Range → grant 过期 → 撤回 → 审计。
package app_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	authpkg "useful.dev/source/internal/auth"
	"useful.dev/source/internal/billing"
	"useful.dev/source/internal/catalog"
	"useful.dev/source/internal/config"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/downloads"
	"useful.dev/source/internal/httpapi"
	"useful.dev/source/internal/publishers"
	"useful.dev/source/internal/repository/memory"
	"useful.dev/source/internal/storage/fsstore"
	"useful.dev/source/internal/tufmeta"

	"log/slog"
)

var (
	publisherPrivateKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x42}, ed25519.SeedSize))
	publisherKey        = "ed25519:" + hex.EncodeToString(publisherPrivateKey.Public().(ed25519.PublicKey))
)

type env struct {
	t      *testing.T
	repo   *memory.Store
	store  *fsstore.FilesystemStorage
	pub    *publishers.Service
	grants *downloads.Service
	signer *authpkg.Signer
	http   *httptest.Server
	// adminBearer instance-admin 的 API Token 明文（真实认证路径，不绕过）
	adminBearer string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	repo := memory.New()
	store, err := fsstore.New(t.TempDir(), []byte("blob-secret"))
	if err != nil {
		t.Fatal(err)
	}
	keysDir := t.TempDir()
	tk, _ := tufmeta.LoadOrCreateFileKey(keysDir, "targets")
	sk, _ := tufmeta.LoadOrCreateFileKey(keysDir, "snapshot")
	tsk, _ := tufmeta.LoadOrCreateFileKey(keysDir, "timestamp")
	rootKey, _ := tufmeta.LoadOrCreateFileKey(keysDir, "root")

	cfg := &config.Config{
		Environment: config.EnvDevelopment, SourceID: "com.test.dyn",
		SourceName: "动态测试源", SourceOperator: "Tester",
		BaseURL: "http://127.0.0.1", StorageDriver: "filesystem",
		BillingProvider: "fake",
		MaxUploadSize:   32 << 20, MaxRequestBody: 1 << 20,
		DownloadGrantTTLSeconds: 60,
	}
	cat := &catalog.Service{Repo: repo, SourceID: cfg.SourceID}
	pub := &publishers.Service{
		Repo: repo, Store: store, Catalog: cat,
		TargetsKey: tk, SnapshotKey: sk, TimestampKey: tsk,
		TargetsExpireDays: 90, SnapshotExpireDays: 14, TimestampExpireDays: 2,
		AutoApprove: false, MaxUpload: cfg.MaxUploadSize,
	}
	grants := &downloads.Service{Repo: repo, Store: store, TTL: time.Minute}
	fake := &billing.Fake{Secret: []byte("fake-webhook-secret-dev")}

	// 预置 root（离线流程模拟）
	now := time.Now().UTC()
	rootSigned := tufmeta.BuildRoot(1, tufmeta.ExpiresIn(3650, now), map[string][]*tufmeta.Key{
		"root": {rootKey}, "targets": {tk}, "snapshot": {sk}, "timestamp": {tsk},
	}, nil)
	rootBytes, _ := tufmeta.Sign(rootSigned, rootKey)
	_ = store.Put(context.Background(), "metadata/1.root.json",
		strings.NewReader(string(rootBytes)), int64(len(rootBytes)))

	// 注册发布者
	_ = repo.Publishers().Create(context.Background(), &domain.Publisher{
		ID: "pub1", DisplayName: "Test Publisher", KeyID: publisherKey, CreatedAt: now,
	})

	// 创建 instance-admin 身份 + API Token（真实 RBAC 路径）
	_ = repo.Identities().CreateIdentity(context.Background(), &domain.Identity{
		ID: "e2e-admin", DisplayName: "E2E Admin", Kind: "user",
		Roles: []domain.Role{domain.RoleInstanceAdmin}, CreatedAt: now,
	})
	plaintext, hash, err := authpkg.NewAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	_ = repo.Identities().CreateToken(context.Background(), &domain.APIToken{
		ID: "tok_e2e", IdentityID: "e2e-admin", TokenHash: hash,
		Scopes: domain.AllScopes(), ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	})

	srv := &httpapi.Server{
		Cfg: cfg, Repo: repo, Store: store, Catalog: cat,
		Publisher: pub, Grants: grants, Billing: fake,
		WebhookProcessor: &billing.Processor{Repo: repo, Provider: fake},
		OAuth:            authpkg.NewServer(cfg, authpkg.NewSigner([]byte("e2e-oauth-secret"), cfg.BaseURL)),
		Signer:           authpkg.NewSigner([]byte("e2e-oauth-secret"), cfg.BaseURL),
		Log:              slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ts := httptest.NewServer(srv.Router())
	t.Cleanup(ts.Close)
	return &env{t: t, repo: repo, store: store, pub: pub, grants: grants, signer: srv.Signer, http: ts,
		adminBearer: plaintext}
}

// bearerFor 为某 subject 直接签发访问令牌（等价于走完 OAuth 流程后的结果）。
func (e *env) bearerFor(subject string, scopes ...string) string {
	tok, err := e.signer.Issue(subject, "access", scopes, time.Hour, time.Now())
	if err != nil {
		e.t.Fatal(err)
	}
	return tok
}

func makeUsefulArtifact(t *testing.T, id, version string, sizePad int) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mw, _ := zw.Create("manifest.json")
	_, _ = mw.Write([]byte(fmt.Sprintf(
		`{"schemaVersion":1,"id":%q,"name":"T","version":%q,"entry":{"type":"web","path":"index.html"}}`,
		id, version)))
	fw, _ := zw.Create("index.html")
	_, _ = fw.Write(bytes.Repeat([]byte("A"), sizePad))
	_ = zw.Close()
	return buf.Bytes()
}

func (e *env) postJSON(path string, body any, admin bool) *http.Response {
	e.t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", e.http.URL+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if admin {
		req.Header.Set("Authorization", "Bearer "+e.adminBearer)
	}
	resp, err := e.http.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	return resp
}

// postJSONBearer 带 Authorization: Bearer 的 POST。
func (e *env) postJSONBearer(path string, body any, bearer string) *http.Response {
	e.t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", e.http.URL+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+bearer)
	resp, err := e.http.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	return resp
}

func decode[T any](t *testing.T, resp *http.Response) T {
	t.Helper()
	defer resp.Body.Close()
	var v T
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// uploadAndRelease 完成上传+发布请求，返回 artifactId。
func (e *env) uploadAndRelease(useful []byte, toolID, version, accessMode string) string {
	e.t.Helper()
	sum := sha256.Sum256(useful)
	created := decode[map[string]string](e.t, e.postJSON("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey,
		"sha256":         hex.EncodeToString(sum[:]),
		"size":           len(useful),
	}, true))
	req, _ := http.NewRequest("PUT", e.http.URL+created["uploadUrl"], bytes.NewReader(useful))
	req.Header.Set("Authorization", "Bearer "+e.adminBearer)
	resp, err := e.http.Client().Do(req)
	if err != nil || resp.StatusCode != 200 {
		e.t.Fatalf("上传失败: %v %d", err, resp.StatusCode)
	}
	resp.Body.Close()

	rel := e.postJSON("/v1/publisher/releases", map[string]any{
		"uploadSessionId": created["uploadSessionId"],
		"toolId":          toolID, "name": "Test Tool", "summary": "测试",
		"license": "Apache-2.0", "version": version, "channel": "stable",
		"platform": "windows", "arch": "x86_64", "accessMode": accessMode,
		"permissions": []string{},
		"publisherSignature": hex.EncodeToString(ed25519.Sign(publisherPrivateKey,
			publishers.SigningPayload(toolID, version, hex.EncodeToString(sum[:])))),
	}, true)
	if rel.StatusCode != 201 {
		b, _ := io.ReadAll(rel.Body)
		e.t.Fatalf("创建 release 失败: %d %s", rel.StatusCode, b)
	}
	art := decode[map[string]any](e.t, rel)
	return art["id"].(string)
}

// scanAndApprove 模拟 worker 扫描 + 管理审核发布。
func (e *env) scanAndApprove(artifactID string) {
	e.t.Helper()
	if err := e.pub.RunScan(context.Background(), artifactID); err != nil {
		e.t.Fatal(err)
	}
	resp := e.postJSON("/v1/publisher/releases/"+artifactID+"/review",
		map[string]string{"decision": "approved"}, true)
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		e.t.Fatalf("审核失败: %d %s", resp.StatusCode, b)
	}
	resp.Body.Close()
}

func TestFreeToolFullLifecycle(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "com.test.hello", "1.0.0", 100_000)
	artID := e.uploadAndRelease(useful, "com.test.hello", "1.0.0", "free")
	e.scanAndApprove(artID)

	// discovery 可用且 rootSha256 与 metadata/1.root.json 一致
	resp, _ := e.http.Client().Get(e.http.URL + "/.well-known/useful-repository.json")
	disc := decode[map[string]any](t, resp)
	rootURL := e.http.URL + "/metadata/1.root.json"
	rootResp, _ := e.http.Client().Get(rootURL)
	rootBytes, _ := io.ReadAll(rootResp.Body)
	rootResp.Body.Close()
	sum := sha256.Sum256(rootBytes)
	if disc["repository"].(map[string]any)["rootSha256"] != hex.EncodeToString(sum[:]) {
		t.Fatal("discovery rootSha256 与 1.root.json 不一致")
	}

	// catalog snapshot 含条目（free）
	resp, _ = e.http.Client().Get(e.http.URL + "/v1/catalog/snapshot")
	snap := decode[map[string]any](t, resp)
	entries := snap["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("目录应有 1 条，实际 %d", len(entries))
	}

	// TUF metadata 已签发且可验签（timestamp）
	tsResp, _ := e.http.Client().Get(e.http.URL + "/metadata/timestamp.json")
	tsBytes, _ := io.ReadAll(tsResp.Body)
	tsResp.Body.Close()
	if len(tsBytes) == 0 || !bytes.Contains(tsBytes, []byte(`"timestamp"`)) {
		t.Fatal("timestamp metadata 缺失")
	}

	// 下载授权（免费匿名）→ 下载并校验字节
	sum2 := sha256.Sum256(useful)
	grantResp := e.postJSON("/v1/download-grants", map[string]string{
		"toolId": "com.test.hello", "publisherKeyId": publisherKey,
		"version": "1.0.0", "platform": "windows", "arch": "x86_64", "channel": "stable",
	}, false)
	if grantResp.StatusCode != 201 {
		b, _ := io.ReadAll(grantResp.Body)
		t.Fatalf("grant 失败: %d %s", grantResp.StatusCode, b)
	}
	grant := decode[map[string]any](t, grantResp)
	if grant["artifactSha256"] != hex.EncodeToString(sum2[:]) {
		t.Fatal("grant 摘要不符")
	}
	dlURL := grant["downloadUrl"].(string)
	// BaseURL 是占位，替换为测试服务器地址
	dlURL = e.http.URL + dlURL[strings.Index(dlURL, "/v1/blobs/"):]
	dl, _ := e.http.Client().Get(dlURL)
	body, _ := io.ReadAll(dl.Body)
	dl.Body.Close()
	if !bytes.Equal(body, useful) {
		t.Fatalf("下载内容不符: %d != %d", len(body), len(useful))
	}

	// Range 断点续传
	req, _ := http.NewRequest("GET", dlURL, nil)
	req.Header.Set("Range", "bytes=0-99")
	partial, _ := e.http.Client().Do(req)
	part, _ := io.ReadAll(partial.Body)
	partial.Body.Close()
	if partial.StatusCode != http.StatusPartialContent || len(part) != 100 {
		t.Fatalf("Range 失败: %d len=%d", partial.StatusCode, len(part))
	}

	// 审计存在且不含完整下载 URL
	audits, _ := e.repo.Audit().List(context.Background(), 100)
	found := false
	for _, a := range audits {
		if strings.Contains(a.Detail, "/v1/blobs/") {
			t.Fatal("审计不得包含完整临时下载 URL")
		}
		if a.Action == "download.grant" {
			found = true
		}
	}
	if !found {
		t.Fatal("缺少下载授权审计")
	}
}

func TestUploadHashMismatchRejected(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "com.test.hello", "1.0.0", 10)
	created := decode[map[string]string](t, e.postJSON("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey,
		"sha256":         strings.Repeat("ab", 32), // 错误摘要
		"size":           len(useful),
	}, true))
	req, _ := http.NewRequest("PUT", e.http.URL+created["uploadUrl"], bytes.NewReader(useful))
	req.Header.Set("Authorization", "Bearer "+e.adminBearer)
	resp, err := e.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		t.Fatal("哈希不符的上传必须失败")
	}
}

func TestArtifactIdentityUniqueConstraint(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "com.test.hello", "1.0.0", 10)
	_ = e.uploadAndRelease(useful, "com.test.hello", "1.0.0", "free")
	// 同 identity+version+platform+arch 再次发布 → 冲突
	useful2 := makeUsefulArtifact(t, "com.test.hello", "1.0.0", 20)
	sum := sha256.Sum256(useful2)
	created := decode[map[string]string](t, e.postJSON("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey, "sha256": hex.EncodeToString(sum[:]), "size": len(useful2),
	}, true))
	req, _ := http.NewRequest("PUT", e.http.URL+created["uploadUrl"], bytes.NewReader(useful2))
	req.Header.Set("Authorization", "Bearer "+e.adminBearer)
	r, _ := e.http.Client().Do(req)
	r.Body.Close()
	rel := e.postJSON("/v1/publisher/releases", map[string]any{
		"uploadSessionId": created["uploadSessionId"],
		"toolId":          "com.test.hello", "name": "T", "version": "1.0.0",
		"channel": "stable", "platform": "windows", "arch": "x86_64",
		"publisherSignature": hex.EncodeToString(ed25519.Sign(publisherPrivateKey,
			publishers.SigningPayload("com.test.hello", "1.0.0", hex.EncodeToString(sum[:])))),
	}, true)
	defer rel.Body.Close()
	if rel.StatusCode != http.StatusConflict {
		t.Fatalf("重复 artifact 身份必须 409，实际 %d", rel.StatusCode)
	}
}

func TestPaidToolRequiresEntitlement(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "com.test.pro", "2.0.0", 10)
	artID := e.uploadAndRelease(useful, "com.test.pro", "2.0.0", "entitlement")
	e.scanAndApprove(artID)

	// 匿名请求付费制品 → 403
	resp := e.postJSON("/v1/download-grants", map[string]string{
		"toolId": "com.test.pro", "publisherKeyId": publisherKey,
		"version": "2.0.0", "platform": "windows", "arch": "x86_64", "channel": "stable",
	}, false)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("无权益必须 403，实际 %d", resp.StatusCode)
	}

	// 权益激活后（服务层直查，HTTP 主体在 Phase 8 接 OAuth）→ 放行
	now := time.Now().UTC()
	_ = e.repo.Entitlements().Upsert(context.Background(), &domain.Entitlement{
		ID: "ent_1", SubjectID: "cus_1", ProductID: "", PlanID: "p",
		ToolScope: "*", Status: domain.EntitlementActive, StartsAt: now, UpdatedAt: now,
	})
	g, err := e.grants.Create(context.Background(), &downloads.GrantRequest{
		ToolID: "com.test.pro", PublisherKeyID: publisherKey, Version: "2.0.0",
		Platform: "windows", Arch: "x86_64", Channel: "stable", SubjectID: "cus_1",
	})
	if err != nil {
		t.Fatalf("有权益应放行: %v", err)
	}
	if g.Expired(now) {
		t.Fatal("新 grant 不应过期")
	}
	// 过期判定
	if !g.Expired(now.Add(2 * time.Minute)) {
		t.Fatal("grant 过期判定失败")
	}
}

func TestWithdrawnArtifactNotDownloadable(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "com.test.old", "1.0.0", 10)
	artID := e.uploadAndRelease(useful, "com.test.old", "1.0.0", "free")
	e.scanAndApprove(artID)
	// 撤回必须经过服务层的 durable intent：published -> withdraw-pending，
	// metadata 原子切换成功后才 finalize 为 withdrawn（记录不删除）。
	if err := e.pub.Withdraw(context.Background(), artID, "security", "e2e-admin"); err != nil {
		t.Fatal(err)
	}
	withdrawn, err := e.repo.Artifacts().Get(context.Background(), artID)
	if err != nil {
		t.Fatalf("撤回 intent 完成后应保留记录: %v", err)
	}
	if withdrawn.Status != domain.ArtifactWithdrawn {
		t.Fatalf("撤回 intent 应 finalize 为 withdrawn，实际 %s", withdrawn.Status)
	}
	resp := e.postJSON("/v1/download-grants", map[string]string{
		"toolId": "com.test.old", "publisherKeyId": publisherKey,
		"version": "1.0.0", "platform": "windows", "arch": "x86_64", "channel": "stable",
	}, false)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("撤回版本不得可下载，实际 %d", resp.StatusCode)
	}
	// 记录仍存在（禁止删除已发布制品记录）
	if _, err := e.repo.Artifacts().Get(context.Background(), artID); err != nil {
		t.Fatal("撤回后记录必须保留")
	}
}

func TestPublisherEndpointsRequireToken(t *testing.T) {
	e := newEnv(t)
	resp := e.postJSON("/v1/publisher/upload-sessions", map[string]any{
		"publisherKeyId": publisherKey, "sha256": strings.Repeat("ab", 32), "size": 10,
	}, false)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无令牌必须 401，实际 %d", resp.StatusCode)
	}
}

func TestRootPrivateKeyNeverInDatabaseSchema(t *testing.T) {
	// 结构性保证：迁移 SQL 不存在任何私钥列；publisher_keys 只有 public_key/kms_reference
	raw, err := os.ReadFile("../../migrations/0001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	sqlText := strings.ToLower(string(raw))
	if strings.Contains(sqlText, "private_key") || strings.Contains(sqlText, "root_key") {
		t.Fatal("数据库 schema 不得包含私钥列")
	}
	if !strings.Contains(sqlText, "public_key") {
		t.Fatal("publisher_keys 应只存公钥")
	}
}

// TestPaidDownloadViaBearer：付费制品的 subject 只能来自 bearer；请求体伪造 subjectId 无效。
func TestPaidDownloadViaBearer(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "com.test.pro", "2.0.0", 10)
	artID := e.uploadAndRelease(useful, "com.test.pro", "2.0.0", "entitlement")
	e.scanAndApprove(artID)

	// 无 bearer → 403
	resp := e.postJSON("/v1/download-grants", map[string]string{
		"toolId": "com.test.pro", "publisherKeyId": publisherKey,
		"version": "2.0.0", "platform": "windows", "arch": "x86_64", "channel": "stable",
	}, false)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("无令牌必须 403，实际 %d", resp.StatusCode)
	}

	// 持有权益的 subject 登录后→ 201
	now := time.Now().UTC()
	_ = e.repo.Entitlements().Upsert(context.Background(), &domain.Entitlement{
		ID: "ent_bearer", SubjectID: "cust-777", ProductID: "", PlanID: "p",
		ToolScope: "*", Status: domain.EntitlementActive, StartsAt: now, UpdatedAt: now,
	})
	bearer := e.bearerFor("cust-777", "downloads", "entitlements")
	ok := e.postJSONBearer("/v1/download-grants", map[string]string{
		"toolId": "com.test.pro", "publisherKeyId": publisherKey,
		"version": "2.0.0", "platform": "windows", "arch": "x86_64", "channel": "stable",
	}, bearer)
	defer ok.Body.Close()
	if ok.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(ok.Body)
		t.Fatalf("有权益 bearer 应 201，实际 %d %s", ok.StatusCode, b)
	}

	// 伪造：无权益 subject 的 bearer → 403（即使请求体写别人的 subject 也无效）
	badBearer := e.bearerFor("nobody-999", "downloads")
	bad := e.postJSONBearer("/v1/download-grants", map[string]any{
		"toolId": "com.test.pro", "publisherKeyId": publisherKey,
		"version": "2.0.0", "platform": "windows", "arch": "x86_64", "channel": "stable",
		"subjectId": "cust-777", // 伪造字段，应被忽略
	}, badBearer)
	defer bad.Body.Close()
	if bad.StatusCode != http.StatusForbidden {
		t.Fatalf("请求体伪造 subjectId 必须无效（403），实际 %d", bad.StatusCode)
	}
}

// TestMeEndpointRequiresBearer：/v1/me 无令牌 401，有令牌返回 subject。
func TestMeEndpointRequiresBearer(t *testing.T) {
	e := newEnv(t)
	resp, _ := e.http.Client().Get(e.http.URL + "/v1/me")
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/v1/me 无令牌必须 401，实际 %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("GET", e.http.URL+"/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+e.bearerFor("cust-1", "profile"))
	r2, _ := e.http.Client().Do(req)
	me := decode[map[string]any](t, r2)
	if me["subjectId"] != "cust-1" {
		t.Fatalf("/v1/me 应返回 subject，实际 %v", me)
	}
}

// TestCanceledEntitlementBlocksNewGrant：取消后不能取得新的付费 download grant。
func TestCanceledEntitlementBlocksNewGrant(t *testing.T) {
	e := newEnv(t)
	useful := makeUsefulArtifact(t, "com.test.pro", "2.0.0", 10)
	artID := e.uploadAndRelease(useful, "com.test.pro", "2.0.0", "entitlement")
	e.scanAndApprove(artID)
	now := time.Now().UTC()
	_ = e.repo.Entitlements().Upsert(context.Background(), &domain.Entitlement{
		ID: "ent_c", SubjectID: "cust-cancel", ProductID: "", PlanID: "p",
		ToolScope: "*", Status: domain.EntitlementCanceled, StartsAt: now, UpdatedAt: now,
	})
	bearer := e.bearerFor("cust-cancel", "downloads")
	resp := e.postJSONBearer("/v1/download-grants", map[string]string{
		"toolId": "com.test.pro", "publisherKeyId": publisherKey,
		"version": "2.0.0", "platform": "windows", "arch": "x86_64", "channel": "stable",
	}, bearer)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("canceled 权益不得取新付费授权（403），实际 %d", resp.StatusCode)
	}
}
