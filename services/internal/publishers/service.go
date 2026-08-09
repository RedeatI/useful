// Package publishers 实现上传→校验→（扫描/审核）→发布管线与 TUF metadata 签发。
//
// 上传流程：创建 upload session → 流式上传到 staging → create release：
// 校验大小/SHA-256/包结构 → artifact(staged) → 扫描（worker）→ 审核 →
// CopyToPublished（内容寻址、不可变）→ 重新签发 TUF metadata + 目录。
// 禁止在上传完成前暴露正式下载 URL。
package publishers

import (
	"archive/zip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"useful.dev/source/internal/catalog"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository"
	"useful.dev/source/internal/storage"
	"useful.dev/source/internal/tufmeta"
)

type Service struct {
	Repo    repository.Repository
	Store   storage.Storage
	Catalog *catalog.Service
	// 在线密钥（targets/snapshot/timestamp）；root 私钥不在服务器上
	TargetsKey   *tufmeta.Key
	SnapshotKey  *tufmeta.Key
	TimestampKey *tufmeta.Key
	// metadata 过期窗口（天）
	TargetsExpireDays, SnapshotExpireDays, TimestampExpireDays int
	// 开发模式：扫描通过后自动审核发布
	AutoApprove bool
	MaxUpload   int64
	// ArchiveReadTimeout bounds staging copy, decompression, CRC verification,
	// manifest reads, and native hashing. Zero uses a conservative default.
	ArchiveReadTimeout time.Duration
	ArchiveConcurrency int
	Now                func() time.Time
	// 发布者签名验证器（Ed25519 + 可选 Sigstore）；为 nil 时退化为内置 Ed25519。
	Verifier             PublisherSignatureVerifier
	archiveSemaphoreOnce sync.Once
	archiveSemaphore     chan struct{}
}

const (
	firstReleaseSigstoreUnsupported = "first publication requires an Ed25519 publisher proof; Sigstore artifacts are not installable until an independently verifiable client proof is supported"
	legacyProofRevalidationRequired = "legacy artifact has no independently verifiable publisher proof; explicit re-release or revalidation is required"
)

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

// verifier 返回配置的验证器，未配置时退化为仅 Ed25519（Sigstore fail closed）。
func (s *Service) verifier() PublisherSignatureVerifier {
	if s.Verifier != nil {
		return s.Verifier
	}
	return &DefaultVerifier{}
}

