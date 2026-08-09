// Package postgres 实现 repository 接口（pgx stdlib + database/sql）。
// 全部查询参数化；唯一约束/append-only 由 migrations/0001_init.sql 在数据库层保证。
package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository"
)

type Store struct {
	db *sql.DB
}

// Open 连接并应用 migrations 目录下的 *.sql（按文件名顺序，幂等）。
func Open(ctx context.Context, dsn, migrationsDir string) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(16)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		return nil, err
	}
	s := &Store{db: db}
	if migrationsDir != "" {
		if err := s.migrate(ctx, migrationsDir); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) migrate(ctx context.Context, dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	names := []string{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	// 单连接 + advisory lock：串行化并发的 server/worker 迁移（防多进程同时建表冲突）。
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	const migrationLockKey = 0x746278_6d696772 // "usefulmigr"
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, int64(migrationLockKey)); err != nil {
		return err
	}
	defer conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, int64(migrationLockKey))

	// migrations 表存在时按版本跳过
	_, _ = conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS migrations (
		version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
	var current int
	_ = conn.QueryRowContext(ctx, `SELECT COALESCE(MAX(version),0) FROM migrations`).Scan(&current)
	for i, name := range names {
		version := i + 1
		if version <= current {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		if _, err := conn.ExecContext(ctx, string(raw)); err != nil {
			return fmt.Errorf("迁移 %s 失败: %w", name, err)
		}
	}
	return nil
}

func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func isUnique(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return false
}

func mapErr(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ErrNotFound
	}
	if isUnique(err) {
		return domain.ErrConflict
	}
	return err
}

func (s *Store) Publishers() repository.PublisherRepo     { return &pubRepo{s.db} }
func (s *Store) Tools() repository.ToolRepo               { return &toolRepo{s.db} }
func (s *Store) Artifacts() repository.ArtifactRepo       { return &artRepo{s.db} }
func (s *Store) Uploads() repository.UploadRepo           { return &upRepo{s.db} }
func (s *Store) Entitlements() repository.EntitlementRepo { return &entRepo{s.db} }
func (s *Store) Grants() repository.GrantRepo             { return &grantRepo{s.db} }
func (s *Store) Billing() repository.BillingRepo          { return &billRepo{s.db} }
func (s *Store) Audit() repository.AuditRepo              { return &auditRepo{s.db} }
func (s *Store) Jobs() repository.JobRepo                 { return &jobRepo{s.db} }
func (s *Store) Advisories() repository.AdvisoryRepo      { return &advRepo{s.db} }
func (s *Store) Metadata() repository.MetadataRepo        { return &metadataRepo{s.db} }

// ---------- publishers ----------

type pubRepo struct{ db *sql.DB }

func (r *pubRepo) Create(ctx context.Context, p *domain.Publisher) error {
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
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO publishers (id, display_name, created_at) VALUES ($1,$2,$3)`,
		p.ID, p.DisplayName, p.CreatedAt); err != nil {
		return mapErr(err)
	}
	pubHex := ""
	if domain.IsEd25519PublisherKey(p.KeyID) {
		pubHex = strings.TrimPrefix(p.KeyID, "ed25519:")
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO publisher_keys (key_id, publisher_id, public_key,
		   identity_issuer, identity_san_exact, identity_san_pattern) VALUES ($1,$2,$3,$4,$5,$6)`,
		p.KeyID, p.ID, pubHex, p.IdentityIssuer, p.IdentitySANExact, p.IdentitySANPattern); err != nil {
		return mapErr(err)
	}
	return tx.Commit()
}

