-- Useful source-server 初始迁移（PostgreSQL）。
-- 关键约束在数据库层实现：webhook event id 唯一、artifact 身份唯一、审计只追加。
-- 禁止直接删除已发布制品记录：无删除路径，撤回用 status='withdrawn'。

BEGIN;

CREATE TABLE IF NOT EXISTS migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sources (
    id          TEXT PRIMARY KEY,          -- 本服务承载的源（单源模块化单体）
    name        TEXT NOT NULL,
    operator    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE source_capabilities (
    source_id   TEXT NOT NULL REFERENCES sources(id),
    capability  TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (source_id, capability)
);

CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_identities (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    issuer      TEXT NOT NULL,
    subject     TEXT NOT NULL,
    UNIQUE (issuer, subject)
);

CREATE TABLE publishers (
    id          TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 密钥记录只存 public key；绝不存 root/私钥（KMS reference 供生产扩展）
CREATE TABLE publisher_keys (
    key_id      TEXT PRIMARY KEY,          -- ed25519:<hex>
    publisher_id TEXT NOT NULL REFERENCES publishers(id),
    public_key  TEXT NOT NULL,
    kms_reference TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 工具身份 = publisher_key_id + tool_id（同名不同发布者不合并）
CREATE TABLE tools (
    publisher_key_id TEXT NOT NULL REFERENCES publisher_keys(key_id),
    tool_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    license     TEXT NOT NULL DEFAULT '',
    is_native_worker BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (publisher_key_id, tool_id)
);

CREATE TABLE tool_versions (
    id          TEXT PRIMARY KEY,
    publisher_key_id TEXT NOT NULL,
    tool_id     TEXT NOT NULL,
    version     TEXT NOT NULL,
    channel     TEXT NOT NULL DEFAULT 'stable',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (publisher_key_id, tool_id) REFERENCES tools(publisher_key_id, tool_id)
);

-- 版本唯一约束：tool identity + version + platform + arch
CREATE TABLE artifacts (
    id          TEXT PRIMARY KEY,
    publisher_key_id TEXT NOT NULL,
    tool_id     TEXT NOT NULL,
    version     TEXT NOT NULL,
    channel     TEXT NOT NULL,
    platform    TEXT NOT NULL,
    arch        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    size        BIGINT NOT NULL,
    file_name   TEXT NOT NULL,
    permissions JSONB NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'staged',  -- staged|scanned|approved|published|rejected|withdrawn
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    UNIQUE (publisher_key_id, tool_id, version, platform, arch)
);
CREATE UNIQUE INDEX idx_artifacts_sha256 ON artifacts(sha256);
CREATE INDEX idx_artifacts_status ON artifacts(status);

CREATE TABLE catalog_offers (
    publisher_key_id TEXT NOT NULL,
    tool_id     TEXT NOT NULL,
    access_mode TEXT NOT NULL DEFAULT 'free',   -- free|entitlement|external-purchase|private|unavailable
    product_id  TEXT,
    plan_ids    JSONB NOT NULL DEFAULT '[]',
    purchase_url TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (publisher_key_id, tool_id),
    FOREIGN KEY (publisher_key_id, tool_id) REFERENCES tools(publisher_key_id, tool_id)
);

CREATE TABLE channels (
    name        TEXT PRIMARY KEY               -- stable|beta|nightly
);
INSERT INTO channels (name) VALUES ('stable'), ('beta'), ('nightly');

-- 撤回：不删记录
CREATE TABLE release_withdrawals (
    artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),
    reason      TEXT NOT NULL,
    withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE security_advisories (
    id          TEXT PRIMARY KEY,
    publisher_key_id TEXT NOT NULL,
    tool_id     TEXT NOT NULL,
    severity    TEXT NOT NULL,
    summary     TEXT NOT NULL,
    affected_versions JSONB NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE upload_sessions (
    id          TEXT PRIMARY KEY,
    publisher_key_id TEXT NOT NULL,
    staging_key TEXT NOT NULL,
    declared_sha256 TEXT NOT NULL,
    declared_size BIGINT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',  -- open|completed|failed
    error       TEXT NOT NULL DEFAULT '',
    artifact_id TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scan_jobs (
    id          TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    status      TEXT NOT NULL DEFAULT 'queued',
    result      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reviews (
    id          TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    reviewer    TEXT NOT NULL,
    decision    TEXT NOT NULL,                 -- approved|rejected
    note        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL
);

CREATE TABLE plans (
    id          TEXT PRIMARY KEY,
    product_id  TEXT NOT NULL REFERENCES products(id),
    name        TEXT NOT NULL
);

CREATE TABLE billing_customers (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id),
    provider    TEXT NOT NULL,
    provider_customer_id TEXT NOT NULL,
    UNIQUE (provider, provider_customer_id)
);

CREATE TABLE billing_subscriptions (
    id          TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    product_id  TEXT NOT NULL,
    plan_id     TEXT NOT NULL,
    status      TEXT NOT NULL,
    object_time TIMESTAMPTZ NOT NULL,          -- 乱序防护：旧事件不覆盖
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook event id 唯一（幂等/防重放）
CREATE TABLE billing_events (
    event_id    TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    object_time TIMESTAMPTZ NOT NULL,
    processed   BOOLEAN NOT NULL DEFAULT false,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE entitlements (
    id          TEXT PRIMARY KEY,
    subject_id  TEXT NOT NULL,
    product_id  TEXT NOT NULL,
    plan_id     TEXT NOT NULL,
    tool_scope  TEXT NOT NULL DEFAULT '*',
    status      TEXT NOT NULL,                 -- active|trialing|grace|past_due|canceled|expired|revoked
    starts_at   TIMESTAMPTZ NOT NULL,
    expires_at  TIMESTAMPTZ,
    grace_until TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_entitlements_subject ON entitlements(subject_id);

CREATE TABLE download_grants (
    id          TEXT PRIMARY KEY,
    subject_id  TEXT,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    artifact_sha256 TEXT NOT NULL,
    size        BIGINT NOT NULL,
    -- 审计不记录完整临时 URL；此处只存 URL 摘要供排障
    url_digest  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    supports_range BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE download_events (
    id          BIGSERIAL PRIMARY KEY,
    grant_id    TEXT NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    bytes       BIGINT NOT NULL DEFAULT 0
);

-- 审计只追加：撤销 UPDATE/DELETE 权限（应用角色）；本迁移用触发器兜底
CREATE TABLE audit_logs (
    seq         BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT ''
);

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs 是只追加表';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE TABLE job_queue (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
    attempts    INTEGER NOT NULL DEFAULT 0,
    error       TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_queue_status ON job_queue(status, kind);

INSERT INTO migrations (version, name) VALUES (1, 'init');

COMMIT;
