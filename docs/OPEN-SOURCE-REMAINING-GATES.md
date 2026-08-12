# Open-source remaining gates (status)

Date: 2026-08-12  
Public repository: `https://github.com/RedeatI/useful`  
Baseline commit for this note: `efcef61` (docs STE README) plus local desktop packaging work.

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
| Private Vulnerability Reporting enabled and tested | blocked | Must verify Security 鈫?Advisories 鈫?Report a vulnerability works |
| Public Issues / contribution intake | blocked | Keep closed until private reporting and CoC enforcement owner are ready |
| Branch protection and review rules | partial | Confirm default-branch protection in GitHub settings |

## 2. Source publication path

| Gate | Status | Notes |
| --- | --- | --- |
| Sanitized public history | done | Public main exists |
| Source + Agent Kit preview Release | done | `v0.1.0-beta.3` |
| Desktop binaries in an official signed Release | blocked | Signing identity and production update trust missing |

## 3. Local and remote verification

| Gate | Status | Notes |
| --- | --- | --- |
| Windows source build path | partial | Local release/portable packaging path exists; bind evidence to exact commit |
| macOS real runner build | blocked | CI config is not runner proof |
| Linux real runner build | blocked | CI config is not runner proof |
| Required CI green on release commit | partial | Re-check before any `release.yml` publish=true run |

## 4. Release and update trust

| Gate | Status | Notes |
| --- | --- | --- |
| Production code signing (Windows) | blocked | Owner identity |
| macOS signing and notarization | blocked | Owner credentials |
| Production update root + HTTPS feed | blocked | Owner ceremony |
| Development-trust unsigned Windows preview packages | partial | Built for evaluation only; must be labeled non-production |
| Portable Full / GPL media | blocked | Corresponding-source Owner Gate |
| Agent Kit closed MANIFEST + legal files | partial | Preview kit may attach; keep `publicationAuthorized:false` claims honest |

## 5. Third-party Agent path

| Gate | Status | Notes |
| --- | --- | --- |
| BUILD-A-TOOL non-interactive path | partial | Documented; re-run on release candidate |
| Default 36 Actions / 40 MCP tools | done | Documented and tested in source |

## 6. Documentation language

| Gate | Status | Notes |
| --- | --- | --- |
| Bilingual README STE rewrite | done | PR #17 |
| English entry pages for main README links | done | See [README-I18N.md](README-I18N.md) |
| Real UI screenshots in README | partial | In progress for desktop preview Release |

## Minimum next Owner actions

1. Enable and test GitHub Private Vulnerability Reporting on `RedeatI/useful`.
2. Follow the fill-in worksheet in [OWNER-SIGNING-GATE-CHECKLIST.md](OWNER-SIGNING-GATE-CHECKLIST.md)
   (update-root ceremony, Windows/Apple secrets, feed template).
3. Run `node scripts/check-owner-signing-gates.mjs --json` until `signedBetaPublishReady` is true.
4. Run real macOS and Linux build jobs; store logs and artifact digests with the candidate SHA.
5. Decide whether public Issues open after (1) and CoC enforcement contacts are named.

## Related

- [OWNER-WINDOWS-CODE-SIGN-GUIDE.zh-CN.md](OWNER-WINDOWS-CODE-SIGN-GUIDE.zh-CN.md) — Windows 证书购买与上传

- [OWNER-SIGNING-GATE-CHECKLIST.md](OWNER-SIGNING-GATE-CHECKLIST.md) 鈥?variables, secrets, verification commands
- [OWNER-GATES.md](OWNER-GATES.md) 鈥?commercial Owner gates

## Current desktop packaging claim boundary

Until production signing and update trust pass:

- Publish desktop MSI / portable artifacts only as **prerelease**, **unsigned**,
  **development-trust** previews.
- Do not mark them as latest stable.
- Do not claim notarization, SmartScreen trust, or production auto-update.
