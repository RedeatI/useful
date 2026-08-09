-- Phase RC：Sigstore 身份签名策略 + 制品签名方式/身份记录。
-- 回滚：
--   ALTER TABLE publisher_keys DROP COLUMN identity_issuer, DROP COLUMN identity_san_exact,
--         DROP COLUMN identity_san_pattern;
--   ALTER TABLE artifacts DROP COLUMN signature_method, DROP COLUMN signature_identity;
--   并从 migrations 删除 version=5（回滚后 Sigstore 发布者退回 Ed25519 流程）。

BEGIN;

-- 发布者密钥的 Sigstore 身份策略（issuer 精确 + SAN 精确/受控模式）
ALTER TABLE publisher_keys ADD COLUMN identity_issuer      TEXT NOT NULL DEFAULT '';
ALTER TABLE publisher_keys ADD COLUMN identity_san_exact   TEXT NOT NULL DEFAULT '';
ALTER TABLE publisher_keys ADD COLUMN identity_san_pattern TEXT NOT NULL DEFAULT '';

-- 制品签名方式与身份（独立记录，绝不合并成单一 safe 布尔）
ALTER TABLE artifacts ADD COLUMN signature_method   TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN signature_identity TEXT NOT NULL DEFAULT '';

INSERT INTO migrations (version, name) VALUES (5, 'sigstore_identity');

COMMIT;
