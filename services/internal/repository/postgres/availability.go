// availability_checks 的 PostgreSQL 实现（sourceAvailable 真实推导依据）。
package postgres

import (
	"context"
	"database/sql"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository"
)

func (s *Store) Availability() repository.AvailabilityRepo { return &availRepo{s.db} }

type availRepo struct{ db *sql.DB }

func (r *availRepo) Upsert(ctx context.Context, c *domain.AvailabilityCheck) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO availability_checks
		  (artifact_sha256, source_id, target, status, last_success_at, last_failure_at,
		   consecutive_failures, error_category, checked_at, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (artifact_sha256) DO UPDATE SET
		  source_id=$2, target=$3, status=$4, last_success_at=$5, last_failure_at=$6,
		  consecutive_failures=$7, error_category=$8, checked_at=$9, expires_at=$10`,
		c.ArtifactSHA256, c.SourceID, c.Target, string(c.Status),
		nullTime(c.LastSuccessAt), nullTime(c.LastFailureAt),
		c.ConsecutiveFailures, c.ErrorCategory, c.CheckedAt, c.ExpiresAt)
	return mapErr(err)
}

func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

func (r *availRepo) Get(ctx context.Context, sha string) (*domain.AvailabilityCheck, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT artifact_sha256, source_id, target, status, last_success_at, last_failure_at,
		       consecutive_failures, error_category, checked_at, expires_at
		FROM availability_checks WHERE artifact_sha256=$1`, sha)
	return scanAvail(row)
}

func (r *availRepo) ListAll(ctx context.Context) ([]*domain.AvailabilityCheck, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT artifact_sha256, source_id, target, status, last_success_at, last_failure_at,
		       consecutive_failures, error_category, checked_at, expires_at
		FROM availability_checks ORDER BY artifact_sha256`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.AvailabilityCheck{}
	for rows.Next() {
		v, err := scanAvail(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func scanAvail(row rowScanner) (*domain.AvailabilityCheck, error) {
	var v domain.AvailabilityCheck
	var status string
	var succ, fail sql.NullTime
	if err := row.Scan(&v.ArtifactSHA256, &v.SourceID, &v.Target, &status,
		&succ, &fail, &v.ConsecutiveFailures, &v.ErrorCategory,
		&v.CheckedAt, &v.ExpiresAt); err != nil {
		return nil, mapErr(err)
	}
	v.Status = domain.AvailabilityStatus(status)
	if succ.Valid {
		t := succ.Time
		v.LastSuccessAt = &t
	}
	if fail.Valid {
		t := fail.Time
		v.LastFailureAt = &t
	}
	return &v, nil
}