func (s *Service) acquireArchivePermit(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.archiveSemaphoreOnce.Do(func() {
		limit := s.ArchiveConcurrency
		if limit <= 0 {
			limit = 2
		}
		s.archiveSemaphore = make(chan struct{}, limit)
	})
	select {
	case s.archiveSemaphore <- struct{}{}:
		return func() { <-s.archiveSemaphore }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// ---------- 上传会话 ----------

func (s *Service) CreateUploadSession(ctx context.Context, publisherKeyID, declaredSHA string, declaredSize int64) (*domain.UploadSession, error) {
	if !domain.IsPublisherKey(publisherKeyID) {
		return nil, fmt.Errorf("%w: publisherKeyId 非法", domain.ErrInvalidInput)
	}
	if !domain.IsSHA256(declaredSHA) {
		return nil, fmt.Errorf("%w: sha256 非法", domain.ErrInvalidInput)
	}
	if declaredSize <= 0 || declaredSize > s.MaxUpload {
		return nil, fmt.Errorf("%w: 大小非法或超限", domain.ErrInvalidInput)
	}
	if _, err := s.Repo.Publishers().GetByKeyID(ctx, publisherKeyID); err != nil {
		return nil, fmt.Errorf("%w: 未注册的发布者", domain.ErrForbidden)
	}
	sess := &domain.UploadSession{
		ID:             "up_" + uuid.NewString(),
		PublisherKeyID: publisherKeyID,
		DeclaredSHA256: strings.ToLower(declaredSHA),
		DeclaredSize:   declaredSize,
		Status:         domain.UploadOpen,
		CreatedAt:      s.now(),
	}
	sess.StagingKey = storage.StagingKey(sess.ID)
	if err := s.Repo.Uploads().Create(ctx, sess); err != nil {
		return nil, err
	}
	return sess, nil
}

// ReceiveContent 流式接收上传内容到 staging，同时计算 SHA-256（不载入内存）。
func (s *Service) ReceiveContent(ctx context.Context, sessionID string, r io.Reader) error {
	sess, err := s.Repo.Uploads().Get(ctx, sessionID)
	if err != nil {
		return err
	}
	if sess.Status != domain.UploadOpen {
		return fmt.Errorf("%w: 会话已结束", domain.ErrConflict)
	}
	hasher := sha256.New()
	tee := io.TeeReader(io.LimitReader(r, sess.DeclaredSize+1), hasher)
	if err := s.Store.Put(ctx, sess.StagingKey, tee, sess.DeclaredSize); err != nil {
		sess.Status = domain.UploadFailed
		sess.Error = "写入失败"
		_ = s.Repo.Uploads().Update(ctx, sess)
		return err
	}
	got := hex.EncodeToString(hasher.Sum(nil))
	if got != sess.DeclaredSHA256 {
		sess.Status = domain.UploadFailed
		sess.Error = "SHA-256 不匹配"
		_ = s.Repo.Uploads().Update(ctx, sess)
		_ = s.Store.DeleteStaging(ctx, sess.StagingKey)
		return fmt.Errorf("%w: 上传内容 SHA-256 与声明不符", domain.ErrInvalidInput)
	}
	sess.Status = domain.UploadCompleted
	return s.Repo.Uploads().Update(ctx, sess)
}

// ---------- 发布请求 ----------

type ReleaseRequest struct {
	UploadSessionID string   `json:"uploadSessionId"`
	ToolID          string   `json:"toolId"`
	Name            string   `json:"name"`
	Summary         string   `json:"summary"`
	License         string   `json:"license"`
	Version         string   `json:"version"`
	Channel         string   `json:"channel"`
	Platform        string   `json:"platform"`
	Arch            string   `json:"arch"`
	AccessMode      string   `json:"accessMode"`
	ProductID       string   `json:"productId"`
	Permissions     []string `json:"permissions"`
	// 发布者 Ed25519 签名（十六进制），覆盖 (toolId, version, sha256)。
	// 与 Sigstore bundle 必须且只能提供一种。
	PublisherSignature string `json:"publisherSignature"`
	// 可选 Sigstore 身份签名 bundle（JSON），与 Ed25519 签名二选一。
	SigstoreBundle json.RawMessage `json:"sigstoreBundle,omitempty"`
	// Actor is supplied by the authenticated HTTP boundary and is never decoded
	// from the request body. Direct service callers fall back to publisherKeyId.
	Actor string `json:"-"`
}

func (r *ReleaseRequest) validate() error {
	if !domain.IsLowercaseID(r.ToolID) {
		return fmt.Errorf("%w: toolId 非法", domain.ErrInvalidInput)
	}
	if !domain.IsSemver(r.Version) {
		return fmt.Errorf("%w: version 非法", domain.ErrInvalidInput)
	}
	switch r.Channel {
	case "stable", "beta", "nightly":
	default:
		return fmt.Errorf("%w: channel 非法", domain.ErrInvalidInput)
	}
	switch r.Platform {
	case "windows", "macos", "linux":
	default:
		return fmt.Errorf("%w: platform 非法", domain.ErrInvalidInput)
	}
	switch r.Arch {
	case "x86_64", "aarch64":
	default:
		return fmt.Errorf("%w: arch 非法", domain.ErrInvalidInput)
	}
	switch r.AccessMode {
	case "", "free", "entitlement", "external-purchase", "private", "unavailable":
	default:
		return fmt.Errorf("%w: accessMode 非法", domain.ErrInvalidInput)
	}
	if r.Name == "" || len(r.Name) > 200 {
		return fmt.Errorf("%w: name 长度非法", domain.ErrInvalidInput)
	}
	if len(r.Permissions) > 128 {
		return fmt.Errorf("%w: permissions 数量超限", domain.ErrInvalidInput)
	}
	return nil
}

func canonicalPermissions(in []string) ([]string, error) {
	out := append([]string(nil), in...)
	if out == nil {
		out = []string{}
	}
	for _, permission := range out {
		if permission == "" || len(permission) > 128 || strings.TrimSpace(permission) != permission {
			return nil, fmt.Errorf("%w: permission 非 canonical", domain.ErrInvalidInput)
		}
	}
	sort.Strings(out)
	for i := 1; i < len(out); i++ {
		if out[i] == out[i-1] {
			return nil, fmt.Errorf("%w: permission 重复", domain.ErrInvalidInput)
		}
	}
	return out, nil
}

func permissionsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// CreateRelease 校验上传内容并创建 staged artifact + 扫描任务。
func (s *Service) CreateRelease(ctx context.Context, req *ReleaseRequest) (*domain.Artifact, error) {
	if err := req.validate(); err != nil {
		return nil, err
	}
	sess, err := s.Repo.Uploads().Get(ctx, req.UploadSessionID)
	if err != nil {
		return nil, err
	}
	hasEd25519 := req.PublisherSignature != ""
	hasSigstore := len(req.SigstoreBundle) > 0
	if hasEd25519 == hasSigstore {
		return nil, fmt.Errorf("%w: 必须且只能提供 publisherSignature 或 sigstoreBundle", domain.ErrInvalidInput)
	}
	if hasSigstore {
		return nil, fmt.Errorf("%w: %s", domain.ErrForbidden, firstReleaseSigstoreUnsupported)
	}
	if !domain.IsEd25519PublisherKey(sess.PublisherKeyID) {
		return nil, fmt.Errorf("%w: first publication publisherKeyId must be canonical Ed25519", domain.ErrInvalidInput)
	}
	if err := VerifyPublisherSignature(sess.PublisherKeyID, req.ToolID, req.Version, sess.DeclaredSHA256, req.PublisherSignature); err != nil {
		return nil, fmt.Errorf("%w: 发布者签名无效: %v", domain.ErrInvalidInput, err)
	}
	rawSignature, err := hex.DecodeString(req.PublisherSignature)
	if err != nil || len(rawSignature) != ed25519.SignatureSize {
		return nil, fmt.Errorf("%w: 发布者签名格式非法", domain.ErrInvalidInput)
	}
	verifiedSignature := hex.EncodeToString(rawSignature)
	permissions, err := canonicalPermissions(req.Permissions)
	if err != nil {
		return nil, err
	}
	if !permissionsEqual(req.Permissions, permissions) {
		return nil, fmt.Errorf("%w: permissions 必须按 canonical 顺序提交", domain.ErrInvalidInput)
	}
	if existing, lookupErr := s.Repo.Artifacts().GetByIdentity(ctx, sess.PublisherKeyID, req.ToolID,
		req.Version, req.Platform, req.Arch); lookupErr == nil {
		if existing.Status == domain.ArtifactPublishPending || existing.Status == domain.ArtifactWithdrawPending {
			return nil, fmt.Errorf("%w: release identity has a pending publication intent; reconcile it before re-release", domain.ErrConflict)
		}
	} else if !errors.Is(lookupErr, domain.ErrNotFound) {
		return nil, lookupErr
	}

	workCtx, cancel := s.archiveContext(ctx)
	defer cancel()
	releasePermit, err := s.acquireArchivePermit(workCtx)
	if err != nil {
		return nil, err
	}
	defer releasePermit()
	sess, err = s.Repo.Uploads().ClaimCompleted(workCtx, req.UploadSessionID)
	if err != nil {
		return nil, fmt.Errorf("%w: upload session already claimed or not completed", err)
	}

	// Publisher proof and the one-shot session claim are complete before any ZIP
	// bytes are copied or decompressed.
	manifestDigest, err := s.inspectPackage(workCtx, sess.StagingKey, sess.DeclaredSize, req, permissions)
	if err != nil {
		return nil, fmt.Errorf("%w: 包检查失败: %v", domain.ErrInvalidInput, err)
	}

	now := s.now()
	tool := &domain.Tool{
		PublisherKeyID: sess.PublisherKeyID,
		ToolID:         req.ToolID,
		Name:           req.Name,
		Summary:        req.Summary,
		License:        req.License,
		AccessMode:     req.AccessMode,
		ProductID:      req.ProductID,
		CreatedAt:      now,
	}
	if tool.AccessMode == "" {
		tool.AccessMode = "free"
	}
	if err := s.Repo.Tools().Upsert(ctx, tool); err != nil {
		return nil, err
	}
	artifactID := "art_" + uuid.NewString()
	art := &domain.Artifact{
		ID:                         artifactID,
		PublisherKeyID:             sess.PublisherKeyID,
		ToolID:                     req.ToolID,
		Version:                    req.Version,
		Channel:                    req.Channel,
		Platform:                   req.Platform,
		Arch:                       req.Arch,
		SHA256:                     sess.DeclaredSHA256,
		ManifestDigest:             manifestDigest,
		Size:                       sess.DeclaredSize,
		FileName:                   artifactID + ".useful",
		Permissions:                permissions,
		Status:                     domain.ArtifactStaged,
		CreatedAt:                  now,
		PublisherSignatureVerified: true,
		SignatureMethod:            "ed25519",
		PublisherSignature:         verifiedSignature,
		SignatureIdentity:          sess.PublisherKeyID,
	}
	if art.Permissions == nil {
		art.Permissions = []string{}
	}
	if err := s.Repo.Artifacts().Create(ctx, art); err != nil {
		return nil, err
	}
	sess.ArtifactID = art.ID
	if err := s.Repo.Uploads().Update(ctx, sess); err != nil {
		return nil, err
	}

	// 扫描任务进队列（worker 处理，与主 API 分离）
	payload, _ := json.Marshal(map[string]string{"artifactId": art.ID})
	if err := s.Repo.Jobs().Enqueue(ctx, &domain.Job{
		ID: "job_" + uuid.NewString(), Kind: "scan-artifact",
		Payload: string(payload), Status: domain.JobQueued,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		return nil, err
	}
	actor := req.Actor
	if actor == "" {
		actor = sess.PublisherKeyID
	}
	_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
		At: now, Actor: actor, Action: "release.created",
		Detail: fmt.Sprintf("%s@%s", req.ToolID, req.Version),
	})
	return art, nil
}

// inspectPackage 隔离区内检查 .useful：ZIP 可读、含 manifest.json、无绝对路径/..，
// 返回 manifest.json 的 SHA-256。流式落临时文件，不载入内存。
func (s *Service) inspectPackage(ctx context.Context, stagingKey string, expectedSize int64, req *ReleaseRequest, permissions []string) (string, error) {
	var manifestDigest string
	err := s.withArchive(ctx, stagingKey, "useful-inspect-*", expectedSize, func(ctx context.Context, zr *zip.Reader) error {
		contents, err := readArchiveContents(ctx, zr)
		if err != nil {
			return err
		}
		manifest := contents.parsedManifest
		if manifest.SchemaVersion != 1 || manifest.ID != req.ToolID || manifest.Version != req.Version {
			return fmt.Errorf("manifest id/version/schema 与 release 请求不匹配")
		}
		manifestPermissions, err := canonicalPermissions(manifest.Permissions)
		if err != nil || !permissionsEqual(manifestPermissions, permissions) ||
			!permissionsEqual(manifest.Permissions, manifestPermissions) {
			return fmt.Errorf("manifest permissions 与 release 请求不匹配")
		}
		h := sha256.Sum256(contents.manifest)
		manifestDigest = hex.EncodeToString(h[:])
		return nil
	})
	if err != nil {
		return "", err
	}
	return manifestDigest, nil
}

// scanPackage 隔离区内深度扫描 .useful，产出各独立检查项（供 worker 使用）。
// 检查：ZIP 结构/路径安全、manifest 可解析、权限白名单、原生 worker 检测、
// 可执行文件哈希、SBOM 存在性。不在 source-server 主机运行任何上传程序。
func (s *Service) scanPackage(ctx context.Context, stagingKey string, expectedSize int64, declaredPerms []string) (*domain.ScanResult, error) {
	workCtx, cancel := s.archiveContext(ctx)
	defer cancel()
	releasePermit, err := s.acquireArchivePermit(workCtx)
	if err != nil {
		return nil, err
	}
	defer releasePermit()
	res := &domain.ScanResult{StructureSafe: true, PermissionsReviewed: true}
	var manifest packageManifest
	err = s.withArchive(workCtx, stagingKey, "useful-scan-*", expectedSize, func(ctx context.Context, zr *zip.Reader) error {
		contents, err := readArchiveContents(ctx, zr)
		if err != nil {
			return err
		}
		manifest = contents.parsedManifest
		res.IsNativeWorker = contents.isNativeWorker
		res.ExecutableHashes = contents.executableHashes
		res.HasSBOM = contents.hasSBOM
		return nil
	})
	if err != nil {
		return nil, err
	}

	// readArchiveContents already decoded the closed-world manifest and checked
	// the worker entry ledger before returning.
	res.ManifestValid = true
	if manifest.Entry.Type == "worker" {
		res.IsNativeWorker = true
	}
	// 权限白名单审查（声明的权限须在已知集合）
	for _, p := range declaredPerms {
		if !isKnownPermission(p) {
			res.PermissionsReviewed = false
			res.Findings = append(res.Findings, "未知权限: "+p)
		}
	}
	res.Passed = res.StructureSafe && res.ManifestValid && res.PermissionsReviewed
	return res, nil
}

// isKnownPermission 与客户端 permissions 模型一致的白名单。
func isKnownPermission(p string) bool {
	return p == "process.launch.declared"
}

// RecordReproVerification 记录复现构建验证结果（策略 A/B 之一验证成功后调用）。
// 只有真实验证通过（ReproVerified）才使 catalog 的 reproducibleBuildVerified 为 true。
func (s *Service) RecordReproVerification(ctx context.Context, artifactID string, res ReproResult) error {
	art, err := s.Repo.Artifacts().Get(ctx, artifactID)
	if err != nil {
		return err
	}
	art.ReproStatus = string(res.Status)
	art.ReproStrategy = res.Strategy
	if err := s.Repo.Artifacts().Update(ctx, art); err != nil {
		return err
	}
	_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
		At: s.now(), Actor: "repro-verifier", Action: "artifact.repro_" + string(res.Status),
		Detail: fmt.Sprintf("%s strategy=%s policy=%s %s", artifactID, res.Strategy, res.PolicyVersion, res.FailureReason),
	})
	// verified 影响 catalog 推导，需重签 metadata 让快照携带最新状态
	if art.Status == domain.ArtifactPublished {
		return s.PublishMetadata(ctx)
	}
	return nil
}