func (r *pubRepo) GetByKeyID(ctx context.Context, keyID string) (*domain.Publisher, error) {
	var p domain.Publisher
	err := r.db.QueryRowContext(ctx,
		`SELECT p.id, p.display_name, k.key_id, p.created_at
		 FROM publisher_keys k JOIN publishers p ON p.id = k.publisher_id
		 WHERE k.key_id = $1`, keyID).
		Scan(&p.ID, &p.DisplayName, &p.KeyID, &p.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &p, nil
}

func (r *pubRepo) List(ctx context.Context) ([]*domain.Publisher, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT p.id, p.display_name, k.key_id, p.created_at
		 FROM publisher_keys k JOIN publishers p ON p.id = k.publisher_id ORDER BY k.key_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.Publisher{}
	for rows.Next() {
		var p domain.Publisher
		if err := rows.Scan(&p.ID, &p.DisplayName, &p.KeyID, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &p)
	}
	return out, rows.Err()
}

func (r *pubRepo) AddKey(ctx context.Context, k *domain.PublisherKey) error {
	if !domain.IsEd25519PublisherKey(k.KeyID) ||
		k.PublicKey != strings.TrimPrefix(k.KeyID, "ed25519:") ||
		!domain.IsEd25519PublisherKey(k.RotatedFrom) {
		return domain.ErrInvalidInput
	}
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO publisher_keys (key_id, publisher_id, public_key, rotated_from, created_at,
		   identity_issuer, identity_san_exact, identity_san_pattern)
		 SELECT $1,$2,$3,$4,$5,$6,$7,$8
		 FROM publisher_keys old
		 WHERE old.key_id=$4 AND old.publisher_id=$2`,
		k.KeyID, k.PublisherID, k.PublicKey, k.RotatedFrom, k.CreatedAt,
		k.IdentityIssuer, k.IdentitySANExact, k.IdentitySANPattern)
	if err != nil {
		return mapErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrForbidden
	}
	return nil
}

func (r *pubRepo) GetKey(ctx context.Context, keyID string) (*domain.PublisherKey, error) {
	var k domain.PublisherKey
	var rotated sql.NullString
	err := r.db.QueryRowContext(ctx,
		`SELECT key_id, publisher_id, public_key, rotated_from, created_at,
		        identity_issuer, identity_san_exact, identity_san_pattern
		 FROM publisher_keys WHERE key_id = $1`, keyID).
		Scan(&k.KeyID, &k.PublisherID, &k.PublicKey, &rotated, &k.CreatedAt,
			&k.IdentityIssuer, &k.IdentitySANExact, &k.IdentitySANPattern)
	if err != nil {
		return nil, mapErr(err)
	}
	k.RotatedFrom = rotated.String
	return &k, nil
}

// ---------- advisories ----------

type advRepo struct{ db *sql.DB }

func (r *advRepo) Create(ctx context.Context, a *domain.SecurityAdvisory) error {
	versions, _ := json.Marshal(a.AffectedVersions)
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO security_advisories (id, publisher_key_id, tool_id, severity, summary, affected_versions, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		a.ID, a.PublisherKeyID, a.ToolID, string(a.Severity), a.Summary, versions, a.CreatedAt)
	return mapErr(err)
}

func (r *advRepo) listWhere(ctx context.Context, where string, args ...any) ([]*domain.SecurityAdvisory, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, publisher_key_id, tool_id, severity, summary, affected_versions, created_at
		 FROM security_advisories `+where+` ORDER BY created_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.SecurityAdvisory{}
	for rows.Next() {
		var a domain.SecurityAdvisory
		var versions []byte
		if err := rows.Scan(&a.ID, &a.PublisherKeyID, &a.ToolID, (*string)(&a.Severity),
			&a.Summary, &versions, &a.CreatedAt); err != nil {
			return nil, err
		}
		if json.Unmarshal(versions, &a.AffectedVersions) != nil {
			a.AffectedVersions = []string{}
		}
		out = append(out, &a)
	}
	return out, rows.Err()
}

func (r *advRepo) ListByTool(ctx context.Context, pub, tool string) ([]*domain.SecurityAdvisory, error) {
	return r.listWhere(ctx, `WHERE publisher_key_id=$1 AND tool_id=$2`, pub, tool)
}

func (r *advRepo) ListAll(ctx context.Context) ([]*domain.SecurityAdvisory, error) {
	return r.listWhere(ctx, ``)
}

// ---------- tools ----------

type toolRepo struct{ db *sql.DB }

func (r *toolRepo) Upsert(ctx context.Context, t *domain.Tool) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO tools (publisher_key_id, tool_id, name, summary, license, is_native_worker, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)
		 ON CONFLICT (publisher_key_id, tool_id)
		 DO UPDATE SET name=$3, summary=$4, license=$5, is_native_worker=$6`,
		t.PublisherKeyID, t.ToolID, t.Name, t.Summary, t.License, t.IsNativeWorker, t.CreatedAt); err != nil {
		return mapErr(err)
	}
	var productID any
	if t.ProductID != "" {
		productID = t.ProductID
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO catalog_offers (publisher_key_id, tool_id, access_mode, product_id)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (publisher_key_id, tool_id)
		 DO UPDATE SET access_mode=$3, product_id=$4, updated_at=now()`,
		t.PublisherKeyID, t.ToolID, t.AccessMode, productID); err != nil {
		return mapErr(err)
	}
	return tx.Commit()
}

func (r *toolRepo) Get(ctx context.Context, pub, tool string) (*domain.Tool, error) {
	var t domain.Tool
	var productID sql.NullString
	err := r.db.QueryRowContext(ctx,
		`SELECT t.publisher_key_id, t.tool_id, t.name, t.summary, t.license,
		        t.is_native_worker, t.created_at, o.access_mode, o.product_id
		 FROM tools t JOIN catalog_offers o
		   ON o.publisher_key_id = t.publisher_key_id AND o.tool_id = t.tool_id
		 WHERE t.publisher_key_id = $1 AND t.tool_id = $2`, pub, tool).
		Scan(&t.PublisherKeyID, &t.ToolID, &t.Name, &t.Summary, &t.License,
			&t.IsNativeWorker, &t.CreatedAt, &t.AccessMode, &productID)
	if err != nil {
		return nil, mapErr(err)
	}
	t.ProductID = productID.String
	return &t, nil
}

func (r *toolRepo) List(ctx context.Context) ([]*domain.Tool, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT t.publisher_key_id, t.tool_id, t.name, t.summary, t.license,
		        t.is_native_worker, t.created_at, o.access_mode, o.product_id
		 FROM tools t JOIN catalog_offers o
		   ON o.publisher_key_id = t.publisher_key_id AND o.tool_id = t.tool_id
		 ORDER BY t.tool_id, t.publisher_key_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.Tool{}
	for rows.Next() {
		var t domain.Tool
		var productID sql.NullString
		if err := rows.Scan(&t.PublisherKeyID, &t.ToolID, &t.Name, &t.Summary, &t.License,
			&t.IsNativeWorker, &t.CreatedAt, &t.AccessMode, &productID); err != nil {
			return nil, err
		}
		t.ProductID = productID.String
		out = append(out, &t)
	}
	return out, rows.Err()
}

// ---------- artifacts ----------

type artRepo struct{ db *sql.DB }

const artCols = `id, publisher_key_id, tool_id, version, channel, platform, arch,
	sha256, manifest_digest, size, file_name, permissions, status, created_at, published_at,
	publisher_signature_verified, security_scan_passed, official_review_passed,
	is_native_worker, sbom_digest, scan_result_json, signature_method, publisher_signature, signature_identity,
	reproducible_claimed, repro_status, repro_strategy`

func scanArtifact(scan func(...any) error) (*domain.Artifact, error) {
	var a domain.Artifact
	var perms []byte
	var pub sql.NullTime
	if err := scan(&a.ID, &a.PublisherKeyID, &a.ToolID, &a.Version, &a.Channel,
		&a.Platform, &a.Arch, &a.SHA256, &a.ManifestDigest, &a.Size, &a.FileName,
		&perms, (*string)(&a.Status), &a.CreatedAt, &pub,
		&a.PublisherSignatureVerified, &a.SecurityScanPassed, &a.OfficialReviewPassed,
		&a.IsNativeWorker, &a.SBOMDigest, &a.ScanResultJSON,
		&a.SignatureMethod, &a.PublisherSignature, &a.SignatureIdentity,
		&a.ReproducibleClaimed, &a.ReproStatus, &a.ReproStrategy); err != nil {
		return nil, mapErr(err)
	}
	if err := json.Unmarshal(perms, &a.Permissions); err != nil {
		a.Permissions = []string{}
	}
	if pub.Valid {
		t := pub.Time
		a.PublishedAt = &t
	}
	return &a, nil
}

func (r *artRepo) Create(ctx context.Context, a *domain.Artifact) error {
	perms, _ := json.Marshal(a.Permissions)
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO artifacts (`+artCols+`)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
		a.ID, a.PublisherKeyID, a.ToolID, a.Version, a.Channel, a.Platform, a.Arch,
		a.SHA256, a.ManifestDigest, a.Size, a.FileName, perms, string(a.Status),
		a.CreatedAt, a.PublishedAt,
		a.PublisherSignatureVerified, a.SecurityScanPassed, a.OfficialReviewPassed,
		a.IsNativeWorker, a.SBOMDigest, a.ScanResultJSON, a.SignatureMethod, a.PublisherSignature, a.SignatureIdentity,
		a.ReproducibleClaimed, a.ReproStatus, a.ReproStrategy)
	return mapErr(err)
}

func (r *artRepo) Get(ctx context.Context, id string) (*domain.Artifact, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+artCols+` FROM artifacts WHERE id = $1`, id)
	return scanArtifact(row.Scan)
}

func (r *artRepo) GetByIdentity(ctx context.Context, pub, tool, version, platform, arch string) (*domain.Artifact, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT `+artCols+` FROM artifacts
		 WHERE publisher_key_id=$1 AND tool_id=$2 AND version=$3 AND platform=$4 AND arch=$5`,
		pub, tool, version, platform, arch)
	return scanArtifact(row.Scan)
}

