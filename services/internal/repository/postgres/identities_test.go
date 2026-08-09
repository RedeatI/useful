package postgres

import (
	"database/sql"
	"testing"
	"time"
)

type persistedIdentityRow struct {
	roles string
}

func (r persistedIdentityRow) Scan(dest ...any) error {
	*dest[0].(*string) = "identity"
	*dest[1].(*string) = "Identity"
	*dest[2].(*string) = "service-account"
	*dest[3].(*string) = r.roles
	*dest[4].(*string) = ""
	*dest[5].(*bool) = false
	*dest[6].(*time.Time) = time.Unix(1, 0).UTC()
	return nil
}

type persistedTokenRow struct {
	scopes string
}

func (r persistedTokenRow) Scan(dest ...any) error {
	*dest[0].(*string) = "token"
	*dest[1].(*string) = "identity"
	*dest[2].(*string) = "hash"
	*dest[3].(*string) = r.scopes
	*dest[4].(*time.Time) = time.Unix(2, 0).UTC()
	*dest[5].(*bool) = false
	*dest[6].(*sql.NullTime) = sql.NullTime{}
	*dest[7].(*time.Time) = time.Unix(1, 0).UTC()
	return nil
}

func TestPersistedIdentityRolesFailClosed(t *testing.T) {
	for _, roles := range []string{
		`not-json`,
		`null`,
		`{"publisher-owner":true}`,
		`["publisher-owner","future-admin"]`,
	} {
		if _, err := scanIdentity(persistedIdentityRow{roles: roles}); err == nil {
			t.Fatalf("malformed or unknown persisted roles must fail closed: %s", roles)
		}
	}
}

func TestPersistedTokenScopesJSONFailsClosed(t *testing.T) {
	for _, scopes := range []string{`not-json`, `null`, `{"publisher:write":true}`} {
		if _, err := scanToken(persistedTokenRow{scopes: scopes}); err == nil {
			t.Fatalf("malformed persisted scopes must fail closed: %s", scopes)
		}
	}
}
