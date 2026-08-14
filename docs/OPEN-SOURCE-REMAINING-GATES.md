# Open-source remaining gates (status)

Date: 2026-08-15
Public repository: `https://github.com/RedeatI/useful`  
Baseline for this note: the `v0.1.0-beta.11` unsigned preview release candidate; the immutable tag
identifies the exact release commit.

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
| Private Vulnerability Reporting enabled and tested | partial | API `private-vulnerability-reporting.enabled=true` (rechecked 2026-08-14); Owner UI click-through remains |
| Public Issues / contribution intake | partial | `has_issues=true` (0 open); CoC still requires a named enforcement contact before inviting drive-by PRs |
| Branch protection and review rules | done | `main` has protection (linear history, no force-push, conversation resolution); `required_approving_review_count` is still 0 |

## 2. Source publication path

| Gate | Status | Notes |
| --- | --- | --- |
| Sanitized public history | done | Public main exists |
| Source + Agent Kit preview Release | done | Current closed-set Agent Kit is on [`v0.1.0-beta.11`](https://github.com/RedeatI/useful/releases/tag/v0.1.0-beta.11) |
| Unsigned Windows desktop preview Release | done | `v0.1.0-beta.11` Portable Lite + Setup Lite + `SHA256SUMS.txt` (development-trust only) |
| Desktop binaries in an official signed Release | blocked | Windows Authenticode and production update trust missing |

## 3. Local and remote verification

| Gate | Status | Notes |
| --- | --- | --- |
| Windows source build path | partial | Local release/portable packaging path exists; portable smoke launch OK on build machine |
| macOS real runner build | done | `Platform Bundles` run `31766070800` built x86_64 + aarch64 preview bundles at `737d9bc`; not notarized or released |
| Linux real runner build | done | `Platform Bundles` run `31766070800` built x86_64 preview bundle at `737d9bc`; not released |
| Required CI green on release commit | done | CI `31766066618`, CodeQL `31766068891`, and Platform Bundles `31766070800` passed at `737d9bc` before publish |
| npm audit clean | done | `pnpm audit` clean after overrides (2026-08-12) |
| Rust Dependabot open alerts | done | GitHub API returned zero open alerts after alert #1 was dismissed as `not_used` (2026-08-13; see §7) |

## 4. Release and update trust

| Gate | Status | Notes |
| --- | --- | --- |
| Production code signing (Windows) | blocked | Owner PFX / `WINDOWS_CERTIFICATE_*` secrets |
| macOS signing and notarization | blocked | Owner credentials / six `APPLE_*` secrets |
| Production update root variables | done | `USEFUL_UPDATE_ROOT_*` + feed template present; `updateTrustReady=true` |
| Production update feed with real signed manifests | blocked | Placeholders only until signed Release |
| Development-trust unsigned Windows preview packages | done | Published on `v0.1.0-beta.11`; labeled unsigned prerelease |
| Portable Full / GPL media | blocked | Corresponding-source Owner Gate |
| Agent Kit closed MANIFEST + legal files | done | `v0.1.0-beta.11` attached the kit, source manifest, legal files, provenance, and checksums as one read-back-verified closed set |
| `signedBetaPublishReady` | blocked | `node scripts/check-owner-signing-gates.mjs --json` → false until Windows secrets |

## 5. Third-party Agent path

| Gate | Status | Notes |
| --- | --- | --- |
| BUILD-A-TOOL non-interactive path | done | Published beta.10 Kit passed Windows create → doctor → validate → pack → sign/verify → runtime → legacy/modern MCP acceptance; see [evidence](releases/0.1.0-beta.10-agent-kit-acceptance.md) |
| Published Kit on Node.js 20 + platform launchers | done | `Platform Bundles` run `31781531217` passed Windows x64, macOS arm64 and Linux x64 against the exact beta.10 ZIP; Windows/POSIX launchers, 36 Actions, worker calls and 40-tool MCP surfaces passed |
| Default 36 Actions / 40 MCP tools | done | Documented and tested in source |

## 6. Documentation language

| Gate | Status | Notes |
| --- | --- | --- |
| Bilingual README STE rewrite | done | PR #17 and follow-ups |
| English entry pages for main README links | done | See [README-I18N.md](README-I18N.md) |
| Real UI screenshots in README | partial | Three PNG screenshots present; optional refresh from current UI |
| Local 宣发 pack (not in repo) | n/a | Not assessed; not required for GitHub release readiness |

## 7. Resolved Dependabot triage (Rust)

| Alert | Package | Severity | Resolution |
| --- | --- | --- | --- |
| #1 GHSA-wrw7-89jp-8q8g | `glib` 0.18.x | medium | Dismissed as `not_used` on 2026-08-13. Static triage at `f77033b` found no calls to affected API `Variant::array_iter_str` / `VariantStrIter` in the repository or resolved Linux Rust consumers. |

The resolved tree remains on the gtk-rs 0.18 line, so do not force-edit `Cargo.lock` to a mismatched
gtk/glib pair. Re-open this review if `Cargo.lock`, Tauri/GTK/WebKitGTK dependencies, or either
affected API use changes; adopt a compatible upstream upgrade when one becomes available.

## Minimum next Owner actions

1. Buy or issue Windows Code Signing certificate; run `scripts/upload-windows-code-sign-secrets.ps1`.
2. Optional: add all six `APPLE_*` secrets for macOS signing and notarization.
3. Run `node scripts/check-owner-signing-gates.mjs --json` until `signedBetaPublishReady` is true.
4. Perform candidate-bound native launch/UI acceptance on macOS, Linux, and Windows; preserve the exact artifacts and results.
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

- Publish desktop setup / portable artifacts only as **prerelease**, **unsigned**,
  **development-trust** previews.
- Do not mark them as latest stable.
- Do not claim notarization, SmartScreen trust, or production auto-update.