func (r *artRepo) GetBySHA256(ctx context.Context, sha string) (*domain.Artifact, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+artCols+` FROM artifacts WHERE sha256 = $1`, sha)
	return scanArtifact(row.Scan)
}

func (r *artRepo) UpdateStatus(ctx context.Context, id string, status domain.ArtifactStatus, publishedAt *time.Time) error {
	res, err := r.db.ExecContext(ctx,
		`UPDATE artifacts SET status=$2, published_at=COALESCE($3, published_at)
		 WHERE id=$1 AND (
		   status=$2
		   OR (status='staged' AND $2 IN ('scanned','rejected'))
		   OR (status='scanned' AND $2 IN ('publish-pending','rejected'))
		   OR (status='publish-pending' AND $2='published')
		   OR (status='published' AND $2='withdraw-pending')
		   OR (status='withdraw-pending' AND $2='withdrawn')
		 )`,
		id, string(status), publishedAt)
	if err != nil {
		return mapErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var exists bool
		if checkErr := r.db.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=$1)`, id).Scan(&exists); checkErr != nil {
			return checkErr
		}
		if exists {
			return domain.ErrConflict
		}
		return domain.ErrNotFound
	}
	return nil
}

func (r *artRepo) Update(ctx context.Context, a *domain.Artifact) error {
	perms, _ := json.Marshal(a.Permissions)
	res, err := r.db.ExecContext(ctx,
		`UPDATE artifacts SET channel=$2, permissions=$3, status=$4, published_at=$5,
		   publisher_signature_verified=$6, security_scan_passed=$7, official_review_passed=$8,
		   is_native_worker=$9, sbom_digest=$10, scan_result_json=$11,
		   signature_method=$12, publisher_signature=$13, signature_identity=$14,
		   reproducible_claimed=$15, repro_status=$16, repro_strategy=$17
		 WHERE id=$1 AND (
		   status=$4
		   OR (status='staged' AND $4 IN ('scanned','rejected'))
		   OR (status='scanned' AND $4 IN ('publish-pending','rejected'))
		   OR (status='publish-pending' AND $4='published')
		   OR (status='published' AND $4='withdraw-pending')
		   OR (status='withdraw-pending' AND $4='withdrawn')
		 )`,
		a.ID, a.Channel, perms, string(a.Status), a.PublishedAt,
		a.PublisherSignatureVerified, a.SecurityScanPassed, a.OfficialReviewPassed,
		a.IsNativeWorker, a.SBOMDigest, a.ScanResultJSON,
		a.SignatureMethod, a.PublisherSignature, a.SignatureIdentity,
		a.ReproducibleClaimed, a.ReproStatus, a.ReproStrategy)
	if err != nil {
		return mapErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var exists bool
		if checkErr := r.db.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=$1)`, a.ID).Scan(&exists); checkErr != nil {
			return checkErr
		}
		if exists {
			return domain.ErrConflict
		}
		return domain.ErrNotFound
	}
	return nil
}

