// identities / api_tokens 鐨?PostgreSQL 瀹炵幇锛圧BAC锛屽彇浠ｇ敓浜?X-Admin-Token锛夈€?
package postgres

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"useful.dev/source/internal/domain"
	"useful.dev/source/internal/repository"
)

func (s *Store) Identities() repository.IdentityRepo { return &identityRepo{s.db} }

type identityRepo struct{ db *sql.DB }

func (r *identityRepo) CreateIdentity(ctx context.Context, id *domain.Identity) error {
	roles, _ := json.Marshal(id.Roles)
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO identities (id, display_name, kind, roles, publisher_key_id, disabled, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		id.ID, id.DisplayName, id.Kind, string(roles), id.PublisherKeyID, id.Disabled, id.CreatedAt)
	return mapErr(err)
}

func (r *identityRepo) GetIdentity(ctx context.Context, id string) (*domain.Identity, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT id, display_name, kind, roles, publisher_key_id, disabled, created_at
		 FROM identities WHERE id=$1`, id)
	return scanIdentity(row)
}

func (r *identityRepo) ListIdentities(ctx context.Context) ([]*domain.Identity, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, display_name, kind, roles, publisher_key_id, disabled, created_at
		 FROM identities ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.Identity{}
	for rows.Next() {
		v, err := scanIdentity(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

type rowScanner interface{ Scan(dest ...any) error }

func scanIdentity(row rowScanner) (*domain.Identity, error) {
	var v domain.Identity
	var roles string
	if err := row.Scan(&v.ID, &v.DisplayName, &v.Kind, &roles,
		&v.PublisherKeyID, &v.Disabled, &v.CreatedAt); err != nil {
		return nil, mapErr(err)
	}
	rolesJSON := bytes.TrimSpace([]byte(roles))
	if len(rolesJSON) == 0 || rolesJSON[0] != '[' ||
		json.Unmarshal(rolesJSON, &v.Roles) != nil || !domain.RolesValid(v.Roles) {
		return nil, fmt.Errorf("persisted identity roles are invalid")
	}
	return &v, nil
}

func (r *identityRepo) CreateToken(ctx context.Context, t *domain.APIToken) error {
	scopes, _ := json.Marshal(t.Scopes)
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO api_tokens (id, identity_id, token_hash, scopes, expires_at, revoked, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		t.ID, t.IdentityID, t.TokenHash, string(scopes), t.ExpiresAt, t.Revoked, t.CreatedAt)
	return mapErr(err)
}

func (r *identityRepo) GetTokenByHash(ctx context.Context, hash string) (*domain.APIToken, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT id, identity_id, token_hash, scopes, expires_at, revoked, last_used_at, created_at
		 FROM api_tokens WHERE token_hash=$1`, hash)
	return scanToken(row)
}

func (r *identityRepo) ListTokensByIdentity(ctx context.Context, identityID string) ([]*domain.APIToken, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, identity_id, token_hash, scopes, expires_at, revoked, last_used_at, created_at
		 FROM api_tokens WHERE identity_id=$1 ORDER BY id`, identityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.APIToken{}
	for rows.Next() {
		v, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func scanToken(row rowScanner) (*domain.APIToken, error) {
	var v domain.APIToken
	var scopes string
	var lastUsed sql.NullTime
	if err := row.Scan(&v.ID, &v.IdentityID, &v.TokenHash, &scopes,
		&v.ExpiresAt, &v.Revoked, &lastUsed, &v.CreatedAt); err != nil {
		return nil, mapErr(err)
	}
	scopesJSON := bytes.TrimSpace([]byte(scopes))
	if len(scopesJSON) == 0 || scopesJSON[0] != '[' || json.Unmarshal(scopesJSON, &v.Scopes) != nil {
		return nil, fmt.Errorf("persisted API token scopes are invalid")
	}
	if lastUsed.Valid {
		t := lastUsed.Time
		v.LastUsedAt = &t
	}
	return &v, nil
}

func (r *identityRepo) RevokeToken(ctx context.Context, tokenID string) error {
	res, err := r.db.ExecContext(ctx, `UPDATE api_tokens SET revoked=true WHERE id=$1`, tokenID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

func (r *identityRepo) TouchToken(ctx context.Context, tokenID string, at time.Time) error {
	_, err := r.db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at=$2 WHERE id=$1`, tokenID, at)
	return err
}
