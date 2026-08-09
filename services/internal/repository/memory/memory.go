// Package memory 提供内存仓库实现（开发与单元测试）。
// 语义与 postgres 实现一致：唯一约束、幂等、乱序防护、append-only 审计。
package memory

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository"
)

type Store struct {
	mu sync.Mutex

	publishers    map[string]*domain.Publisher // keyID → publisher
	tools         map[string]*domain.Tool      // pubKey+"\x00"+toolID
	artifacts     map[string]*domain.Artifact  // id
	artIdentityIx map[string]string            // identity+ver+platform+arch → artifactID（唯一约束索引）
	uploads       map[string]*domain.UploadSession
	entitlements  map[string]*domain.Entitlement // id
	grants        map[string]*domain.DownloadGrant
	billingEvents map[string]*domain.BillingEvent
	subscriptions map[string]*domain.Subscription
	audit         []*domain.AuditEvent
	jobs          map[string]*domain.Job
	advisories    []*domain.SecurityAdvisory
	pubKeys       map[string]*domain.PublisherKey      // keyID → key
	identities    map[string]*domain.Identity          // id → identity
	apiTokens     map[string]*domain.APIToken          // id → token
	availability  map[string]*domain.AvailabilityCheck // artifactSHA256 → 最新检查
	auditSeq      int64
	tufVersion    int64
	metadataLease chan struct{}
}

func New() *Store {
	return &Store{
		publishers:    map[string]*domain.Publisher{},
		tools:         map[string]*domain.Tool{},
		artifacts:     map[string]*domain.Artifact{},
		artIdentityIx: map[string]string{},
		uploads:       map[string]*domain.UploadSession{},
		entitlements:  map[string]*domain.Entitlement{},
		grants:        map[string]*domain.DownloadGrant{},
		billingEvents: map[string]*domain.BillingEvent{},
		subscriptions: map[string]*domain.Subscription{},
		jobs:          map[string]*domain.Job{},
		pubKeys:       map[string]*domain.PublisherKey{},
		identities:    map[string]*domain.Identity{},
		apiTokens:     map[string]*domain.APIToken{},
		availability:  map[string]*domain.AvailabilityCheck{},
		metadataLease: make(chan struct{}, 1),
	}
}

func (s *Store) Publishers() repository.PublisherRepo      { return (*publisherRepo)(s) }
func (s *Store) Tools() repository.ToolRepo                { return (*toolRepo)(s) }
func (s *Store) Artifacts() repository.ArtifactRepo        { return (*artifactRepo)(s) }
func (s *Store) Uploads() repository.UploadRepo            { return (*uploadRepo)(s) }
func (s *Store) Entitlements() repository.EntitlementRepo  { return (*entitlementRepo)(s) }
func (s *Store) Grants() repository.GrantRepo              { return (*grantRepo)(s) }
func (s *Store) Billing() repository.BillingRepo           { return (*billingRepo)(s) }
func (s *Store) Audit() repository.AuditRepo               { return (*auditRepo)(s) }
func (s *Store) Jobs() repository.JobRepo                  { return (*jobRepo)(s) }
func (s *Store) Advisories() repository.AdvisoryRepo       { return (*advisoryRepo)(s) }
func (s *Store) Identities() repository.IdentityRepo       { return (*identityRepo)(s) }
func (s *Store) Availability() repository.AvailabilityRepo { return (*availabilityRepo)(s) }
func (s *Store) Metadata() repository.MetadataRepo         { return (*metadataRepo)(s) }
func (s *Store) Ping(context.Context) error                { return nil }

func toolKey(pub, tool string) string { return pub + "\x00" + tool }

// artIdentityKey 制品唯一约束键：tool identity + version + platform + arch。
func artIdentityKey(a *domain.Artifact) string {
	return a.PublisherKeyID + "\x00" + a.ToolID + "\x00" + a.Version + "\x00" + a.Platform + "\x00" + a.Arch
}

// ---------- identities / api tokens ----------

type availabilityRepo Store

func (r *availabilityRepo) Upsert(_ context.Context, c *domain.AvailabilityCheck) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := *c
	r.availability[c.ArtifactSHA256] = &cp
	return nil
}

func (r *availabilityRepo) Get(_ context.Context, sha string) (*domain.AvailabilityCheck, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.availability[sha]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *c
	return &cp, nil
}