func (r *artRepo) listWhere(ctx context.Context, where string, args ...any) ([]*domain.Artifact, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+artCols+` FROM artifacts `+where+` ORDER BY id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.Artifact{}
	for rows.Next() {
		a, err := scanArtifact(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *artRepo) ListByStatus(ctx context.Context, status domain.ArtifactStatus) ([]*domain.Artifact, error) {
	return r.listWhere(ctx, `WHERE status = $1`, string(status))
}

func (r *artRepo) ListPublished(ctx context.Context) ([]*domain.Artifact, error) {
	return r.listWhere(ctx, `WHERE status = 'published'`)
}

// ---------- uploads ----------

type upRepo struct{ db *sql.DB }

func (r *upRepo) Create(ctx context.Context, s *domain.UploadSession) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO upload_sessions (id, publisher_key_id, staging_key, declared_sha256, declared_size, status, error, artifact_id, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9)`,
		s.ID, s.PublisherKeyID, s.StagingKey, s.DeclaredSHA256, s.DeclaredSize,
		string(s.Status), s.Error, s.ArtifactID, s.CreatedAt)
	return mapErr(err)
}

func scanUpload(scan func(...any) error) (*domain.UploadSession, error) {
	var s domain.UploadSession
	var artifactID sql.NullString
	if err := scan(&s.ID, &s.PublisherKeyID, &s.StagingKey, &s.DeclaredSHA256,
		&s.DeclaredSize, (*string)(&s.Status), &s.Error, &artifactID, &s.CreatedAt); err != nil {
		return nil, mapErr(err)
	}
	s.ArtifactID = artifactID.String
	return &s, nil
}