// ---------- 扫描 / 审核 / 发布 ----------

// RunScan worker 侧扫描（与主 API 分离）：静态检查 → 写入各独立状态字段。
// 结构/manifest/权限检查不过→拒绝（rejected）；通过→scanned。
// 开发模式 AutoApprove 时，非原生 worker 直接发布；原生 worker 仍需人工审核。
func (s *Service) RunScan(ctx context.Context, artifactID string) error {
	art, err := s.Repo.Artifacts().Get(ctx, artifactID)
	if err != nil {
		return err
	}
	if art.Status != domain.ArtifactStaged {
		return nil // 幂等
	}
	sess, err := s.findSession(ctx, artifactID)
	if err != nil {
		return err
	}
	result, err := s.scanPackage(ctx, sess.StagingKey, sess.DeclaredSize, art.Permissions)
	if err != nil {
		return err
	}
	resultJSON, _ := json.Marshal(result)
	art.ScanResultJSON = string(resultJSON)
	art.IsNativeWorker = result.IsNativeWorker
	art.SecurityScanPassed = result.Passed
	if result.HasSBOM {
		art.SBOMDigest = sha256Hex([]byte(art.SHA256)) // SBOM 位于包内，摘要以制品为锚记录存在性
	}

	now := s.now()
	if !result.Passed {
		art.Status = domain.ArtifactRejected
		_ = s.Repo.Artifacts().Update(ctx, art)
		_ = s.Store.DeleteStaging(ctx, sess.StagingKey)
		_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
			At: now, Actor: "worker", Action: "artifact.scan_failed",
			Detail: fmt.Sprintf("%s: %v", artifactID, result.Findings),
		})
		return nil
	}
	art.Status = domain.ArtifactScanned
	if err := s.Repo.Artifacts().Update(ctx, art); err != nil {
		return err
	}
	_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
		At: now, Actor: "worker", Action: "artifact.scanned",
		Detail: fmt.Sprintf("%s nativeWorker=%v", artifactID, result.IsNativeWorker),
	})
	// 未审核原生 worker 不得公开发布：即便开发 AutoApprove 也不自动发布
	if s.AutoApprove && !result.IsNativeWorker {
		return s.Approve(ctx, artifactID, "auto-approve(dev)")
	}
	return nil
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// ValidateArtifactPublisherTrust is the shared server-side install/publish
// gate. It intentionally accepts only independently verifiable Ed25519 proof.
func ValidateArtifactPublisherTrust(art *domain.Artifact) error {
	if art == nil {
		return fmt.Errorf("%w: publisher proof artifact is missing", domain.ErrForbidden)
	}
	// Legacy rows and partially backfilled Ed25519 rows must receive the same
	// explicit operational remediation, before method-specific parsing.
	if !art.PublisherSignatureVerified ||
		(art.SignatureMethod != "sigstore" && art.PublisherSignature == "") {
		return fmt.Errorf("%w: %s", domain.ErrForbidden, legacyProofRevalidationRequired)
	}
	switch art.SignatureMethod {
	case "ed25519":
		if !domain.IsEd25519PublisherKey(art.PublisherKeyID) || !domain.IsLowercaseID(art.ToolID) ||
			!domain.IsSemver(art.Version) || !domain.IsSHA256(art.SHA256) ||
			art.PublisherSignature == "" || art.PublisherSignature != strings.ToLower(art.PublisherSignature) ||
			art.SignatureIdentity != art.PublisherKeyID {
			return fmt.Errorf("%w: Ed25519 publisher proof 元数据不一致", domain.ErrForbidden)
		}
		if err := VerifyPublisherSignature(art.PublisherKeyID, art.ToolID, art.Version, art.SHA256, art.PublisherSignature); err != nil {
			return fmt.Errorf("%w: Ed25519 publisher proof 无效", domain.ErrForbidden)
		}
	case "sigstore":
		return fmt.Errorf("%w: %s", domain.ErrForbidden, firstReleaseSigstoreUnsupported)
	default:
		return fmt.Errorf("%w: publisher proof method 非法", domain.ErrForbidden)
	}
	return nil
}

