-- Phase RC：复现构建验证状态（可信 reproducibleBuildVerified）。
-- 回滚：
--   ALTER TABLE artifacts DROP COLUMN reproducible_claimed, DROP COLUMN repro_status,
--         DROP COLUMN repro_strategy;
--   并从 migrations 删除 version=6（回滚后 reproducibleBuildVerified 恒为 false）。

BEGIN;

-- 作者声明与官方验证严格分离，绝不合并
ALTER TABLE artifacts ADD COLUMN reproducible_claimed BOOLEAN NOT NULL DEFAULT false;
-- 状态机：unknown|claimed|verification-pending|verified|failed
ALTER TABLE artifacts ADD COLUMN repro_status   TEXT NOT NULL DEFAULT '';
-- 验证策略：dual-build|provenance（verified 时记录）
ALTER TABLE artifacts ADD COLUMN repro_strategy TEXT NOT NULL DEFAULT '';

INSERT INTO migrations (version, name) VALUES (6, 'reproducibility');

COMMIT;