const upCols = `id, publisher_key_id, staging_key, declared_sha256, declared_size, status, error, artifact_id, created_at`

func (r *upRepo) Get(ctx context.Context, id string) (*domain.UploadSession, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+upCols+` FROM upload_sessions WHERE id=$1`, id)
	return scanUpload(row.Scan)
}

func (r *upRepo) GetByArtifact(ctx context.Context, artifactID string) (*domain.UploadSession, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+upCols+` FROM upload_sessions WHERE artifact_id=$1`, artifactID)
	return scanUpload(row.Scan)
}

func (r *upRepo) Update(ctx context.Context, s *domain.UploadSession) error {
	res, err := r.db.ExecContext(ctx,
		`UPDATE upload_sessions SET status=$2, error=$3, artifact_id=NULLIF($4,'')
		 WHERE id=$1 AND (
		   (status=$2 AND status<>$8 AND COALESCE(artifact_id,'')=COALESCE(NULLIF($4,''),''))
		   OR (status=$5 AND $2 IN ($6,$7) AND NULLIF($4,'') IS NULL)
		   OR (status=$8 AND $2=$8 AND (artifact_id IS NULL OR artifact_id=NULLIF($4,'')))
		 )`,
		s.ID, string(s.Status), s.Error, s.ArtifactID,
		string(domain.UploadOpen), string(domain.UploadCompleted), string(domain.UploadFailed),
		string(domain.UploadReleaseClaimed))
	if err != nil {
		return mapErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var exists bool
		if checkErr := r.db.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM upload_sessions WHERE id=$1)`, s.ID).Scan(&exists); checkErr != nil {
			return checkErr
		}
		if exists {
			return domain.ErrConflict
		}
		return domain.ErrNotFound
	}
	return nil
}

func (r *upRepo) ClaimCompleted(ctx context.Context, id string) (*domain.UploadSession, error) {
	row := r.db.QueryRowContext(ctx,
		`UPDATE upload_sessions SET status=$2
		 WHERE id=$1 AND status=$3
		 RETURNING `+upCols,
		id, string(domain.UploadReleaseClaimed), string(domain.UploadCompleted))
	s, err := scanUpload(row.Scan)
	if errors.Is(err, domain.ErrNotFound) {
		var exists bool
		if checkErr := r.db.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM upload_sessions WHERE id=$1)`, id).Scan(&exists); checkErr != nil {
			return nil, checkErr
		}
		if exists {
			return nil, domain.ErrConflict
		}
	}
	return s, err
}

