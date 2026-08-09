// Sigstore 验证器仍有独立单测；首发路径在客户端具备可独立验证的 proof
// 之前必须稳定拒绝 Sigstore，不能把服务端布尔值发布成安装信任。
package publishers

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"useful.dev/source/internal/catalog"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository/memory"
	"useful.dev/source/internal/storage/fsstore"
	"useful.dev/source/internal/tufmeta"
)

const sigstoreKeyID = "sigstore:release-bot-identity-v1"

func makeUsefulArtifact(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mw, _ := zw.Create("manifest.json")
	_, _ = mw.Write([]byte(`{"schemaVersion":1,"id":"com.test.ss","name":"SS","version":"1.0.0","entry":{"type":"web","path":"index.html"}}`))
	fw, _ := zw.Create("index.html")
	_, _ = fw.Write([]byte("<html></html>"))
	_ = zw.Close()
	return buf.Bytes()
}

func newSigstoreService(t *testing.T, p *testPKI) (*Service, *memory.Store) {
	t.Helper()
	repo := memory.New()
	store, err := fsstore.New(t.TempDir(), []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	keysDir := t.TempDir()
	tk, _ := tufmeta.LoadOrCreateFileKey(keysDir, "targets")
	sk, _ := tufmeta.LoadOrCreateFileKey(keysDir, "snapshot")
	tsk, _ := tufmeta.LoadOrCreateFileKey(keysDir, "timestamp")
	cat := &catalog.Service{Repo: repo, SourceID: "com.test.src"}
	svc := &Service{
		Repo: repo, Store: store, Catalog: cat,
		TargetsKey: tk, SnapshotKey: sk, TimestampKey: tsk,
		TargetsExpireDays: 90, SnapshotExpireDays: 14, TimestampExpireDays: 2,
		MaxUpload: 32 << 20,
		Verifier:  &DefaultVerifier{Sigstore: trustFor(p, true)},
	}
	return svc, repo
}

// registerSigstorePublisher 注册带身份策略的 sigstore 发布者。
func registerSigstorePublisher(t *testing.T, repo *memory.Store) {
	t.Helper()
	if err := repo.Publishers().Create(context.Background(), &domain.Publisher{
		ID: "pub-ss", DisplayName: "Sigstore Publisher", KeyID: sigstoreKeyID,
		CreatedAt:      time.Now().UTC(),
		IdentityIssuer: testIssuer, IdentitySANExact: testSAN,
	}); err != nil {
		t.Fatal(err)
	}
}

func uploadAndRelease(t *testing.T, svc *Service, useful, bundle []byte) (*domain.Artifact, error) {
	t.Helper()
	sum := sha256.Sum256(useful)
	shaHex := hex.EncodeToString(sum[:])
	sess, err := svc.CreateUploadSession(context.Background(), sigstoreKeyID, shaHex, int64(len(useful)))
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.ReceiveContent(context.Background(), sess.ID, bytes.NewReader(useful)); err != nil {
		t.Fatal(err)
	}
	return svc.CreateRelease(context.Background(), &ReleaseRequest{
		UploadSessionID: sess.ID, ToolID: "com.test.ss", Name: "SS", Version: "1.0.0",
		Channel: "stable", Platform: "windows", Arch: "x86_64", AccessMode: "free",
		SigstoreBundle: json.RawMessage(bundle),
	})
}

func TestReleaseFlow_SigstoreIdentity(t *testing.T) {
	p := newTestPKI(t)
	svc, repo := newSigstoreService(t, p)
	registerSigstorePublisher(t, repo)

	useful := makeUsefulArtifact(t)
	sum := sha256.Sum256(useful)
	realSha := hex.EncodeToString(sum[:])
	now := time.Now()
	leafPriv, certDER := p.issueLeaf(t, testIssuer, testSAN, "",
		now.Add(-time.Hour), now.Add(time.Hour))
	bundle := p.makeBundle(t, leafPriv, certDER, realSha, now.Unix(), true)

	if _, err := uploadAndRelease(t, svc, useful, bundle); err == nil ||
		!strings.Contains(err.Error(), firstReleaseSigstoreUnsupported) {
		t.Fatalf("Sigstore 首发必须以稳定策略错误拒绝，得到 %v", err)
	}
	if arts, err := repo.Artifacts().ListByStatus(context.Background(), domain.ArtifactStaged); err != nil || len(arts) != 0 {
		t.Fatalf("被拒绝的 Sigstore proof 不得进入 artifact 状态机: len=%d err=%v", len(arts), err)
	}
}

func TestReleaseFlow_SigstoreWrongIdentityRejected(t *testing.T) {
	p := newTestPKI(t)
	svc, repo := newSigstoreService(t, p)
	registerSigstorePublisher(t, repo)

	useful := makeUsefulArtifact(t)
	sum := sha256.Sum256(useful)
	realSha := hex.EncodeToString(sum[:])
	now := time.Now()
	// 攻击者身份的证书：合法 CA 签发，但 SAN 是别人
	priv, der := p.issueLeaf(t, testIssuer, "attacker@evil.example", "",
		now.Add(-time.Hour), now.Add(time.Hour))
	bundle := p.makeBundle(t, priv, der, realSha, now.Unix(), true)

	if _, err := uploadAndRelease(t, svc, useful, bundle); err == nil ||
		!strings.Contains(err.Error(), firstReleaseSigstoreUnsupported) {
		t.Fatalf("Sigstore 首发必须在身份 bundle 处理前稳定拒绝，得到 %v", err)
	}
}
