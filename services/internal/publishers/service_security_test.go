package publishers

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository"
	"useful.dev/source/internal/repository/memory"
	"useful.dev/source/internal/storage"
	"useful.dev/source/internal/tufmeta"
)

type securityStorage struct {
	mu        sync.Mutex
	objects   map[string][]byte
	getCalls  int
	beforePut func(context.Context, string) error
}

func newSecurityStorage() *securityStorage {
	return &securityStorage{objects: map[string][]byte{}}
}

func (s *securityStorage) Put(ctx context.Context, key string, r io.Reader, size int64) error {
	s.mu.Lock()
	hook := s.beforePut
	s.mu.Unlock()
	if hook != nil {
		if err := hook(ctx, key); err != nil {
			return err
		}
	}
	raw, err := io.ReadAll(io.LimitReader(r, size+1))
	if err != nil {
		return err
	}
	if int64(len(raw)) != size {
		return fmt.Errorf("size mismatch")
	}
	s.mu.Lock()
	s.objects[key] = append([]byte(nil), raw...)
	s.mu.Unlock()
	return nil
}

func (s *securityStorage) PutIfAbsentOrSame(ctx context.Context, key string, r io.Reader, size int64) error {
	s.mu.Lock()
	hook := s.beforePut
	s.mu.Unlock()
	if hook != nil {
		if err := hook(ctx, key); err != nil {
			return err
		}
	}
	raw, err := io.ReadAll(io.LimitReader(r, size+1))
	if err != nil {
		return err
	}
	if int64(len(raw)) != size {
		return fmt.Errorf("size mismatch")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.objects[key]; ok {
		if !bytes.Equal(existing, raw) {
			return storage.ErrObjectConflict
		}
		return nil
	}
	s.objects[key] = append([]byte(nil), raw...)
	return nil
}

func (s *securityStorage) Get(_ context.Context, key string) (io.ReadCloser, storage.ObjectInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.getCalls++
	raw, ok := s.objects[key]
	if !ok {
		return nil, storage.ObjectInfo{}, domain.ErrNotFound
	}
	cp := append([]byte(nil), raw...)
	return io.NopCloser(bytes.NewReader(cp)), storage.ObjectInfo{Size: int64(len(cp))}, nil
}

func (s *securityStorage) Head(_ context.Context, key string) (storage.ObjectInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, ok := s.objects[key]
	if !ok {
		return storage.ObjectInfo{}, domain.ErrNotFound
	}
	return storage.ObjectInfo{Size: int64(len(raw))}, nil
}

func (s *securityStorage) DeleteStaging(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, key)
	return nil
}

func (s *securityStorage) CopyToPublished(_ context.Context, stagingKey, publishedKey string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, ok := s.objects[stagingKey]
	if !ok {
		return domain.ErrNotFound
	}
	if _, exists := s.objects[publishedKey]; !exists {
		s.objects[publishedKey] = append([]byte(nil), raw...)
	}
	return nil
}

func (s *securityStorage) CreateDownloadURL(context.Context, string, time.Duration) (string, error) {
	return "/test-download", nil
}

func (*securityStorage) SupportsRange() bool { return false }

func (s *securityStorage) object(key string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, ok := s.objects[key]
	return append([]byte(nil), raw...), ok
}

func (s *securityStorage) gets() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getCalls
}

