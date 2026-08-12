# Security assurance

[简体中文](SECURITY-ASSURANCE.md) · English

This page records implemented defenses and matching evidence from attacker and operator views. Read
with [SECURITY.md](../SECURITY.md) and ADR-008/011/012/013/014.

## Trust layers (never one “safe” boolean)

1. **Source TUF signatures**  
   Offline root (threshold) → online targets/snapshot/timestamp.  
   Proves: this source published these bytes.  
   Client rejects expired, rolled-back, or tampered metadata (Rust TUF tests).

2. **Publisher signatures (current first-release install path)**  
   Independent Ed25519 proof over `(toolId, version, sha256)`.  
   Proves: this artifact was produced by a given publisher.  
   Separated from TUF.  
   Sigstore is an isolated/future path. First-release TUF, download grant, and install paths reject
   Sigstore today. Legacy or empty proofs fail closed. No automatic migration.

3. **Official review / security scan / reproducible build / source availability**  
   Separate status fields. UI shows each signal alone.

## Authentication and authorization (ADR-011)

- API token form: `usefuls_` + 32 random bytes. Database stores only SHA-256. Plaintext returns once.
  Compare in constant time. Tokens have scopes, expiry, revoke, and last-used tracking.
- RBAC: seven roles map to scope sets. Token scopes cannot exceed the identity role (no privilege
  escalation; tested).
- 401 (no credentials) and 403 (missing scope) are separate. Anonymous publish endpoints are rejected.
- Production fails closed on static `ADMIN_TOKEN` unless emergency recovery mode is active (≤ 24 h,
  audited, minimal identity/token admin only).
- Sensitive operations write append-only audit. Audit does not store token plaintext/hash, full
  download URLs, or user file paths.

## Sigstore identity (ADR-013; isolated/future; not first-release)

Attacker outcomes:

- Valid CA but wrong SAN → reject
- Wrong issuer → reject
- Wrong or unbound digest → reject
- Expired cert at signing time → reject
- Untrusted CA → reject
- Missing transparency proof (online mode) → reject
- Tampered SET → reject
- Over-broad SAN pattern (multiple `*`) → reject
- No trust root → fail closed
- Malformed bundle (fuzz) → no panic, no false accept

## Reproducible builds (related to ADR-013)

- Author claim only (`reproducible=true`) → status `claimed`, never `verified`
- Dual build mismatch / unbound digest / same builder twice → `failed`
- Invalid provenance signature / wrong builder / unbound digest / parameter mismatch → `failed`
- Catalog `reproducibleBuildVerified` is true only when truly verified

## Source availability (ADR-012)

- Check targets are content-addressed keys of this source only. User-supplied URLs are never accepted
  (structural SSRF block).
- HEAD-only checks. Per-round limits and freshness skips reduce request storms.
- Stale results show `unknown`. Old healthy status is not reused. Error classes do not leak paths.

## Update key isolation (ADR-014)

- Four environment signature domains are separate. Test-domain signatures cannot pass production
  verification (tested).
- Production verification rejects NOT-FOR-PRODUCTION roots. Production root creation is an Owner gate.
- Offline threshold signing. Revoked key signatures are rejected. Private keys do not enter logs.
  On-disk keys use mode 0600.

## Transport and input

- Per-IP rate limits. Request body limits. Unified problem+json errors without internal detail.
- Panic recovery returns 500. Metadata names and target paths use strict allowlists (path traversal
  block).
- Paid download subject comes only from validated bearer tokens. Request body subject is not trusted.
- Windows one-click elevation is disabled (`canRequest=false`). Portable and user-writable installs
  cannot prove image identity across delayed restart. For ETW or protected-process rights, the user
  must exit and start Useful as administrator from the Windows shell. The app does not call PowerShell
  or a same-directory helper that can be replaced.

## Supply chain

- Go native fuzz on domain validators and Sigstore bundles: multi-million executions, no crash corpus
- SBOM generation: `scripts/gen-sbom.mjs` → `dist-sbom/sbom.cdx.json`
- Migrations use advisory locks
- Pinned toolchains: pnpm@9.15.0, rust-toolchain.toml (1.97.1), go.mod

## Still open (does not block RC by itself; see Known limitations)

- Full Rekor Merkle inclusion proof and online Fulcio rotation
- Pin GitHub Actions to commit SHAs
- Container image vulnerability scan
- Full cargo audit/deny in CI

## Related pages

- Report vulnerabilities: [SECURITY.md](../SECURITY.md)
- Product limits: [Known limitations](KNOWN-LIMITATIONS.en.md)

Full Chinese detail: [SECURITY-ASSURANCE.md](SECURITY-ASSURANCE.md).
