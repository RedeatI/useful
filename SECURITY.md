# Useful Security Policy

Useful is a local-first desktop host for built-in tools, untrusted web tools, signed packages, and
explicit Agent actions. This document describes the reporting route and the main trust boundaries;
it is not a claim that a public release or production trust root already exists.

## Reporting a vulnerability

Use **GitHub Private Vulnerability Reporting** for the repository that publishes Useful:

1. Open that repository's **Security** tab.
2. Open **Advisories** and choose **Report a vulnerability**.
3. Include affected versions or commit, platform, impact, reproduction steps, and a minimal proof of
   concept where safe.

Do not include credentials, private keys, personal data, or unnecessary production content. Do not
open a public issue for an unpatched vulnerability.

The canonical publication target is `https://github.com/RedeatI/useful`. This policy does not invent
a security email address.

**Status (2026-08-12):** GitHub Private Vulnerability Reporting is **enabled** on `RedeatI/useful`
(API `private-vulnerability-reporting.enabled=true`). Prefer that channel for vulnerability reports.
Maintainers should still click **Report a vulnerability** once in the UI after any repository transfer
or security-settings change. If the private reporting button is unavailable, the repository is not
release-ready for inviting vulnerability reports until the channel is restored.

Response times, bounty eligibility, supported-version windows, and disclosure timelines will be
published when repository ownership and maintainer coverage are finalized. No bounty is promised by
this document.

## Scope

Security reports are especially useful for:

- `.useful` archive traversal, link handling, budget bypass, manifest confusion, or partial install;
- publisher-signature, artifact hash, source/TUF, update-signature, or identity/pin bypass;
- sandbox escape, host DOM/Tauri access, message-origin confusion, or permission escalation;
- CLI/MCP schema bypass, action/profile confusion, unsafe preset merging, or sensitive-data leakage;
- command injection, unsafe child-process inheritance, cancellation failure, or runaway processes;
- credential storage, diagnostics redaction, local database, portable-path, or update rollback flaws;
- process identity/PID-reuse mistakes and destructive-action confirmation bypasses.

Ordinary feature requests, support questions, and already-public dependency advisories without a
Useful-specific impact analysis are not private vulnerability reports.

## Trust boundaries

| Component | Trust position | Boundary |
| --- | --- | --- |
| Rust host and main WebView | Trusted application core | Holds system capabilities and validates all bridge requests |
| Built-in tools | Trusted code shipped with the app | Still constrained by explicit UI and process/cancellation rules |
| Third-party web tool | Untrusted | Sandboxed origin and permission-checked message bridge; no direct Tauri access |
| Declarative plugin Action | Untrusted data | Closed-world, zero-permission `pipeline-v1`; validated before registration |
| Launcher tool | Low trust | May launch only a manifest-declared target with explicit permission |
| Native worker | High risk | Not a default public-source install path; requires stronger isolation and confirmation |
| Publisher signature | Publisher provenance | Does not replace artifact hash, source trust, permissions, or runtime validation |
| Repository/source metadata | Separate trust domain | Official identity derives from configured trust roots, never names or URLs |
| Client update metadata | Separate trust domain | Cannot be authorized by an ordinary tool source |

## Security invariants

- Default to zero permissions and user-selected files.
- Reject absolute/archive traversal paths, links, oversized archives, unknown schema fields, stale
  identity/version pins, invalid signatures, and incompatible runtime actions before exposure.
- Never concatenate user input into a shell command.
- Keep plugin, source/repository, publisher, Agent profile, and client-update trust decisions
  separate and fail closed.
- Do not log or return secrets, raw sensitive Agent input, private keys, or unredacted credentials.
- Preserve cancellation, timeout, resource-budget, and atomic install/update boundaries.
- Reconfirm process identity immediately before a destructive process action.
- Production signing keys, credentials, user data, and production configuration do not belong in
  this repository.

See [docs/agent/BUILD-A-TOOL.md](docs/agent/BUILD-A-TOOL.md),
[docs/AI-INTEGRATION.md](docs/AI-INTEGRATION.md), and
[docs/OPEN-SOURCE-RELEASE.md](docs/OPEN-SOURCE-RELEASE.md) for related operational gates.
