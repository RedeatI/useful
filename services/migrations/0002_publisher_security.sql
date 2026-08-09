-- Phase 9：发布者安全。制品增加独立状态字段（不合并成单一 safe 布尔）；
-- 发布者密钥增加轮换连续性列。security_advisories 已在 0001 定义。
-- 回滚：
--   ALTER TABLE artifacts DROP COLUMN publisher_signature_verified, DROP COLUMN security_scan_passed,
--         DROP COLUMN official_review_passed, DROP COLUMN is_native_worker,
--         DROP COLUMN sbom_digest, DROP COLUMN scan_result_json;
--   ALTER TABLE publisher_keys DROP COLUMN rotated_from;
--   并从 migrations 删除 version=2。

BEGIN;

ALTER TABLE artifacts ADD COLUMN publisher_signature_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE artifacts ADD COLUMN security_scan_passed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE artifacts ADD COLUMN official_review_passed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE artifacts ADD COLUMN is_native_worker BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE artifacts ADD COLUMN sbom_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN scan_result_json TEXT NOT NULL DEFAULT '';

-- 密钥轮换连续性：新密钥交叉签名来源（无则视为新发布者）
ALTER TABLE publisher_keys ADD COLUMN rotated_from TEXT;

INSERT INTO migrations (version, name) VALUES (2, 'publisher_security');

COMMIT;