func newPublisherSecurityService(t *testing.T) (*Service, *memory.Store, *securityStorage, string, ed25519.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publisherKeyID := "ed25519:" + hex.EncodeToString(publicKey)
	repo := memory.New()
	if err := repo.Publishers().Create(context.Background(), &domain.Publisher{
		ID: "publisher-security", DisplayName: "Security", KeyID: publisherKeyID,
		CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	targetsKey, err := tufmeta.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	snapshotKey, err := tufmeta.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	timestampKey, err := tufmeta.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	store := newSecurityStorage()
	return &Service{
		Repo: repo, Store: store, MaxUpload: 32 << 20,
		TargetsKey: targetsKey, SnapshotKey: snapshotKey, TimestampKey: timestampKey,
		TargetsExpireDays: 90, SnapshotExpireDays: 14, TimestampExpireDays: 2,
	}, repo, store, publisherKeyID, privateKey
}

func securityUsefulArtifact(t *testing.T, id, version string, permissions []string) []byte {
	t.Helper()
	manifest, err := json.Marshal(map[string]any{
		"schemaVersion": 1, "id": id, "name": "Security", "version": version,
		"permissions": permissions,
		"entry":       map[string]any{"type": "web", "path": "index.html"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return makeArchiveForBudgetTest(t,
		archiveTestEntry{name: "manifest.json", data: manifest},
		archiveTestEntry{name: "index.html", data: []byte("<html></html>")},
	)
}

func completedSecurityUpload(t *testing.T, svc *Service, publisherKeyID string, raw []byte) (*domain.UploadSession, string) {
	t.Helper()
	digest := sha256.Sum256(raw)
	shaHex := hex.EncodeToString(digest[:])
	session, err := svc.CreateUploadSession(context.Background(), publisherKeyID, shaHex, int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.ReceiveContent(context.Background(), session.ID, bytes.NewReader(raw)); err != nil {
		t.Fatal(err)
	}
	return session, shaHex
}

func signedSecurityRelease(sessionID, toolID, version, shaHex string, privateKey ed25519.PrivateKey) *ReleaseRequest {
	return &ReleaseRequest{
		UploadSessionID: sessionID, ToolID: toolID, Name: "Security",
		Version: version, Channel: "stable", Platform: "windows", Arch: "x86_64",
		AccessMode: "free", Permissions: []string{},
		PublisherSignature: hex.EncodeToString(ed25519.Sign(privateKey,
			SigningPayload(toolID, version, shaHex))),
	}
}

func TestCreateReleaseVerifiesProofBeforeArchiveAndClaimsOnce(t *testing.T) {
	svc, repo, store, publisherKeyID, privateKey := newPublisherSecurityService(t)
	session, shaHex := completedSecurityUpload(t, svc, publisherKeyID, []byte("not a zip"))
	req := signedSecurityRelease(session.ID, "com.test.preflight", "1.0.0", shaHex, privateKey)
	req.PublisherSignature = strings.Repeat("00", ed25519.SignatureSize)

	if _, err := svc.CreateRelease(context.Background(), req); err == nil {
		t.Fatal("invalid publisher proof must be rejected")
	}
	if store.gets() != 0 {
		t.Fatal("invalid publisher proof must be rejected before staging read/decompression")
	}
	got, err := repo.Uploads().Get(context.Background(), session.ID)
	if err != nil || got == nil || got.Status != domain.UploadCompleted {
		t.Fatalf("proof failure must not consume session: session=%#v err=%v", got, err)
	}

	req = signedSecurityRelease(session.ID, "com.test.preflight", "1.0.0", shaHex, privateKey)
	if _, err := svc.CreateRelease(context.Background(), req); err == nil {
		t.Fatal("valid proof over malformed archive must fail archive inspection")
	}
	if store.gets() != 1 {
		t.Fatalf("valid proof should reach exactly one archive read, got %d", store.gets())
	}
	got, err = repo.Uploads().Get(context.Background(), session.ID)
	if err != nil || got == nil || got.Status != domain.UploadReleaseClaimed {
		t.Fatalf("archive failure must leave one-shot claim consumed: session=%#v err=%v", got, err)
	}
	if _, err := svc.CreateRelease(context.Background(), req); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("repeat release must reject the consumed session: %v", err)
	}
	if store.gets() != 1 {
		t.Fatal("repeat release must fail at atomic claim before another archive read")
	}
}

func TestCreateReleaseConcurrentClaimHasSingleWinner(t *testing.T) {
	svc, repo, _, publisherKeyID, privateKey := newPublisherSecurityService(t)
	raw := securityUsefulArtifact(t, "com.test.concurrent", "1.0.0", []string{})
	session, shaHex := completedSecurityUpload(t, svc, publisherKeyID, raw)
	req := signedSecurityRelease(session.ID, "com.test.concurrent", "1.0.0", shaHex, privateKey)

	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, err := svc.CreateRelease(context.Background(), req)
			results <- err
		}()
	}
	close(start)
	winners, conflicts := 0, 0
	for range 2 {
		err := <-results
		switch {
		case err == nil:
			winners++
		case errors.Is(err, domain.ErrConflict):
			conflicts++
		default:
			t.Fatalf("unexpected concurrent CreateRelease result: %v", err)
		}
	}
	if winners != 1 || conflicts != 1 {
		t.Fatalf("atomic upload claim must have one winner: winners=%d conflicts=%d", winners, conflicts)
	}
	claimed, err := repo.Uploads().Get(context.Background(), session.ID)
	if err != nil || claimed == nil || claimed.ArtifactID == "" {
		t.Fatalf("winning release must bind the claimed session to one artifact: %#v err=%v", claimed, err)
	}
	claimed.ArtifactID = "art_00000000-0000-4000-8000-000000000099"
	if err := repo.Uploads().Update(context.Background(), claimed); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("claimed session artifact ownership must be immutable: %v", err)
	}
}

func TestArchiveSemaphoreAcquisitionHonorsCancellation(t *testing.T) {
	svc := &Service{ArchiveConcurrency: 1}
	release, err := svc.acquireArchivePermit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := svc.acquireArchivePermit(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting for archive capacity must honor cancellation, got %v", err)
	}
}

func TestCreateReleaseManifestIdentityAndPermissionsMatchExactly(t *testing.T) {
	tests := []struct {
		name                string
		manifestID          string
		manifestVersion     string
		manifestPermissions []string
		requestID           string
		requestVersion      string
		requestPermissions  []string
	}{
		{name: "id", manifestID: "com.test.other", manifestVersion: "1.0.0", requestID: "com.test.id", requestVersion: "1.0.0"},
		{name: "version", manifestID: "com.test.version", manifestVersion: "2.0.0", requestID: "com.test.version", requestVersion: "1.0.0"},
		{name: "permissions", manifestID: "com.test.permissions", manifestVersion: "1.0.0", manifestPermissions: []string{"dialog.open"}, requestID: "com.test.permissions", requestVersion: "1.0.0"},
		{name: "noncanonical permissions", manifestID: "com.test.order", manifestVersion: "1.0.0", manifestPermissions: []string{"dialog.save", "dialog.open"}, requestID: "com.test.order", requestVersion: "1.0.0", requestPermissions: []string{"dialog.open", "dialog.save"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc, _, _, publisherKeyID, privateKey := newPublisherSecurityService(t)
			raw := securityUsefulArtifact(t, tc.manifestID, tc.manifestVersion, tc.manifestPermissions)
			session, shaHex := completedSecurityUpload(t, svc, publisherKeyID, raw)
			req := signedSecurityRelease(session.ID, tc.requestID, tc.requestVersion, shaHex, privateKey)
			req.Permissions = tc.requestPermissions
			if _, err := svc.CreateRelease(context.Background(), req); err == nil {
				t.Fatal("manifest and release identity/permissions mismatch must fail closed")
			}
		})
	}
}

func TestRotateKeySynchronizesMemoryPublisherIdentity(t *testing.T) {
	svc, repo, _, oldKeyID, oldPrivateKey := newPublisherSecurityService(t)
	newPublicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	newKeyID := "ed25519:" + hex.EncodeToString(newPublicKey)
	crossSignature := ed25519.Sign(oldPrivateKey, []byte("useful-key-rotation-v1\n"+newKeyID))
	if err := svc.RotateKey(context.Background(), oldKeyID, newKeyID, hex.EncodeToString(crossSignature), "operator"); err != nil {
		t.Fatal(err)
	}
	publisher, err := repo.Publishers().GetByKeyID(context.Background(), newKeyID)
	if err != nil || publisher == nil || publisher.ID != "publisher-security" || publisher.KeyID != newKeyID {
		t.Fatalf("rotated key must resolve to the existing publisher identity: %#v err=%v", publisher, err)
	}
	if _, err := svc.CreateUploadSession(context.Background(), newKeyID, strings.Repeat("ab", 32), 1); err != nil {
		t.Fatalf("rotated key must be usable across the upload chain: %v", err)
	}
}

type signalingMetadataRepo struct {
	inner     repository.MetadataRepo
	attempted chan struct{}
	once      sync.Once
}

func (r *signalingMetadataRepo) AcquirePublishLease(ctx context.Context) (repository.MetadataPublishLease, error) {
	r.once.Do(func() { close(r.attempted) })
	return r.inner.AcquirePublishLease(ctx)
}

type signalingRepository struct {
	repository.Repository
	metadata repository.MetadataRepo
}

func (r *signalingRepository) Metadata() repository.MetadataRepo { return r.metadata }

type metadataReference struct {
	Version int64             `json:"version"`
	Length  int64             `json:"length"`
	Hashes  map[string]string `json:"hashes"`
}

type metadataEnvelope struct {
	Signed struct {
		Version int64                        `json:"version"`
		Meta    map[string]metadataReference `json:"meta"`
		Targets map[string]struct {
			Custom map[string]any `json:"custom"`
		} `json:"targets"`
	} `json:"signed"`
}

func assertMetadataReference(t *testing.T, ref metadataReference, raw []byte) {
	t.Helper()
	digest := sha256.Sum256(raw)
	if ref.Length != int64(len(raw)) || ref.Hashes["sha256"] != hex.EncodeToString(digest[:]) {
		t.Fatalf("metadata reference does not close over bytes: ref=%#v len=%d sha=%s",
			ref, len(raw), hex.EncodeToString(digest[:]))
	}
}

func TestPublishMetadataLeasePreventsDelayedTimestampRollback(t *testing.T) {
	svcA, repo, store, publisherKeyID, privateKey := newPublisherSecurityService(t)
	shaHex := strings.Repeat("ab", 32)
	signature := hex.EncodeToString(ed25519.Sign(privateKey,
		SigningPayload("com.test.metadata", "1.0.0", shaHex)))
	if err := repo.Artifacts().Create(context.Background(), &domain.Artifact{
		ID: "art_00000000-0000-4000-8000-000000000001", PublisherKeyID: publisherKeyID, ToolID: "com.test.metadata",
		Version: "1.0.0", Channel: "stable", Platform: "windows", Arch: "x86_64",
		SHA256: shaHex, Size: 123, Status: domain.ArtifactPublished,
		PublisherSignatureVerified: true, SignatureMethod: "ed25519",
		PublisherSignature: signature, SignatureIdentity: publisherKeyID,
	}); err != nil {
		t.Fatal(err)
	}

	enteredOldWrite := make(chan struct{})
	releaseOldWrite := make(chan struct{})
	var enterOnce sync.Once
	store.beforePut = func(ctx context.Context, key string) error {
		if key != "metadata/100.targets.json" {
			return nil
		}
		enterOnce.Do(func() { close(enteredOldWrite) })
		select {
		case <-releaseOldWrite:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	svcA.Now = func() time.Time { return time.Unix(100, 0).UTC() }

	attempted := make(chan struct{})
	svcB := &Service{
		Repo: &signalingRepository{
			Repository: repo,
			metadata: &signalingMetadataRepo{
				inner: repo.Metadata(), attempted: attempted,
			},
		},
		Store: store, MaxUpload: svcA.MaxUpload,
		TargetsKey: svcA.TargetsKey, SnapshotKey: svcA.SnapshotKey, TimestampKey: svcA.TimestampKey,
		TargetsExpireDays: svcA.TargetsExpireDays, SnapshotExpireDays: svcA.SnapshotExpireDays,
		TimestampExpireDays: svcA.TimestampExpireDays,
		Now:                 func() time.Time { return time.Unix(100, 0).UTC() },
	}

	resultA := make(chan error, 1)
	go func() { resultA <- svcA.PublishMetadata(context.Background()) }()
	select {
	case <-enteredOldWrite:
	case <-time.After(2 * time.Second):
		t.Fatal("older publication did not reach delayed storage write")
	}
	resultB := make(chan error, 1)
	go func() { resultB <- svcB.PublishMetadata(context.Background()) }()
	select {
	case <-attempted:
	case <-time.After(2 * time.Second):
		t.Fatal("concurrent publisher did not attempt repository lease")
	}
	close(releaseOldWrite)
	for name, result := range map[string]<-chan error{"older": resultA, "newer": resultB} {
		select {
		case err := <-result:
			if err != nil {
				t.Fatalf("%s publication failed: %v", name, err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s publication did not finish", name)
		}
	}

	timestampRaw, ok := store.object("metadata/timestamp.json")
	if !ok {
		t.Fatal("final timestamp metadata missing")
	}
	var timestamp metadataEnvelope
	if err := json.Unmarshal(timestampRaw, &timestamp); err != nil {
		t.Fatal(err)
	}
	if timestamp.Signed.Version != 101 {
		t.Fatalf("delayed older publisher rolled timestamp back: version=%d", timestamp.Signed.Version)
	}
	snapshotRef := timestamp.Signed.Meta["snapshot.json"]
	if snapshotRef.Version != 101 {
		t.Fatalf("timestamp must point at highest snapshot version: %#v", snapshotRef)
	}
	snapshotRaw, ok := store.object("metadata/101.snapshot.json")
	if !ok {
		t.Fatal("final versioned snapshot missing")
	}
	assertMetadataReference(t, snapshotRef, snapshotRaw)

	var snapshot metadataEnvelope
	if err := json.Unmarshal(snapshotRaw, &snapshot); err != nil {
		t.Fatal(err)
	}
	targetsRef := snapshot.Signed.Meta["targets.json"]
	if snapshot.Signed.Version != 101 || targetsRef.Version != 101 {
		t.Fatalf("snapshot must point at matching highest targets: version=%d ref=%#v",
			snapshot.Signed.Version, targetsRef)
	}
	targetsRaw, ok := store.object("metadata/101.targets.json")
	if !ok {
		t.Fatal("final versioned targets missing")
	}
	assertMetadataReference(t, targetsRef, targetsRaw)

	var targets metadataEnvelope
	if err := json.Unmarshal(targetsRaw, &targets); err != nil {
		t.Fatal(err)
	}
	if targets.Signed.Version != 101 || len(targets.Signed.Targets) != 1 {
		t.Fatalf("final targets metadata is incoherent: version=%d targets=%d",
			targets.Signed.Version, len(targets.Signed.Targets))
	}
	for targetName, target := range targets.Signed.Targets {
		if len(targetName) != 71 || !strings.HasSuffix(targetName, ".useful") ||
			target.Custom["platform"] != "windows" || target.Custom["arch"] != "x86_64" {
			t.Fatalf("stable target identity/custom fields are incomplete: %s %#v", targetName, target.Custom)
		}
	}
}

func TestMetadataImmutableVersionConflictAllocatesFreshVersion(t *testing.T) {
	svc, repo, store, publisherKeyID, privateKey := newPublisherSecurityService(t)
	shaHex := strings.Repeat("ab", 32)
	signature := hex.EncodeToString(ed25519.Sign(privateKey,
		SigningPayload("com.test.conflict", "1.0.0", shaHex)))
	if err := repo.Artifacts().Create(context.Background(), &domain.Artifact{
		ID: "art_00000000-0000-4000-8000-000000000011", PublisherKeyID: publisherKeyID,
		ToolID: "com.test.conflict", Version: "1.0.0", Channel: "stable",
		Platform: "windows", Arch: "x86_64", SHA256: shaHex, Size: 123,
		Status: domain.ArtifactPublished, PublisherSignatureVerified: true,
		SignatureMethod: "ed25519", PublisherSignature: signature, SignatureIdentity: publisherKeyID,
	}); err != nil {
		t.Fatal(err)
	}
	store.objects["metadata/100.targets.json"] = []byte("attacker-controlled collision")
	svc.Now = func() time.Time { return time.Unix(100, 0).UTC() }
	if err := svc.PublishMetadata(context.Background()); err != nil {
		t.Fatal(err)
	}
	timestampRaw, ok := store.object("metadata/timestamp.json")
	if !ok {
		t.Fatal("timestamp missing")
	}
	var timestamp metadataEnvelope
	if err := json.Unmarshal(timestampRaw, &timestamp); err != nil {
		t.Fatal(err)
	}
	if timestamp.Signed.Version != 101 {
		t.Fatalf("immutable conflict must allocate and rebuild at fresh version, got %d", timestamp.Signed.Version)
	}
	if raw, _ := store.object("metadata/100.targets.json"); string(raw) != "attacker-controlled collision" {
		t.Fatal("conflicting versioned target was overwritten")
	}
}

func TestPublicationIntentsRemainFailClosedAndReplay(t *testing.T) {
	svc, repo, store, publisherKeyID, privateKey := newPublisherSecurityService(t)
	raw := securityUsefulArtifact(t, "com.test.intent", "1.0.0", []string{})
	session, shaHex := completedSecurityUpload(t, svc, publisherKeyID, raw)
	art, err := svc.CreateRelease(context.Background(), signedSecurityRelease(
		session.ID, "com.test.intent", "1.0.0", shaHex, privateKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScan(context.Background(), art.ID); err != nil {
		t.Fatal(err)
	}
	failTimestamp := true
	store.beforePut = func(_ context.Context, key string) error {
		if key == "metadata/timestamp.json" && failTimestamp {
			return errors.New("injected timestamp failure")
		}
		return nil
	}
	if err := svc.Approve(context.Background(), art.ID, "reviewer"); err == nil {
		t.Fatal("failed timestamp switch must leave a durable publish intent")
	}
	pending, err := repo.Artifacts().Get(context.Background(), art.ID)
	if err != nil || pending.Status != domain.ArtifactPublishPending {
		t.Fatalf("publish intent not retained: %#v err=%v", pending, err)
	}
	if published, _ := repo.Artifacts().ListPublished(context.Background()); len(published) != 0 {
		t.Fatal("publish-pending must remain absent from catalog/download candidates")
	}
	if _, ok := store.object(session.StagingKey); !ok {
		t.Fatal("failed publication must retain staging for replay")
	}
	retrySession, retrySHA := completedSecurityUpload(t, svc, publisherKeyID, raw)
	if _, err := svc.CreateRelease(context.Background(), signedSecurityRelease(
		retrySession.ID, "com.test.intent", "1.0.0", retrySHA, privateKey)); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("release gate must detect a pending identity before consuming a new upload: %v", err)
	}
	unconsumed, _ := repo.Uploads().Get(context.Background(), retrySession.ID)
	if unconsumed.Status != domain.UploadCompleted {
		t.Fatalf("pending release gate must not consume replacement upload: %s", unconsumed.Status)
	}
	failTimestamp = false
	if err := svc.Approve(context.Background(), art.ID, "reviewer"); err != nil {
		t.Fatalf("publish-pending replay failed: %v", err)
	}
	published, _ := repo.Artifacts().Get(context.Background(), art.ID)
	if published.Status != domain.ArtifactPublished {
		t.Fatalf("publish intent did not finalize: %s", published.Status)
	}
	if _, ok := store.object(session.StagingKey); ok {
		t.Fatal("successful publication must clear staging")
	}

	failTimestamp = true
	if err := svc.Withdraw(context.Background(), art.ID, "security", "operator"); err == nil {
		t.Fatal("failed withdrawal metadata switch must retain intent")
	}
	withdrawing, _ := repo.Artifacts().Get(context.Background(), art.ID)
	if withdrawing.Status != domain.ArtifactWithdrawPending {
		t.Fatalf("withdraw intent not retained: %s", withdrawing.Status)
	}
	if visible, _ := repo.Artifacts().ListPublished(context.Background()); len(visible) != 0 {
		t.Fatal("withdraw-pending must be excluded from metadata/catalog/download candidates")
	}
	failTimestamp = false
	if err := svc.Withdraw(context.Background(), art.ID, "security", "operator"); err != nil {
		t.Fatalf("withdraw-pending replay failed: %v", err)
	}
	withdrawn, _ := repo.Artifacts().Get(context.Background(), art.ID)
	if withdrawn.Status != domain.ArtifactWithdrawn {
		t.Fatalf("withdraw intent did not finalize: %s", withdrawn.Status)
	}
}

func TestArtifactTargetNameSeparatesPublisherPlatformAndArtifactIdentity(t *testing.T) {
	shaHex := strings.Repeat("ab", 32)
	keyA := "ed25519:" + strings.Repeat("11", ed25519.PublicKeySize)
	keyB := "ed25519:" + strings.Repeat("22", ed25519.PublicKeySize)
	base := domain.Artifact{
		ID: "art_00000000-0000-4000-8000-000000000001", PublisherKeyID: keyA, ToolID: "com.test.target", Version: "1.0.0",
		Platform: "windows", Arch: "x86_64", SHA256: shaHex,
	}
	platform := base
	platform.ID = "art_00000000-0000-4000-8000-000000000002"
	platform.Arch = "aarch64"
	publisher := base
	publisher.ID = "art_00000000-0000-4000-8000-000000000003"
	publisher.PublisherKeyID = keyB

	seen := map[string]bool{}
	for _, artifact := range []*domain.Artifact{&base, &platform, &publisher} {
		name, err := ArtifactTargetName(artifact)
		if err != nil {
			t.Fatal(err)
		}
		if seen[name] || len(name) != 71 || !strings.HasSuffix(name, ".useful") {
			t.Fatalf("target name must be safe and collision-resistant: %q", name)
		}
		seen[name] = true
	}
}

func TestLegacyAndSigstoreArtifactTrustFailWithStableErrors(t *testing.T) {
	legacy := &domain.Artifact{}
	if err := ValidateArtifactPublisherTrust(legacy); err == nil ||
		!strings.Contains(err.Error(), legacyProofRevalidationRequired) {
		t.Fatalf("legacy empty proof must require explicit re-release/revalidation: %v", err)
	}
	emptyEd25519 := &domain.Artifact{
		PublisherSignatureVerified: true,
		SignatureMethod:            "ed25519",
	}
	if err := ValidateArtifactPublisherTrust(emptyEd25519); err == nil ||
		!strings.Contains(err.Error(), legacyProofRevalidationRequired) {
		t.Fatalf("empty Ed25519 proof must require explicit re-release/revalidation: %v", err)
	}
	sigstore := &domain.Artifact{PublisherSignatureVerified: true, SignatureMethod: "sigstore"}
	if err := ValidateArtifactPublisherTrust(sigstore); err == nil ||
		!strings.Contains(err.Error(), firstReleaseSigstoreUnsupported) {
		t.Fatalf("Sigstore artifact must remain unpublishable/installable: %v", err)
	}
}