// ArtifactTargetName returns the collision-resistant logical target path: the
// digest of the full stable artifact identity. HTTP adds the content digest
// exactly once when serving the consistent-snapshot path.
func ArtifactTargetName(art *domain.Artifact) (string, error) {
	if art == nil {
		return "", fmt.Errorf("%w: artifact identity is missing", domain.ErrInvalidInput)
	}
	canonicalArtifactID := false
	if strings.HasPrefix(art.ID, "art_") && len(art.ID) == len("art_")+36 {
		if parsed, err := uuid.Parse(art.ID[len("art_"):]); err == nil && "art_"+parsed.String() == art.ID {
			canonicalArtifactID = true
		}
	}
	validPlatform := art.Platform == "windows" || art.Platform == "macos" || art.Platform == "linux"
	validArch := art.Arch == "x86_64" || art.Arch == "aarch64"
	if !domain.IsSHA256(art.SHA256) || !domain.IsPublisherKey(art.PublisherKeyID) ||
		!domain.IsLowercaseID(art.ToolID) || !domain.IsSemver(art.Version) ||
		!validPlatform || !validArch || !canonicalArtifactID {
		return "", fmt.Errorf("%w: artifact identity is not canonical", domain.ErrInvalidInput)
	}
	identity, err := json.Marshal([]string{
		art.PublisherKeyID, art.ToolID, art.Version, art.Platform, art.Arch, art.ID,
	})
	if err != nil {
		return "", err
	}
	identityDigest := sha256.Sum256(identity)
	return hex.EncodeToString(identityDigest[:]) + ".useful", nil
}

