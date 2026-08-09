-- Persist independently verifiable publisher proof and the monotonic TUF
-- metadata version. Existing rows are intentionally not guessed/repaired:
-- legacy empty-proof artifacts require explicit re-release or revalidation.
-- Rollback: DROP TABLE tuf_metadata_state;
--           ALTER TABLE artifacts DROP COLUMN publisher_signature;
--           ALTER TABLE artifacts DROP CONSTRAINT artifacts_status_known;
--           ALTER TABLE upload_sessions DROP CONSTRAINT upload_sessions_status_known;
--           ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_scopes_known;
--           ALTER TABLE identities DROP CONSTRAINT identities_roles_known,
--               DROP CONSTRAINT identities_publisher_role_binding,
--               DROP CONSTRAINT identities_publisher_key_canonical;
--           ALTER TABLE publisher_keys DROP CONSTRAINT publisher_keys_material_matches_id,
--               DROP CONSTRAINT publisher_keys_rotation_canonical,
--               DROP CONSTRAINT publisher_keys_canonical_id;

BEGIN;

ALTER TABLE artifacts ADD COLUMN publisher_signature TEXT NOT NULL DEFAULT '';

ALTER TABLE artifacts ADD CONSTRAINT artifacts_status_known CHECK (
    status IN ('staged', 'scanned', 'approved', 'publish-pending',
               'published', 'withdraw-pending', 'rejected', 'withdrawn')
) NOT VALID;

-- NOT VALID preserves legacy rows for explicit operator handling while still
-- enforcing canonical identifiers for all new/updated publisher keys.
ALTER TABLE publisher_keys ADD CONSTRAINT publisher_keys_canonical_id CHECK (
    key_id ~ '^ed25519:[a-f0-9]{64}$'
    OR key_id ~ '^sigstore:[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
) NOT VALID;

ALTER TABLE publisher_keys ADD CONSTRAINT publisher_keys_material_matches_id CHECK (
    (key_id ~ '^ed25519:[a-f0-9]{64}$'
        AND public_key = substring(key_id FROM 9)
        AND identity_issuer = '' AND identity_san_exact = '' AND identity_san_pattern = '')
    OR
    (key_id ~ '^sigstore:[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
        AND public_key = '' AND identity_issuer <> ''
        AND ((identity_san_exact <> '') <> (identity_san_pattern <> '')))
) NOT VALID;

ALTER TABLE publisher_keys ADD CONSTRAINT publisher_keys_rotation_canonical CHECK (
    rotated_from IS NULL
    OR (key_id ~ '^ed25519:[a-f0-9]{64}$' AND rotated_from ~ '^ed25519:[a-f0-9]{64}$')
) NOT VALID;

ALTER TABLE identities ADD CONSTRAINT identities_publisher_key_canonical CHECK (
    publisher_key_id = ''
    OR publisher_key_id ~ '^ed25519:[a-f0-9]{64}$'
    OR publisher_key_id ~ '^sigstore:[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
) NOT VALID;

ALTER TABLE identities ADD CONSTRAINT identities_roles_known CHECK (
    jsonb_typeof(roles::jsonb) = 'array'
    AND roles::jsonb <@ '["instance-admin","source-admin","publisher-owner","publisher-maintainer","publisher-viewer","reviewer","security-reviewer"]'::jsonb
) NOT VALID;

ALTER TABLE identities ADD CONSTRAINT identities_publisher_role_binding CHECK (
    (roles::jsonb ?| ARRAY['publisher-owner','publisher-maintainer','publisher-viewer'])
    = (publisher_key_id <> '')
) NOT VALID;

ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_scopes_known CHECK (
    jsonb_typeof(scopes::jsonb) = 'array'
    AND scopes::jsonb <@ '["publisher:write","publisher:withdraw","publisher:advisory","publisher:keys","review:write","admin:identities","admin:tokens"]'::jsonb
) NOT VALID;

ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_status_known CHECK (
    status IN ('open', 'completed', 'failed', 'release-claimed')
) NOT VALID;

CREATE TABLE tuf_metadata_state (
    singleton   BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    last_version BIGINT NOT NULL CHECK (last_version > 0)
);

INSERT INTO migrations (version, name) VALUES (7, 'publisher_proof');

COMMIT;
