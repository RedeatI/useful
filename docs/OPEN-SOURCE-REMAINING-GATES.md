# Open-source remaining gates (status)

Date: 2026-08-12  
Public repository: `https://github.com/RedeatI/useful`  
Baseline commit for this note: `e381429` (beta.4 version align + npm audit cleanups).

This page is a working status against [OPEN-SOURCE-RELEASE.md](OPEN-SOURCE-RELEASE.md).  
It is not a publication authorization.

## Status legend

- **done**: evidence exists on the public repository or in a named Release
- **partial**: code or docs exist; required evidence is incomplete
- **blocked**: Owner action, keys, or platform runners still missing
- **n/a**: not claimed for the current channel

## 1. Repository identity and community

| Gate | Status | Notes |
| --- | --- | --- |
| Canonical public repo `RedeatI/useful` | done | Public |
| Useful product identity consistency | done | README and package names use Useful |
| Root LICENSE / LICENSES map | partial | Files present; each release still needs candidate-specific legal review |
| Private Vulnerability Reporting enabled and tested | done | API `private-vulnerability-reporting.enabled=true` (2026-08-12); Owner should still click **Report a vulnerability** once in the UI |
| Public Issues / contribution intake | partial | `has_issues=true` (0 open); CoC still requires a named enforcement contact before inviting drive-by PRs |
| Branch protection and review rules | done | `main` has protection (linear history, no force-push, conversation resolution); `required_approving_review_count` is still 0 |

## 2. Source publication path

| Gate | Status | Notes |
| --- | --- | --- |
| Sanitized public history | done | Public main exists |
| Source + Agent Kit preview Release | done | `v0.1.0-beta.3` history; **current** kit also on `v0.1.0-beta.4` |
| Unsigned Windows desktop preview Release | done | `v0.1.0-beta.4` portable / MSI / setup / bundle + SHA256SUMS (development-trust only) |
| Desktop binaries in an official signed Release | blocked | Windows Authenticode and production update trust missing |

## 3. Local and remote verification

| Gate | Status | Notes |
| --- | --- | --- |
| Windows source build path | partial | Local release/portable packaging path exists; portable smoke launch OK on build machine |
| macOS real runner build | blocked | CI config is not runner proof |
| Linux real runner build | blocked | CI config is not runner proof |
| Required CI green on release commit | partial | Re-check before any `release.yml` publish=true run |
| npm audit clean | done | `pnpm audit` clean after overrides (2026-08-12) |
| Rust Dependabot open alerts | partial | One open medium: `glib` (see §7) |

## 4. Release and update trust

| Gate | Status | Notes |
| --- | --- | --- |
| Production code signing (Windows) | blocked | Owner PFX / `WINDOWS_CERTIFICATE_*` secrets |
| macOS signing and notarization | blocked | Owner credentials / six `APPLE_*` secrets |
| Production update root variables | done | `USEFUL_UPDATE_ROOT_*` + feed template present; `updateTrustReady=true` |
| Production update feed with real signed manifests | blocked | Placeholders only until signed Release |
| Development-trust unsigned Windows preview packages | done | Published on `v0.1.0-beta.4`; labeled non-production |
| Portable Full / GPL media | blocked | Corresponding-source Owner Gate |
| Agent Kit closed MANIFEST + legal files | partial | Preview kit attached on beta.4; keep `publicationAuthorized:false` claims honest |
| `signedBetaPublishReady` | blocked | `node scripts/check-owner-signing-gates.mjs --json` → false until Windows secrets |

## 5. Third-party Agent path

| Gate | Status | Notes |
| --- | --- | --- |
| BUILD-A-TOOL non-interactive path | partial | Documented; re-run on release candidate |
| Default 36 Actions / 40 MCP tools | done | Documented and tested in source |

## 6. Documentation language

| Gate | Status | Notes |
| --- | --- | --- |
| Bilingual README STE rewrite | done | PR #17 and follow-ups |
| English entry pages for main README links | done | See [README-I18N.md](README-I18N.md) |
| Real UI screenshots in README | partial | Three PNG screenshots present; optional refresh from current UI |
| Local 宣发 pack (not in repo) | partial | Owner local pack aligned to beta.4; not required on GitHub |

## 7. Known open Dependabot (Rust)

| Alert | Package | Severity | Why open |
| --- | --- | --- | --- |
| #1 GHSA-wrw7-89jp-8q8g | `glib` 0.18.x | medium | Fixed in `glib` 0.20.0. Tree is pinned through `gtk` 0.18.x / Tauri 2 Linux path; cannot bump alone without breaking gtk-rs alignment. Windows primary channel does not exercise this iterator path the same way. Track upstream Tauri/gtk-rs upgrade. |

Do not force-edit `Cargo.lock` to a mismatched gtk/glib pair. Prefer waiting for a Tauri-compatible upgrade line, then re-run Dependabot.

## Minimum next Owner actions

1. Buy or issue Windows Code Signing certificate; run `scripts/upload-windows-code-sign-secrets.ps1`.
2. Optional: add all six `APPLE_*` secrets for macOS signing and notarization.
3. Run `node scripts/check-owner-signing-gates.mjs --json` until `signedBetaPublishReady` is true.
4. Run real macOS and Linux build jobs; store logs and artifact digests with the candidate SHA.
5. Name a CoC enforcement contact (or keep contribution intake limited).
6. Manually re-test the GitHub **Report a vulnerability** UI once.
7. After signed Release: publish real update-feed manifests (not placeholders).

## Related

- [OWNER-SIGNING-GATE-CHECKLIST.md](OWNER-SIGNING-GATE-CHECKLIST.md) — variables, secrets, verification commands
- [OWNER-WINDOWS-CODE-SIGN-GUIDE.zh-CN.md](OWNER-WINDOWS-CODE-SIGN-GUIDE.zh-CN.md) — certificate purchase and upload
- [OWNER-GATES.md](OWNER-GATES.md) — commercial Owner gates
- [TASK-EXECUTION-LOG-2026-08-12.md](TASK-EXECUTION-LOG-2026-08-12.md) — same-day execution notes

## Current desktop packaging claim boundary

Until production signing and update trust pass:

- Publish desktop MSI / portable artifacts only as **prerelease**, **unsigned**,
  **development-trust** previews.
- Do not mark them as latest stable.
- Do not claim notarization, SmartScreen trust, or production auto-update.