func (s *Service) withMetadataPublishLease(ctx context.Context, fn func(repository.MetadataPublishLease) error) (retErr error) {
	lease, err := s.Repo.Metadata().AcquirePublishLease(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if releaseErr := lease.Release(); releaseErr != nil {
			retErr = errors.Join(retErr, fmt.Errorf("release metadata publish lease: %w", releaseErr))
		}
	}()
	return fn(lease)
}

// Approve persists publish-pending before switching TUF metadata. Retries of a
// pending intent are idempotent and replay the complete publication.
func (s *Service) Approve(ctx context.Context, artifactID, reviewer string) error {
	var finalized *domain.Artifact
	err := s.withMetadataPublishLease(ctx, func(lease repository.MetadataPublishLease) error {
		art, err := s.Repo.Artifacts().Get(ctx, artifactID)
		if err != nil {
			return err
		}
		switch art.Status {
		case domain.ArtifactPublished:
			return nil
		case domain.ArtifactScanned:
			if err := ValidateArtifactPublisherTrust(art); err != nil {
				return err
			}
			sess, err := s.findSession(ctx, artifactID)
			if err != nil {
				return err
			}
			if err := s.Store.CopyToPublished(ctx, sess.StagingKey, storage.PublishedKey(art.SHA256)); err != nil {
				return err
			}
			now := s.now()
			art.OfficialReviewPassed = true
			art.Status = domain.ArtifactPublishPending
			art.PublishedAt = &now
			if err := s.Repo.Artifacts().Update(ctx, art); err != nil {
				return err
			}
			_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
				At: now, Actor: reviewer, Action: "artifact.publish_pending",
				Detail: fmt.Sprintf("%s@%s", art.ToolID, art.Version),
			})
		case domain.ArtifactPublishPending:
			if err := ValidateArtifactPublisherTrust(art); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%w: 仅扫描通过或 publish-pending 制品可审核发布", domain.ErrConflict)
		}
		if err := s.publishMetadataLocked(ctx, lease); err != nil {
			return err
		}
		finalized, err = s.Repo.Artifacts().Get(ctx, artifactID)
		return err
	})
	if err != nil {
		return err
	}
	if finalized != nil && finalized.Status == domain.ArtifactPublished {
		_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
			At: s.now(), Actor: reviewer, Action: "artifact.published",
			Detail: fmt.Sprintf("%s@%s", finalized.ToolID, finalized.Version),
		})
	}
	return nil
}