func (r *availabilityRepo) ListAll(_ context.Context) ([]*domain.AvailabilityCheck, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.AvailabilityCheck, 0, len(r.availability))
	for _, c := range r.availability {
		cp := *c
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ArtifactSHA256 < out[j].ArtifactSHA256 })
	return out, nil
}

type identityRepo Store

func (r *identityRepo) CreateIdentity(_ context.Context, id *domain.Identity) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.identities[id.ID]; ok {
		return domain.ErrConflict
	}
	cp := *id
	r.identities[id.ID] = &cp
	return nil
}

func (r *identityRepo) GetIdentity(_ context.Context, id string) (*domain.Identity, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.identities[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *v
	return &cp, nil
}

func (r *identityRepo) ListIdentities(_ context.Context) ([]*domain.Identity, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.Identity, 0, len(r.identities))
	for _, v := range r.identities {
		cp := *v
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (r *identityRepo) CreateToken(_ context.Context, t *domain.APIToken) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.apiTokens[t.ID]; ok {
		return domain.ErrConflict
	}
	for _, e := range r.apiTokens {
		if e.TokenHash == t.TokenHash {
			return domain.ErrConflict
		}
	}
	cp := *t
	r.apiTokens[t.ID] = &cp
	return nil
}

func (r *identityRepo) GetTokenByHash(_ context.Context, hash string) (*domain.APIToken, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.apiTokens {
		if t.TokenHash == hash {
			cp := *t
			return &cp, nil
		}
	}
	return nil, domain.ErrNotFound
}

func (r *identityRepo) ListTokensByIdentity(_ context.Context, identityID string) ([]*domain.APIToken, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []*domain.APIToken{}
	for _, t := range r.apiTokens {
		if t.IdentityID == identityID {
			cp := *t
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (r *identityRepo) RevokeToken(_ context.Context, tokenID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.apiTokens[tokenID]
	if !ok {
		return domain.ErrNotFound
	}
	t.Revoked = true
	return nil
}

func (r *identityRepo) TouchToken(_ context.Context, tokenID string, at time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.apiTokens[tokenID]
	if !ok {
		return domain.ErrNotFound
	}
	cp := at
	t.LastUsedAt = &cp
	return nil
}

// ---------- publishers ----------

type publisherRepo Store

func (r *publisherRepo) Create(_ context.Context, p *domain.Publisher) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !domain.IsPublisherKey(p.KeyID) {
		return domain.ErrInvalidInput
	}
	if domain.IsEd25519PublisherKey(p.KeyID) {
		if p.IdentityIssuer != "" || p.IdentitySANExact != "" || p.IdentitySANPattern != "" {
			return domain.ErrInvalidInput
		}
	} else if p.IdentityIssuer == "" || (p.IdentitySANExact == "") == (p.IdentitySANPattern == "") {
		return domain.ErrInvalidInput
	}
	if _, ok := r.publishers[p.KeyID]; ok {
		return domain.ErrConflict
	}
	cp := *p
	r.publishers[p.KeyID] = &cp
	// 同时登记初始密钥（供 GetKey/轮换使用）
	publicKey := ""
	if domain.IsEd25519PublisherKey(p.KeyID) {
		publicKey = strings.TrimPrefix(p.KeyID, "ed25519:")
	}
	r.pubKeys[p.KeyID] = &domain.PublisherKey{
		KeyID:              p.KeyID,
		PublisherID:        p.ID,
		PublicKey:          publicKey,
		CreatedAt:          p.CreatedAt,
		IdentityIssuer:     p.IdentityIssuer,
		IdentitySANExact:   p.IdentitySANExact,
		IdentitySANPattern: p.IdentitySANPattern,
	}
	return nil
}

func (r *publisherRepo) GetByKeyID(_ context.Context, keyID string) (*domain.Publisher, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.publishers[keyID]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *p
	return &cp, nil
}

func (r *publisherRepo) List(_ context.Context) ([]*domain.Publisher, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.Publisher, 0, len(r.publishers))
	for _, p := range r.publishers {
		cp := *p
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].KeyID < out[j].KeyID })
	return out, nil
}

