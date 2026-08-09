-- Phase RC：管理与发布者身份（RBAC）+ API Token（只存 SHA-256 哈希）。
-- 回滚：DROP TABLE api_tokens; DROP TABLE identities;
--       并从 migrations 表删除 version=3（回滚不影响既有发布数据）。

BEGIN;

CREATE TABLE identities (
    id               TEXT PRIMARY KEY,
    display_name     TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'user', -- user | service-account
    roles            TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
    publisher_key_id TEXT NOT NULL DEFAULT '',     -- publisher-* 角色作用域
    disabled         BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    identity_id  TEXT NOT NULL REFERENCES identities(id),
    token_hash   TEXT NOT NULL UNIQUE, -- sha256(明文) hex；明文绝不落库
    scopes       TEXT NOT NULL DEFAULT '[]',
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked      BOOLEAN NOT NULL DEFAULT false,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_tokens_identity ON api_tokens(identity_id);

INSERT INTO migrations (version, name) VALUES (3, 'identities');

COMMIT;