// ---------- TUF metadata version ----------

type metadataRepo struct{ db *sql.DB }

// Stable Useful-specific PostgreSQL advisory-lock key for metadata publishing.
// The first public release has not shipped, so this key may be changed once.
const metadataPublishLockKey int64 = 0x55736566756c4d50 // "UsefulMP"

type metadataPublishLease struct {
	conn     *sql.Conn
	released bool
}

func (r *metadataRepo) AcquirePublishLease(ctx context.Context) (repository.MetadataPublishLease, error) {
	conn, err := r.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, metadataPublishLockKey); err != nil {
		// The server may have acquired the session lock even when the client did
		// not receive a successful response. Discard an uncertain connection so
		// it can never return to the pool while holding the publish lock.
		_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		_ = conn.Close()
		return nil, err
	}
	return &metadataPublishLease{conn: conn}, nil
}

func (l *metadataPublishLease) NextVersion(ctx context.Context, candidate int64) (int64, error) {
	if l.released {
		return 0, domain.ErrConflict
	}
	if candidate < 1 {
		return 0, domain.ErrInvalidInput
	}
	var version int64
	err := l.conn.QueryRowContext(ctx,
		`INSERT INTO tuf_metadata_state (singleton, last_version) VALUES (true, $1)
		 ON CONFLICT (singleton) DO UPDATE
		 SET last_version=GREATEST(EXCLUDED.last_version, tuf_metadata_state.last_version + 1)
		 RETURNING last_version`, candidate).Scan(&version)
	return version, err
}

func (l *metadataPublishLease) Release() error {
	if l.released {
		return domain.ErrConflict
	}
	l.released = true

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var unlocked bool
	unlockErr := l.conn.QueryRowContext(ctx,
		`SELECT pg_advisory_unlock($1)`, metadataPublishLockKey).Scan(&unlocked)
	if unlockErr == nil && !unlocked {
		unlockErr = fmt.Errorf("metadata publish advisory lock was not held")
	}
	if unlockErr != nil {
		// Never return a session with an uncertain advisory-lock state to the
		// pool. ErrBadConn makes database/sql discard the physical connection.
		_ = l.conn.Raw(func(any) error { return driver.ErrBadConn })
	}
	return errors.Join(unlockErr, l.conn.Close())
}

// ---------- entitlements ----------

type entRepo struct{ db *sql.DB }

