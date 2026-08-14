# Owner signing and release-publish gate checklist

This page is the practical fill-in list for a **signed** Useful desktop Release through
`.github/workflows/release.yml`. It mirrors the live gate scripts:

- `scripts/release-publish-gate.mjs`
- `scripts/release-metadata.mjs`
- `scripts/release-signing-status.mjs`
- `docs/OWNER-GATES.md`

It is **not** a publication authorization. Values marked **secret** must never be committed.

## Current remote snapshot (2026-08-14)

| Item | Status |
| --- | --- |
| Public repo `RedeatI/useful` | present |
| GitHub Actions **variable** `USEFUL_EXPECTED_REPOSITORY` | set |
| GitHub Actions **variable** `USEFUL_RELEASE_ACTORS` | set |
| GitHub Actions **environment** `release` | present |
| Update-root / feed / ceremony variables | set; `updateTrustReady=true` |
| Windows / Apple signing **secrets** | **missing** (none listed on the repo) |
| Latest desktop assets | unsigned prerelease [`v0.1.0-beta.11`](https://github.com/RedeatI/useful/releases/tag/v0.1.0-beta.11) |

Until the missing items are filled and verified, only **unsigned preview** Releases are honest.

---

## 0. Decision map

| Goal | Channel | Minimum extra gates |
| --- | --- | --- |
| Unsigned Windows preview (already done) | `release.yml`, `beta`, `desktop-lite`, prerelease | exact CI, legal, source, provenance, and publish authorization gates |
| Signed **beta** via `release.yml` + `publish=true` | `beta` | §1 identity + §2 update trust + §3 Windows secrets (+ §4 if macOS assets required) |
| Signed **stable** via `release.yml` + `publish=true` | `stable` | all of beta + §5 stable evidence + `USEFUL_SIGNING_READY=true` + verified signing status |
| Public **Portable Full** with ffmpeg/mpv | any public Full | §6 media source compliance Owner Gate |

---

## 1. Repository identity (Actions **variables**)

Configure under:  
GitHub → `RedeatI/useful` → Settings → Secrets and variables → Actions → **Variables**

| Variable | Required value / format | Current | Local check |
| --- | --- | --- | --- |
| `USEFUL_EXPECTED_REPOSITORY` | exact `RedeatI/useful` | set | must equal `github.repository` |
| `USEFUL_RELEASE_ACTORS` | comma/space list of **exact** GitHub logins allowed to dispatch publish | set | actor of the workflow run must be in the list |
| `USEFUL_SIGNING_READY` | `true` only after Windows + macOS signing evidence is real; else omit or `false` | missing → defaults `false` | stable path requires `true` |

### Acceptance commands

```powershell
# Who is allowed to publish?
gh api repos/RedeatI/useful/actions/variables/USEFUL_RELEASE_ACTORS --jq .value

# Expected repository identity
gh api repos/RedeatI/useful/actions/variables/USEFUL_EXPECTED_REPOSITORY --jq .value
```

### Dry-run gate (will fail until §2 is filled)

```powershell
cd <repo-root>
node scripts/release-publish-gate.mjs `
  --repository RedeatI/useful `
  --expected-repository RedeatI/useful `
  --visibility public `
  --actor <YOUR_GITHUB_LOGIN> `
  --allowed-actors "<paste USEFUL_RELEASE_ACTORS value>" `
  --publish true `
  --scope desktop-lite `
  --channel beta `
  --update-root-pubkey "<64-hex-ed25519-pubkey>" `
  --update-feed-template "https://updates.example.com/{channel}/{platform}/{arch}/latest.json" `
  --root-ceremony-sha256 "<64-hex-non-zero>" `
  --repo-root .
```

Rules enforced by the script:

- repository is **public**
- actor ∈ allowlist
- update root is 64 hex chars, **not** the development placeholder  
  `3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29`
- feed template is **HTTPS**, no credentials/fragment, placeholders exactly  
  `{channel}` `{platform}` `{arch}`
- ceremony digest is non-zero SHA-256

---

## 2. Production update trust (Actions **variables**)

| Variable | Meaning | Format |
| --- | --- | --- |
| `USEFUL_UPDATE_ROOT_PUBKEY_HEX` | Ed25519 public key of the **production** update root | 64 lowercase/uppercase hex chars (32 bytes) |
| `USEFUL_UPDATE_FEED_URL_TEMPLATE` | Where clients fetch update metadata | HTTPS URL with `{channel}{platform}{arch}` |
| `USEFUL_UPDATE_ROOT_CEREMONY_SHA256` | SHA-256 of the committed ceremony receipt / dossier | 64 hex, non-zero |

### How to produce a production root (offline Owner ceremony)

Do this on an offline or controlled machine. Do **not** commit private keys.

```powershell
cd <repo-root>
$prodRoot = "D:\secure\useful-update-root-production"   # outside the git tree
# Production init (Owner Gate). Follow OWNER-GATES OG-1.
node packages/useful-cli/bin/useful.mjs key init-root $prodRoot --env production --threshold 2 --roots 3 --json
# Sign with threshold keys held by different Owners (paths are examples only):
node packages/useful-cli/bin/useful.mjs key sign-root $prodRoot --key <root-1.private.pem> --json
node packages/useful-cli/bin/useful.mjs key sign-root $prodRoot --key <root-2.private.pem> --json
node packages/useful-cli/bin/useful.mjs key verify-ceremony $prodRoot --json
# Production verifier must reject a test root:
node packages/useful-cli/bin/useful.mjs key verify-ceremony $prodRoot --production --json
```

Then:

1. Export the **public** root key hex into `USEFUL_UPDATE_ROOT_PUBKEY_HEX`.
2. Store private keys in HSM / offline media only.
3. Commit a ceremony receipt (or dossier) that is hashed into `USEFUL_UPDATE_ROOT_CEREMONY_SHA256`.
4. Deploy a real HTTPS feed matching `USEFUL_UPDATE_FEED_URL_TEMPLATE`.

### Feed template examples (structure only)

```text
https://updates.your-domain.example/useful/{channel}/{platform}/{arch}/latest.json
https://cdn.your-domain.example/v1/app-update/{channel}/{platform}/{arch}.json
```

Invalid: `http://…`, `*.example` / `localhost`, missing any of the three placeholders, credentials in URL.

---

## 3. Windows code signing (Actions **secrets**)

Configure under:  
Settings → Secrets and variables → Actions → **Secrets**  
(and/or Environment `release` secrets if you bind the job to that environment)

| Secret | Content |
| --- | --- |
| `WINDOWS_CERTIFICATE_BASE64` | PKCS#12 / PFX file, base64-encoded (no line breaks preferred) |
| `WINDOWS_CERTIFICATE_PASSWORD` | PFX password |

`release.yml` imports the PFX ephemerally on the Windows runner, signs, then removes materials.

### Prepare the secret (Owner machine)

```powershell
# Example only — use your real EV/OV code-signing PFX
$pfx = "D:\secure\useful-codesign.pfx"
[Convert]::ToBase64String([IO.File]::ReadAllBytes($pfx)) | Set-Clipboard
# Paste into GitHub secret WINDOWS_CERTIFICATE_BASE64
```

### Local smoke (optional, never commit the PFX)

```powershell
# After building MSI/NSIS, sign with your org's tool (signtool example):
signtool sign /fd SHA256 /f useful-codesign.pfx /p <password> /tr http://timestamp.digicert.com /td SHA256 `
  .\Useful-0.1.0-beta.x-windows-x64.msi
signtool verify /pa .\Useful-0.1.0-beta.x-windows-x64.msi
```

Workflow acceptance: `SIGNING-STATUS.json` reports Windows signature verified;  
`USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST` must be **unset** on the production release job.

---

## 4. macOS signing and notarization (Actions **secrets**)

Required together for stable/macOS signed path:

| Secret | Content |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application certificate, base64 of `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_KEYCHAIN_PASSWORD` | ephemeral keychain password used by the job |
| `APPLE_ID` | Apple ID for notarytool |
| `APPLE_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | 10-character Team ID |

If any one is missing, `release.yml` treats macOS signing as incomplete. Stable with macOS assets is blocked.

---

## 5. Stable-only evidence (Actions **variables** + committed file)

Only when `channel=stable` and `publish=true`:

| Variable | Meaning |
| --- | --- |
| `USEFUL_STABLE_UPDATE_EVIDENCE_PATH` | repo-relative path under `docs/releases/` |
| `USEFUL_STABLE_UPDATE_EVIDENCE_SHA256` | SHA-256 of that committed file |

Evidence JSON schema: `useful.stable-update-evidence.v1` with:

- `tag` = exact git tag
- `updateRootFingerprint` = SHA-256 of the production root **pubkey bytes** (gate output)
- `updateManifestSha256` non-zero
- `updateSignatureVerified`, `tamperRejected`, `upgradeVerified`, `rollbackVerified` all `true`
- `approvedBy` + parseable `approvedAt`

Example path pattern: `docs/releases/0.1.0-stable-update-evidence.json`  
(see also `docs/releases/` for existing note style).

```powershell
Get-FileHash docs\releases\<evidence>.json -Algorithm SHA256
# put hash into USEFUL_STABLE_UPDATE_EVIDENCE_SHA256
```

Also set:

```text
USEFUL_SIGNING_READY=true
```

only after Windows **and** macOS signing/notarization are actually verified in CI artifacts.

---

## 6. Public Portable Full / GPL media (optional Owner Gate)

For **public** Full edition assets with ffmpeg/ffprobe/mpv:

| Variable | Meaning |
| --- | --- |
| `USEFUL_MEDIA_SOURCE_EVIDENCE_PATH` | committed evidence JSON path |
| `USEFUL_MEDIA_SOURCE_EVIDENCE_SHA256` | SHA-256 of that file |

Evidence schema: `useful.media-source-compliance-evidence.v1`, bound to  
`scripts/media-runtimes.lock.json`, with complete corresponding-source, build, and license assets  
mapped to GitHub Release asset basenames.

Without this, Full remains `NOT-FOR-PUBLIC-DISTRIBUTION`. Lite portable/MSI can still ship.

---

## 7. Security and community prerequisites (non-Actions)

| Gate | How to verify | Required before |
| --- | --- | --- |
| Private Vulnerability Reporting | Repo → Security → Advisories → **Report a vulnerability** works | inviting vulnerability reports / opening Issues |
| CoC enforcement contact | named in community docs / GitHub org | public contribution intake |
| Branch protection on `main` | Settings → Branches | treating CI as release evidence |
| `release` environment reviewers | Settings → Environments → `release` | optional but recommended for `publish=true` |

```powershell
# Manual: open the private report UI while logged out of maintainer role if possible
start https://github.com/RedeatI/useful/security/advisories/new
```

---

## 8. End-to-end publish procedure (after §1–§3 filled)

### 8.1 Preflight on a clean checkout of the exact tag commit

```powershell
git fetch origin
git checkout vX.Y.Z-beta.N   # existing annotated tag, or create after freeze
git status --porcelain       # must be empty
node scripts/check-version-drift.mjs --json
node scripts/release-readiness.mjs --json
# expect publicationAuthorized:false from readiness; it is local preflight only
```

### 8.2 Local dry-run of publish gate (beta)

Fill real values from GitHub Variables (do not print secrets):

```powershell
node scripts/release-publish-gate.mjs `
  --repository RedeatI/useful `
  --expected-repository RedeatI/useful `
  --visibility public `
  --actor <login-in-USEFUL_RELEASE_ACTORS> `
  --allowed-actors "<USEFUL_RELEASE_ACTORS>" `
  --publish true `
  --scope desktop-lite `
  --channel beta `
  --update-root-pubkey "<USEFUL_UPDATE_ROOT_PUBKEY_HEX>" `
  --update-feed-template "<USEFUL_UPDATE_FEED_URL_TEMPLATE>" `
  --root-ceremony-sha256 "<USEFUL_UPDATE_ROOT_CEREMONY_SHA256>" `
  --repo-root .
```

Exit 0 is required before trusting a workflow publish run.

### 8.3 Dispatch official workflow

1. Push/create the **existing** tag on the frozen commit (workflow requires `ref_type=tag`).
2. Actions → **Useful Release** → Run workflow  
   - Use workflow from the **tag**  
   - scope: `desktop-lite` for the Windows Lite closed set, or `desktop-full` only after the media Owner Gate closes
   - channel: `beta` or `stable`  
   - publish: `true` only when gates are ready  
3. Confirm required checks on that SHA are green (listed in `release.yml`).
4. Download `SIGNING-STATUS.json` from the workflow artifact and confirm `signed=true` for the claimed platforms.

### 8.4 Post-publish verification

```powershell
gh release view vX.Y.Z-beta.N --repo RedeatI/useful
# Download MSI and verify Authenticode:
Get-AuthenticodeSignature .\Useful-*.msi | Format-List *
# Compare SHA256SUMS from the Release
```

---

## 9. Fill-in worksheet (Owner)

Copy this table into an internal ticket. Do not paste secret material into git.

| # | Item | Owner | Value location | Done? | Verified by command/result |
| --- | --- | --- | --- | --- | --- |
| 1 | `USEFUL_EXPECTED_REPOSITORY` | | Actions variable | [x] | `gh api .../variables/...` |
| 2 | `USEFUL_RELEASE_ACTORS` | | Actions variable | [x] | contains dispatch login |
| 3 | Production update root ceremony | | offline / HSM | [ ] | `key verify-ceremony --production` |
| 4 | `USEFUL_UPDATE_ROOT_PUBKEY_HEX` | | Actions variable | [ ] | 64 hex, not dev placeholder |
| 5 | `USEFUL_UPDATE_FEED_URL_TEMPLATE` | | Actions variable | [ ] | HTTPS dry resolve |
| 6 | `USEFUL_UPDATE_ROOT_CEREMONY_SHA256` | | Actions variable | [ ] | matches committed receipt |
| 7 | `WINDOWS_CERTIFICATE_BASE64` | | Actions secret | [ ] | workflow import step green |
| 8 | `WINDOWS_CERTIFICATE_PASSWORD` | | Actions secret | [ ] | with #7 |
| 9 | Apple secrets (6 names in §4) | | Actions secrets | [ ] | notarization ticket valid |
| 10 | `USEFUL_SIGNING_READY=true` | | Actions variable | [ ] | only after #7–#9 |
| 11 | Stable evidence file + vars | | `docs/releases/` + variables | [ ] | stable gate only |
| 12 | Media Full evidence (optional) | | variables + committed JSON | [ ] | Full public only |
| 13 | Private Vulnerability Reporting | | GitHub Security UI | [ ] | report button works |
| 14 | First signed beta workflow run | | Actions run URL | [ ] | `SIGNING-STATUS.json` |

---

## 10. Honest claim matrix

| Situation | Allowed public claim |
| --- | --- |
| Current `v0.1.0-beta.11` desktop assets | Unsigned Windows developer-trust preview |
| Agent Kit on that Release | Buildable kit; `publicationAuthorized: false` |
| Vars §1 only, no secrets | Cannot claim signed Release |
| §1–§3 complete, beta workflow green | Signed **beta** Windows desktop Release |
| §1–§5 complete, stable workflow green | Signed **stable** multi-platform Release (per actual platforms built) |
| §6 incomplete | Must not publicly ship Portable Full with GPL media |

---

## Related documents

- [OWNER-GATES.md](OWNER-GATES.md) — commercial Owner gates overview  
- [OPEN-SOURCE-REMAINING-GATES.md](OPEN-SOURCE-REMAINING-GATES.md) — public-source status  
- [OPEN-SOURCE-RELEASE.md](OPEN-SOURCE-RELEASE.md) — full readiness checklist  
- [RELEASE-CHANNELS.md](RELEASE-CHANNELS.md) — channel / tag rules  
- [SECURITY.md](../SECURITY.md) — vulnerability reporting  
