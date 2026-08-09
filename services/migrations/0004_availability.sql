-- Phase RC：制品可用性检查（sourceAvailable 真实推导依据）。
-- 回滚：DROP TABLE availability_checks; 并从 migrations 删除 version=4。

BEGIN;

CREATE TABLE availability_checks (
    artifact_sha256      TEXT PRIMARY KEY,
    source_id            TEXT NOT NULL,
    target               TEXT NOT NULL, -- 存储键（绝非用户输入 URL，防 SSRF）
    status               TEXT NOT NULL, -- unknown|healthy|degraded|unavailable
    last_success_at      TIMESTAMPTZ,
    last_failure_at      TIMESTAMPTZ,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    error_category       TEXT NOT NULL DEFAULT '',
    checked_at           TIMESTAMPTZ NOT NULL,
    expires_at           TIMESTAMPTZ NOT NULL
);

INSERT INTO migrations (version, name) VALUES (4, 'availability_checks');

COMMIT;