// Withdraw 撤回已发布制品（记录保留，置 withdrawn）。
// 撤回后新用户无法下载（download-grant 拒绝）；可选同时发布安全公告。
func (s *Service) Withdraw(ctx context.Context, artifactID, reason, actor string) error {
	var finalized *domain.Artifact
	err := s.withMetadataPublishLease(ctx, func(lease repository.MetadataPublishLease) error {
		art, err := s.Repo.Artifacts().Get(ctx, artifactID)
		if err != nil {
			return err
		}
		switch art.Status {
		case domain.ArtifactWithdrawn:
			return nil
		case domain.ArtifactPublished:
			art.Status = domain.ArtifactWithdrawPending
			if err := s.Repo.Artifacts().Update(ctx, art); err != nil {
				return err
			}
			_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
				At: s.now(), Actor: actor, Action: "artifact.withdraw_pending",
				Detail: fmt.Sprintf("%s@%s %s", art.ToolID, art.Version, reason),
			})
		case domain.ArtifactWithdrawPending:
			// Replay an already durable withdrawal intent.
		default:
			return fmt.Errorf("%w: 仅已发布或 withdraw-pending 制品可撤回", domain.ErrConflict)
		}
		if err := s.publishMetadataLocked(ctx, lease); err != nil {
			return err
		}
		finalized, err = s.Repo.Artifacts().Get(ctx, artifactID)
		return err
	})
	if err != nil {
		return err
	}
	if finalized != nil && finalized.Status == domain.ArtifactWithdrawn {
		_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
			At: s.now(), Actor: actor, Action: "artifact.withdrawn",
			Detail: fmt.Sprintf("%s@%s %s", finalized.ToolID, finalized.Version, reason),
		})
	}
	return nil
}

