# Cloud package storage (P0 prep)

Date: 2026-08-12  
Status: **spec draft for implementation**  
Parent: [PRODUCT-ENRICHMENT-ROADMAP.md](PRODUCT-ENRICHMENT-ROADMAP.md) §5

This document freezes the **content-addressed object layout** and trust rules for storing
`.useful` packages in low-cost object storage. It does not authorize a production SaaS launch.

## Problem

Authors can already `pack` → `sign` → `source publish` → `export-static` locally. Distribution
still needs a place to put bytes that:

1. stays **cheap** (static HTTPS, R2/S3/MinIO);
2. keeps **publisher + artifact digest** as the trust root;
3. reuses Source Center / downloads / ADR-012 availability checks;
4. never turns Useful into an arbitrary file host.

## Decisions

### D1 — Content-addressed keys only

```text
{origin}/sha256/{lowercaseHexSha256}
```

- `lowercaseHexSha256` is the artifact digest from pack/sign.
- Clients must not install from an arbitrary pasted URL outside a configured source origin.
- Overwrite of the same key is allowed only if bytes are identical (idempotent put).

### D2 — Metadata beside objects (static-source compatible)

Prefer layouts that `export-static` can already emit, plus optional storage mirror:

```text
{origin}/
  catalog.json          # or TRP catalog document
  packages/
    {packageId}/
      {version}.json    # metadata pointer including sha256 + size
  sha256/
    {digest}            # raw .useful bytes
  signatures/
    {digest}.publisher-signature.json
```

Exact file names may match the current static export; implementers must document a 1:1 map in
the PR that adds `sync-storage`.

### D3 — Credentials never in the repo

| Env (example) | Purpose |
| --- | --- |
| `USEFUL_STORAGE_ENDPOINT` | S3-compatible API endpoint |
| `USEFUL_STORAGE_REGION` | region if required |
| `USEFUL_STORAGE_BUCKET` | bucket name |
| `USEFUL_STORAGE_ACCESS_KEY` | access key |
| `USEFUL_STORAGE_SECRET_KEY` | secret |
| `USEFUL_STORAGE_PUBLIC_BASE_URL` | HTTPS origin clients use |

GitHub Actions may use OIDC later; not required for P0 CLI.

### D4 — Trust order (unchanged)

```text
discover → download by digest key → verify size → verify publisher signature → install
```

Cloud storage failure ≠ signature success. Signature success ≠ user-granted Agent profile.

### D5 — SSRF / open-proxy ban

Availability and download targets are **only**:

- keys under the source’s configured origin, or
- `storage.PublishedKey(sha)` style internal keys on a dynamic source

No user-supplied free-form URL fetch in the install path.

## CLI surface (P0-1b target)

Proposed commands (names adjustable, behavior not):

```text
useful source storage doctor   --json
useful source storage dry-run  --source <dir> --json
useful source storage push     --source <dir> --json
useful source storage verify   --source <dir> --json   # remote Head matches local
```

Exit non-zero on size mismatch, missing object, or bad credentials.

## Client surface (P0-1c target)

- Source Center lists storage-backed sources with last availability.
- Downloads queue shows digest + verify step.
- Errors use stable codes: `object_missing`, `size_mismatch`, `signature_invalid`, `network`.

## Cost tiers

| Tier | Mechanism | When |
| --- | --- | --- |
| 0 | `export-static` + any static host / GitHub Release | default P0 |
| 1 | S3-compatible push (`storage push`) | multi-package authors |
| 2 | Dynamic source API + Head checks (ADR-012) | official/pro scale |

## Out of scope (this doc)

- Multipart resumable UI polish (may use SDK defaults)
- Billing / quotas (see FREE-AND-PRO)
- Scanning user documents in the cloud
- Replacing local portable desktop distribution

## Implementation checklist

- [ ] Map current `export-static` tree → `sha256/` keys
- [ ] Add storage doctor/dry-run/push/verify to CLI
- [ ] Integration test with MinIO in CI or local compose
- [ ] Source Center display + download verify
- [ ] Threat note: malicious catalog pointing to wrong digest must fail pin checks

## Related

- [PRODUCT-ENRICHMENT-ROADMAP.md](PRODUCT-ENRICHMENT-ROADMAP.md)
- [adr/ADR-012-source-availability.md](adr/ADR-012-source-availability.md)
- [adr/ADR-006-federated-repositories.md](adr/ADR-006-federated-repositories.md)
- [agent/BUILD-A-TOOL.md](agent/BUILD-A-TOOL.md)
- [FREE-AND-PRO-TOOLS.md](FREE-AND-PRO-TOOLS.md)