func (r *entRepo) Upsert(ctx context.Context, e *domain.Entitlement) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO entitlements (id, subject_id, product_id, plan_id, tool_scope, status, starts_at, expires_at, grace_until, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		 ON CONFLICT (id) DO UPDATE SET status=$6, expires_at=$8, grace_until=$9, updated_at=$10`,
		e.ID, e.SubjectID, e.ProductID, e.PlanID, e.ToolScope, string(e.Status),
		e.StartsAt, e.ExpiresAt, e.GraceUntil, e.UpdatedAt)
	return mapErr(err)
}

func (r *entRepo) ListBySubject(ctx context.Context, subjectID string) ([]*domain.Entitlement, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, subject_id, product_id, plan_id, tool_scope, status, starts_at, expires_at, grace_until, updated_at
		 FROM entitlements WHERE subject_id=$1 ORDER BY id`, subjectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.Entitlement{}
	for rows.Next() {
		var e domain.Entitlement
		var exp, grace sql.NullTime
		if err := rows.Scan(&e.ID, &e.SubjectID, &e.ProductID, &e.PlanID, &e.ToolScope,
			(*string)(&e.Status), &e.StartsAt, &exp, &grace, &e.UpdatedAt); err != nil {
			return nil, err
		}
		if exp.Valid {
			t := exp.Time
			e.ExpiresAt = &t
		}
		if grace.Valid {
			t := grace.Time
			e.GraceUntil = &t
		}
		out = append(out, &e)
	}
	return out, rows.Err()
}

// ---------- grants ----------

type grantRepo struct{ db *sql.DB }

func (r *grantRepo) Create(ctx context.Context, g *domain.DownloadGrant) error {
	// url_digest：不存完整临时 URL，只存摘要供排障
	sum := sha256.Sum256([]byte(g.DownloadURL))
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO download_grants (id, subject_id, artifact_id, artifact_sha256, size, url_digest, expires_at, supports_range, created_at)
		 VALUES ($1,NULLIF($2,''),$3,$4,$5,$6,$7,$8,$9)`,
		g.ID, g.SubjectID, g.ArtifactID, g.ArtifactSHA256, g.Size,
		hex.EncodeToString(sum[:8]), g.ExpiresAt, g.SupportsRange, g.CreatedAt)
	return mapErr(err)
}

func (r *grantRepo) Get(ctx context.Context, id string) (*domain.DownloadGrant, error) {
	var g domain.DownloadGrant
	var subject sql.NullString
	err := r.db.QueryRowContext(ctx,
		`SELECT id, subject_id, artifact_id, artifact_sha256, size, expires_at, supports_range, created_at
		 FROM download_grants WHERE id=$1`, id).
		Scan(&g.ID, &subject, &g.ArtifactID, &g.ArtifactSHA256, &g.Size,
			&g.ExpiresAt, &g.SupportsRange, &g.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	g.SubjectID = subject.String
	return &g, nil
}

// ---------- billing ----------

type billRepo struct{ db *sql.DB }

func (r *billRepo) InsertEvent(ctx context.Context, e *domain.BillingEvent) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO billing_events (event_id, provider, kind, object_time, processed, received_at)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		e.EventID, e.Provider, e.Kind, e.ObjectTime, e.Processed, e.ReceivedAt)
	return mapErr(err)
}

func (r *billRepo) MarkEventProcessed(ctx context.Context, eventID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE billing_events SET processed=true WHERE event_id=$1`, eventID)
	return mapErr(err)
}