func (r *publisherRepo) AddKey(_ context.Context, k *domain.PublisherKey) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !domain.IsEd25519PublisherKey(k.KeyID) ||
		k.PublicKey != strings.TrimPrefix(k.KeyID, "ed25519:") ||
		!domain.IsEd25519PublisherKey(k.RotatedFrom) {
		return domain.ErrInvalidInput
	}
	if _, ok := r.pubKeys[k.KeyID]; ok {
		return domain.ErrConflict
	}
	publisher, ok := r.publishers[k.RotatedFrom]
	if !ok || publisher.ID != k.PublisherID {
		return domain.ErrNotFound
	}
	old, ok := r.pubKeys[k.RotatedFrom]
	if !ok || old.PublisherID != k.PublisherID {
		return domain.ErrForbidden
	}
	cp := *k
	r.pubKeys[k.KeyID] = &cp
	rotated := *publisher
	rotated.KeyID = k.KeyID
	r.publishers[k.KeyID] = &rotated
	return nil
}

func (r *publisherRepo) GetKey(_ context.Context, keyID string) (*domain.PublisherKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	k, ok := r.pubKeys[keyID]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *k
	return &cp, nil
}

// ---------- advisories ----------

type advisoryRepo Store

func (r *advisoryRepo) Create(_ context.Context, a *domain.SecurityAdvisory) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := *a
	r.advisories = append(r.advisories, &cp)
	return nil
}

func (r *advisoryRepo) ListByTool(_ context.Context, pub, tool string) ([]*domain.SecurityAdvisory, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []*domain.SecurityAdvisory{}
	for _, a := range r.advisories {
		if a.PublisherKeyID == pub && a.ToolID == tool {
			cp := *a
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (r *advisoryRepo) ListAll(_ context.Context) ([]*domain.SecurityAdvisory, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.SecurityAdvisory, 0, len(r.advisories))
	for _, a := range r.advisories {
		cp := *a
		out = append(out, &cp)
	}
	return out, nil
}

// ---------- tools ----------

type toolRepo Store

func (r *toolRepo) Upsert(_ context.Context, t *domain.Tool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := *t
	r.tools[toolKey(t.PublisherKeyID, t.ToolID)] = &cp
	return nil
}

func (r *toolRepo) Get(_ context.Context, pub, tool string) (*domain.Tool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tools[toolKey(pub, tool)]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *t
	return &cp, nil
}

func (r *toolRepo) List(_ context.Context) ([]*domain.Tool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.Tool, 0, len(r.tools))
	for _, t := range r.tools {
		cp := *t
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ToolID != out[j].ToolID {
			return out[i].ToolID < out[j].ToolID
		}
		return out[i].PublisherKeyID < out[j].PublisherKeyID
	})
	return out, nil
}

// ---------- artifacts ----------

type artifactRepo Store

func (r *artifactRepo) Create(_ context.Context, a *domain.Artifact) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.artifacts[a.ID]; ok {
		return domain.ErrConflict
	}
	// 唯一约束：tool identity + version + platform + arch（索引 O(1)，非全表扫描）
	idxKey := artIdentityKey(a)
	if existingID, ok := r.artIdentityIx[idxKey]; ok {
		if e, ok2 := r.artifacts[existingID]; ok2 && e.Status != domain.ArtifactRejected {
			return domain.ErrConflict
		}
	}
	cp := *a
	r.artifacts[a.ID] = &cp
	if a.Status != domain.ArtifactRejected {
		r.artIdentityIx[idxKey] = a.ID
	}
	return nil
}

func (r *artifactRepo) Get(_ context.Context, id string) (*domain.Artifact, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.artifacts[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *a
	return &cp, nil
}

func (r *artifactRepo) GetByIdentity(_ context.Context, pub, tool, version, platform, arch string) (*domain.Artifact, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range r.artifacts {
		if a.PublisherKeyID == pub && a.ToolID == tool && a.Version == version &&
			a.Platform == platform && a.Arch == arch {
			cp := *a
			return &cp, nil
		}
	}
	return nil, domain.ErrNotFound
}

func (r *artifactRepo) GetBySHA256(_ context.Context, sha string) (*domain.Artifact, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range r.artifacts {
		if a.SHA256 == sha {
			cp := *a
			return &cp, nil
		}
	}
	return nil, domain.ErrNotFound
}

func (r *artifactRepo) UpdateStatus(_ context.Context, id string, status domain.ArtifactStatus, publishedAt *time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.artifacts[id]
	if !ok {
		return domain.ErrNotFound
	}
	if !domain.CanTransitionArtifactStatus(a.Status, status) {
		return domain.ErrConflict
	}
	a.Status = status
	if publishedAt != nil {
		a.PublishedAt = publishedAt
	}
	return nil
}

func (r *artifactRepo) Update(_ context.Context, a *domain.Artifact) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	current, ok := r.artifacts[a.ID]
	if !ok {
		return domain.ErrNotFound
	}
	if !domain.CanTransitionArtifactStatus(current.Status, a.Status) {
		return domain.ErrConflict
	}
	cp := *a
	r.artifacts[a.ID] = &cp
	return nil
}