// CreateAdvisory 发布安全公告（已安装用户可见）。
func (s *Service) CreateAdvisory(ctx context.Context, a *domain.SecurityAdvisory, actor string) error {
	if !domain.IsPublisherKey(a.PublisherKeyID) || !domain.IsLowercaseID(a.ToolID) {
		return fmt.Errorf("%w: 公告身份非法", domain.ErrInvalidInput)
	}
	switch a.Severity {
	case domain.SeverityLow, domain.SeverityMedium, domain.SeverityHigh, domain.SeverityCritical:
	default:
		return fmt.Errorf("%w: 非法严重级别", domain.ErrInvalidInput)
	}
	if a.Summary == "" || len(a.Summary) > 2000 {
		return fmt.Errorf("%w: summary 长度非法", domain.ErrInvalidInput)
	}
	a.ID = "adv_" + uuid.NewString()
	a.CreatedAt = s.now()
	if a.AffectedVersions == nil {
		a.AffectedVersions = []string{}
	}
	if err := s.Repo.Advisories().Create(ctx, a); err != nil {
		return err
	}
	_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
		At: s.now(), Actor: actor, Action: "advisory.created",
		Detail: fmt.Sprintf("%s %s", a.ToolID, a.Severity),
	})
	// 公告直接进 catalog 条目：失效缓存让已安装用户尽快可见
	if s.Catalog != nil {
		s.Catalog.Invalidate()
	}
	return nil
}

// RotateKey 登记发布者密钥轮换：新密钥必须被现有受信密钥交叉签名。
// 无法证明连续性时拒绝（调用方应改为“新发布者”路径，不继承信誉）。
func (s *Service) RotateKey(ctx context.Context, oldKeyID, newKeyID, crossSig, actor string) error {
	old, err := s.Repo.Publishers().GetKey(ctx, oldKeyID)
	if err != nil {
		return fmt.Errorf("%w: 旧密钥未登记", domain.ErrForbidden)
	}
	if err := VerifyKeyRotation(oldKeyID, newKeyID, crossSig); err != nil {
		return fmt.Errorf("%w: %v", domain.ErrForbidden, err)
	}
	k := &domain.PublisherKey{
		KeyID:       newKeyID,
		PublisherID: old.PublisherID,
		PublicKey:   strings.TrimPrefix(newKeyID, "ed25519:"),
		RotatedFrom: oldKeyID,
		CreatedAt:   s.now(),
	}
	if err := s.Repo.Publishers().AddKey(ctx, k); err != nil {
		return err
	}
	_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
		At: s.now(), Actor: actor, Action: "publisher.key_rotated",
		Detail: fmt.Sprintf("%s -> %s", oldKeyID, newKeyID),
	})
	return nil
}

// Reject 审核拒绝（记录保留，staging 清理）。
func (s *Service) Reject(ctx context.Context, artifactID, reviewer, note string) error {
	if err := s.Repo.Artifacts().UpdateStatus(ctx, artifactID, domain.ArtifactRejected, nil); err != nil {
		return err
	}
	if sess, err := s.findSession(ctx, artifactID); err == nil {
		_ = s.Store.DeleteStaging(ctx, sess.StagingKey)
	}
	_ = s.Repo.Audit().Append(ctx, &domain.AuditEvent{
		At: s.now(), Actor: reviewer, Action: "artifact.rejected", Detail: artifactID + " " + note,
	})
	return nil
}

func (s *Service) findSession(ctx context.Context, artifactID string) (*domain.UploadSession, error) {
	return s.Repo.Uploads().GetByArtifact(ctx, artifactID)
}

// ---------- TUF metadata 签发 ----------

// PublishMetadata 依据全部已发布与 publish-pending 制品重签 metadata；
// withdraw-pending 明确排除。成功切换 timestamp 后才 finalize pending intents。
// root(1.root.json) 由离线流程（或开发 init）预置在 storage 的 metadata/1.root.json。
func (s *Service) PublishMetadata(ctx context.Context) error {
	return s.withMetadataPublishLease(ctx, func(lease repository.MetadataPublishLease) error {
		return s.publishMetadataLocked(ctx, lease)
	})
}

// ReconcilePublications replays durable publish/withdraw intents. It is safe to
// call at startup and from an explicit repair endpoint/job.
func (s *Service) ReconcilePublications(ctx context.Context) error {
	publishing, err := s.Repo.Artifacts().ListByStatus(ctx, domain.ArtifactPublishPending)
	if err != nil {
		return err
	}
	withdrawing, err := s.Repo.Artifacts().ListByStatus(ctx, domain.ArtifactWithdrawPending)
	if err != nil {
		return err
	}
	if len(publishing) == 0 && len(withdrawing) == 0 {
		return nil
	}
	return s.PublishMetadata(ctx)
}

const maxMetadataVersionAttempts = 16