func (r *billRepo) GetEvent(ctx context.Context, eventID string) (*domain.BillingEvent, error) {
	var e domain.BillingEvent
	err := r.db.QueryRowContext(ctx,
		`SELECT event_id, provider, kind, object_time, processed, received_at
		 FROM billing_events WHERE event_id=$1`, eventID).
		Scan(&e.EventID, &e.Provider, &e.Kind, &e.ObjectTime, &e.Processed, &e.ReceivedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &e, nil
}

func (r *billRepo) UpsertSubscription(ctx context.Context, s *domain.Subscription) error {
	// 乱序防护：仅 object_time 更新时覆盖
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO billing_subscriptions (id, customer_id, product_id, plan_id, status, object_time, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)
		 ON CONFLICT (id) DO UPDATE SET
		   customer_id=$2, product_id=$3, plan_id=$4, status=$5, object_time=$6, updated_at=$7
		 WHERE billing_subscriptions.object_time < EXCLUDED.object_time`,
		s.ID, s.CustomerID, s.ProductID, s.PlanID, s.Status, s.ObjectTime, s.UpdatedAt)
	return mapErr(err)
}

func (r *billRepo) GetSubscription(ctx context.Context, id string) (*domain.Subscription, error) {
	var s domain.Subscription
	err := r.db.QueryRowContext(ctx,
		`SELECT id, customer_id, product_id, plan_id, status, object_time, updated_at
		 FROM billing_subscriptions WHERE id=$1`, id).
		Scan(&s.ID, &s.CustomerID, &s.ProductID, &s.PlanID, &s.Status, &s.ObjectTime, &s.UpdatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &s, nil
}

// ---------- audit ----------

type auditRepo struct{ db *sql.DB }

func (r *auditRepo) Append(ctx context.Context, e *domain.AuditEvent) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO audit_logs (at, actor, action, detail) VALUES ($1,$2,$3,$4)`,
		e.At, e.Actor, e.Action, e.Detail)
	return mapErr(err)
}

func (r *auditRepo) List(ctx context.Context, limit int) ([]*domain.AuditEvent, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT seq, at, actor, action, detail FROM audit_logs ORDER BY seq DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.AuditEvent{}
	for rows.Next() {
		var e domain.AuditEvent
		if err := rows.Scan(&e.Seq, &e.At, &e.Actor, &e.Action, &e.Detail); err != nil {
			return nil, err
		}
		out = append(out, &e)
	}
	return out, rows.Err()
}

// ---------- jobs ----------

type jobRepo struct{ db *sql.DB }

func (r *jobRepo) Enqueue(ctx context.Context, j *domain.Job) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO job_queue (id, kind, payload, status, attempts, error, created_at, updated_at)
		 VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)`,
		j.ID, j.Kind, j.Payload, string(j.Status), j.Attempts, j.Error, j.CreatedAt, j.UpdatedAt)
	return mapErr(err)
}

func (r *jobRepo) ClaimNext(ctx context.Context, kinds []string) (*domain.Job, error) {
	// FOR UPDATE SKIP LOCKED：多 worker 安全认领
	var kindFilter any
	if len(kinds) > 0 {
		kindFilter = kinds[0] // 首版单一 kind；多 kind 由调用方循环
	} else {
		kindFilter = "scan-artifact"
	}
	var j domain.Job
	err := r.db.QueryRowContext(ctx,
		`UPDATE job_queue SET status='running', attempts=attempts+1, updated_at=now()
		 WHERE id = (
		   SELECT id FROM job_queue WHERE status='queued' AND kind=$1
		   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
		 RETURNING id, kind, payload, status, attempts, error, created_at, updated_at`, kindFilter).
		Scan(&j.ID, &j.Kind, &j.Payload, (*string)(&j.Status), &j.Attempts, &j.Error, &j.CreatedAt, &j.UpdatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &j, nil
}

func (r *jobRepo) Complete(ctx context.Context, id string, jobErr string) error {
	var err error
	if jobErr == "" {
		_, err = r.db.ExecContext(ctx,
			`UPDATE job_queue SET status='done', updated_at=now() WHERE id=$1`, id)
	} else {
		_, err = r.db.ExecContext(ctx,
			`UPDATE job_queue SET
			   status = CASE WHEN attempts < 3 THEN 'queued' ELSE 'failed' END,
			   error=$2, updated_at=now()
			 WHERE id=$1`, id, jobErr)
	}
	return mapErr(err)
}

func (r *jobRepo) Depth(ctx context.Context) (int, error) {
	var n int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM job_queue WHERE status IN ('queued','running')`).Scan(&n)
	return n, err
}