func (r *artifactRepo) list(filter func(*domain.Artifact) bool) []*domain.Artifact {
	out := []*domain.Artifact{}
	for _, a := range r.artifacts {
		if filter(a) {
			cp := *a
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (r *artifactRepo) ListByStatus(_ context.Context, status domain.ArtifactStatus) ([]*domain.Artifact, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.list(func(a *domain.Artifact) bool { return a.Status == status }), nil
}

func (r *artifactRepo) ListPublished(_ context.Context) ([]*domain.Artifact, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.list(func(a *domain.Artifact) bool { return a.Status == domain.ArtifactPublished }), nil
}

// ---------- uploads ----------

type uploadRepo Store

func (r *uploadRepo) Create(_ context.Context, s *domain.UploadSession) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.uploads[s.ID]; ok {
		return domain.ErrConflict
	}
	cp := *s
	r.uploads[s.ID] = &cp
	return nil
}

func (r *uploadRepo) Get(_ context.Context, id string) (*domain.UploadSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.uploads[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *s
	return &cp, nil
}

func (r *uploadRepo) Update(_ context.Context, s *domain.UploadSession) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	current, ok := r.uploads[s.ID]
	if !ok {
		return domain.ErrNotFound
	}
	allowed := (current.Status == s.Status && current.Status != domain.UploadReleaseClaimed &&
		current.ArtifactID == s.ArtifactID) ||
		(current.Status == domain.UploadOpen &&
			(s.Status == domain.UploadCompleted || s.Status == domain.UploadFailed) && s.ArtifactID == "") ||
		(current.Status == domain.UploadReleaseClaimed && s.Status == domain.UploadReleaseClaimed &&
			(current.ArtifactID == "" || current.ArtifactID == s.ArtifactID))
	if !allowed {
		return domain.ErrConflict
	}
	cp := *s
	r.uploads[s.ID] = &cp
	return nil
}

func (r *uploadRepo) ClaimCompleted(_ context.Context, id string) (*domain.UploadSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.uploads[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if s.Status != domain.UploadCompleted {
		return nil, domain.ErrConflict
	}
	s.Status = domain.UploadReleaseClaimed
	cp := *s
	return &cp, nil
}

func (r *uploadRepo) GetByArtifact(_ context.Context, artifactID string) (*domain.UploadSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.uploads {
		if s.ArtifactID == artifactID {
			cp := *s
			return &cp, nil
		}
	}
	return nil, domain.ErrNotFound
}

// ---------- TUF metadata version ----------

type metadataRepo Store

type metadataLease struct {
	store    *metadataRepo
	released bool
}

func (r *metadataRepo) AcquirePublishLease(ctx context.Context) (repository.MetadataPublishLease, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case r.metadataLease <- struct{}{}:
		return &metadataLease{store: r}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (l *metadataLease) NextVersion(ctx context.Context, candidate int64) (int64, error) {
	if l.released {
		return 0, domain.ErrConflict
	}
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	default:
	}
	if candidate < 1 || l.store.tufVersion == int64(^uint64(0)>>1) {
		return 0, domain.ErrInvalidInput
	}
	next := l.store.tufVersion + 1
	if candidate > next {
		next = candidate
	}
	l.store.tufVersion = next
	return next, nil
}

func (l *metadataLease) Release() error {
	if l.released {
		return domain.ErrConflict
	}
	l.released = true
	<-l.store.metadataLease
	return nil
}

// ---------- entitlements ----------

type entitlementRepo Store

func (r *entitlementRepo) Upsert(_ context.Context, e *domain.Entitlement) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := *e
	r.entitlements[e.ID] = &cp
	return nil
}

func (r *entitlementRepo) ListBySubject(_ context.Context, subjectID string) ([]*domain.Entitlement, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []*domain.Entitlement{}
	for _, e := range r.entitlements {
		if e.SubjectID == subjectID {
			cp := *e
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// ---------- grants ----------

type grantRepo Store

func (r *grantRepo) Create(_ context.Context, g *domain.DownloadGrant) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.grants[g.ID]; ok {
		return domain.ErrConflict
	}
	cp := *g
	r.grants[g.ID] = &cp
	return nil
}

func (r *grantRepo) Get(_ context.Context, id string) (*domain.DownloadGrant, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	g, ok := r.grants[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *g
	return &cp, nil
}

// ---------- billing ----------

type billingRepo Store

func (r *billingRepo) InsertEvent(_ context.Context, e *domain.BillingEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.billingEvents[e.EventID]; ok {
		return domain.ErrConflict // 幂等：重复事件拒绝二次处理
	}
	cp := *e
	r.billingEvents[e.EventID] = &cp
	return nil
}

func (r *billingRepo) MarkEventProcessed(_ context.Context, eventID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.billingEvents[eventID]
	if !ok {
		return domain.ErrNotFound
	}
	e.Processed = true
	return nil
}

func (r *billingRepo) GetEvent(_ context.Context, eventID string) (*domain.BillingEvent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.billingEvents[eventID]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *e
	return &cp, nil
}

func (r *billingRepo) UpsertSubscription(_ context.Context, s *domain.Subscription) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if cur, ok := r.subscriptions[s.ID]; ok {
		// 乱序防护：旧事件（objectTime 不更新）不得覆盖新状态
		if !s.ObjectTime.After(cur.ObjectTime) {
			return nil
		}
	}
	cp := *s
	r.subscriptions[s.ID] = &cp
	return nil
}

func (r *billingRepo) GetSubscription(_ context.Context, id string) (*domain.Subscription, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.subscriptions[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *s
	return &cp, nil
}

// ---------- audit（append only） ----------

type auditRepo Store

func (r *auditRepo) Append(_ context.Context, e *domain.AuditEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.auditSeq++
	cp := *e
	cp.Seq = r.auditSeq
	r.audit = append(r.audit, &cp)
	return nil
}

func (r *auditRepo) List(_ context.Context, limit int) ([]*domain.AuditEvent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(r.audit)
	if limit > 0 && limit < n {
		n = limit
	}
	out := make([]*domain.AuditEvent, 0, n)
	for i := len(r.audit) - n; i < len(r.audit); i++ {
		cp := *r.audit[i]
		out = append(out, &cp)
	}
	return out, nil
}

// ---------- jobs ----------

type jobRepo Store

func (r *jobRepo) Enqueue(_ context.Context, j *domain.Job) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.jobs[j.ID]; ok {
		return domain.ErrConflict
	}
	cp := *j
	r.jobs[j.ID] = &cp
	return nil
}

func (r *jobRepo) ClaimNext(_ context.Context, kinds []string) (*domain.Job, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.jobs))
	for id := range r.jobs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		j := r.jobs[id]
		if j.Status != domain.JobQueued {
			continue
		}
		match := len(kinds) == 0
		for _, k := range kinds {
			if j.Kind == k {
				match = true
			}
		}
		if !match {
			continue
		}
		j.Status = domain.JobRunning
		j.Attempts++
		j.UpdatedAt = time.Now().UTC()
		cp := *j
		return &cp, nil
	}
	return nil, domain.ErrNotFound
}

func (r *jobRepo) Complete(_ context.Context, id string, jobErr string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	j, ok := r.jobs[id]
	if !ok {
		return domain.ErrNotFound
	}
	if jobErr == "" {
		j.Status = domain.JobDone
	} else {
		// 失败重试：3 次内重新排队
		j.Error = jobErr
		if j.Attempts < 3 {
			j.Status = domain.JobQueued
		} else {
			j.Status = domain.JobFailed
		}
	}
	j.UpdatedAt = time.Now().UTC()
	return nil
}

func (r *jobRepo) Depth(_ context.Context) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, j := range r.jobs {
		if j.Status == domain.JobQueued || j.Status == domain.JobRunning {
			n++
		}
	}
	return n, nil
}