func (s *Service) publishMetadataLocked(ctx context.Context, lease repository.MetadataPublishLease) error {
	arts, err := s.Repo.Artifacts().ListPublished(ctx)
	if err != nil {
		return err
	}
	publishPending, err := s.Repo.Artifacts().ListByStatus(ctx, domain.ArtifactPublishPending)
	if err != nil {
		return err
	}
	withdrawPending, err := s.Repo.Artifacts().ListByStatus(ctx, domain.ArtifactWithdrawPending)
	if err != nil {
		return err
	}
	arts = append(arts, publishPending...)
	targets := map[string]tufmeta.TargetEntry{}
	for _, a := range arts {
		if err := ValidateArtifactPublisherTrust(a); err != nil {
			return err
		}
		targetName, err := ArtifactTargetName(a)
		if err != nil {
			return err
		}
		if _, exists := targets[targetName]; exists {
			return fmt.Errorf("%w: duplicate stable artifact target identity", domain.ErrConflict)
		}
		targets[targetName] = tufmeta.TargetEntry{
			Length: a.Size,
			SHA256: a.SHA256,
			Custom: map[string]any{
				"publisherKeyId":                   a.PublisherKeyID,
				"toolId":                           a.ToolID,
				"version":                          a.Version,
				"channel":                          a.Channel,
				"platform":                         a.Platform,
				"arch":                             a.Arch,
				"artifactSha256":                   a.SHA256,
				"publisherSignatureVerified":       a.PublisherSignatureVerified,
				"publisherSignatureMethod":         a.SignatureMethod,
				"publisherSignaturePayloadVersion": "useful-artifact-v1",
				"publisherSignature":               a.PublisherSignature,
				"signatureIdentity":                a.SignatureIdentity,
			},
		}
	}
	now := s.now()
	candidateVersion := now.Unix()
	if candidateVersion < 1 {
		candidateVersion = 1
	}
	written := false
	for attempt := 0; attempt < maxMetadataVersionAttempts; attempt++ {
		ver, err := lease.NextVersion(ctx, candidateVersion)
		if err != nil {
			return err
		}
		tgtSigned := tufmeta.BuildTargets(ver, tufmeta.ExpiresIn(s.TargetsExpireDays, now), targets)
		tgtBytes, err := tufmeta.Sign(tgtSigned, s.TargetsKey)
		if err != nil {
			return err
		}
		snapSigned := tufmeta.BuildSnapshot(ver, tufmeta.ExpiresIn(s.SnapshotExpireDays, now), tgtBytes, ver)
		snapBytes, err := tufmeta.Sign(snapSigned, s.SnapshotKey)
		if err != nil {
			return err
		}
		tsSigned := tufmeta.BuildTimestamp(ver, tufmeta.ExpiresIn(s.TimestampExpireDays, now), snapBytes, ver)
		tsBytes, err := tufmeta.Sign(tsSigned, s.TimestampKey)
		if err != nil {
			return err
		}

		putImmutable := func(name string, b []byte) error {
			return s.Store.PutIfAbsentOrSame(ctx, "metadata/"+name, strings.NewReader(string(b)), int64(len(b)))
		}
		if err := putImmutable(fmt.Sprintf("%d.targets.json", ver), tgtBytes); err != nil {
			if errors.Is(err, storage.ErrObjectConflict) {
				continue
			}
			return err
		}
		if err := putImmutable(fmt.Sprintf("%d.snapshot.json", ver), snapBytes); err != nil {
			if errors.Is(err, storage.ErrObjectConflict) {
				continue
			}
			return err
		}
		// timestamp is the single atomic mutable pointer and is written last.
		if err := s.Store.Put(ctx, "metadata/timestamp.json", strings.NewReader(string(tsBytes)), int64(len(tsBytes))); err != nil {
			return err
		}
		written = true
		break
	}
	if !written {
		return fmt.Errorf("%w: metadata version namespace repeatedly conflicted", domain.ErrConflict)
	}

	for _, art := range publishPending {
		sess, err := s.findSession(ctx, art.ID)
		if err != nil {
			return fmt.Errorf("finalize publish intent %s: %w", art.ID, err)
		}
		if err := s.Store.DeleteStaging(ctx, sess.StagingKey); err != nil {
			return fmt.Errorf("clear publish staging %s: %w", art.ID, err)
		}
		publishedAt := art.PublishedAt
		if publishedAt == nil {
			t := now
			publishedAt = &t
		}
		if err := s.Repo.Artifacts().UpdateStatus(ctx, art.ID, domain.ArtifactPublished, publishedAt); err != nil {
			return fmt.Errorf("finalize publish intent %s: %w", art.ID, err)
		}
	}
	for _, art := range withdrawPending {
		if err := s.Repo.Artifacts().UpdateStatus(ctx, art.ID, domain.ArtifactWithdrawn, nil); err != nil {
			return fmt.Errorf("finalize withdraw intent %s: %w", art.ID, err)
		}
	}
	// 发布状态已变更（发布/撤回/复现验证均经过这里）：失效 catalog 缓存
	if s.Catalog != nil {
		s.Catalog.Invalidate()
	}
	return nil
}
