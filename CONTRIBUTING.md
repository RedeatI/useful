# Contributing to Useful

> Public contribution intake is not active yet. This guide documents the intended engineering
> workflow, but it is not an invitation to submit external patches until the repository Owner
> publishes an inbound contribution policy and enables the public intake controls.

Thank you for improving Useful. Contributions may cover the desktop client, built-in tools,
protocols, SDK/CLI/MCP packages, examples, tests, and documentation.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report suspected
vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.

## Before you start

1. Read the root [AGENTS.md](AGENTS.md) when using a development Agent.
2. Search the current code and documentation before proposing a new protocol or compatibility name.
3. Keep the public product name **Useful**. Treat `Useful.exe`, `io.github.redeati.useful`, the Windows
   `%APPDATA%\Useful` directory, `useful.*` schemas, and existing package/CLI names as deliberate
   first-release compatibility contracts.
4. Keep a change narrowly scoped. Do not combine a feature with unrelated formatting, generated
   artifacts, dependency upgrades, or compatibility renames.

## Development setup

Required:

- Node.js 20 or newer;
- pnpm 9.15.0;
- stable Rust;
- Tauri 2 platform prerequisites.

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev
```

Windows is the primary development platform. Any platform-verification claim must identify the exact
commit, commands, runner or device, artifacts, and result being cited. macOS and Linux build jobs are
configured, but configuration alone is not evidence of a successful remote job or published bundle.

## Agent-first third-party tools

[docs/agent/BUILD-A-TOOL.md](docs/agent/BUILD-A-TOOL.md) is the sole process source of truth for a
third-party Agent building a `.useful` tool.

- Use only the documented non-interactive commands and `--json` responses.
- Parse exactly one JSON document from stdout. Stop on the first non-zero exit code and preserve its
  stable `error.code`, details, and remediation.
- Choose the zero-permission `minimal-web` template by default. Add capability only when the feature
  requires it and a documented template permits it.
- `minimal-action` is a zero-permission declarative `pipeline-v1`; it is not an arbitrary
  JavaScript, worker, native, WASM/WASI, or shell execution surface.
- Never follow or package symlinks/junctions. Never commit or print private keys, `.env`, tokens,
  signing secrets, or generated dependency/build trees.
- Never overwrite an existing target or artifact, use an implicit force option, upload, publish, or
  bypass source/publisher trust.

## Engineering rules

- Preserve fail-closed behavior at archive, path, manifest, signature, publisher, source, profile,
  permission, and runtime boundaries.
- Do not implement cryptographic primitives. Use reviewed dependencies and existing abstraction
  boundaries.
- Protocol changes must update schemas, test vectors, type definitions, and cross-implementation
  conformance tests together.
- Do not store bearer tokens or credentials in plaintext SQLite. Do not include secrets or raw
  sensitive input in receipts, logs, diagnostics, or test fixtures.
- Do not make an ordinary tool source capable of updating the Useful client. Client updates,
  publisher signatures, and repository trust are separate domains.
- Do not infer official identity from a name, URL, TLS certificate, icon, or operator-supplied field.
- Use argument arrays for child processes; do not build shell command strings from user input.
- Add an ADR under `docs/adr/` for a durable architecture, protocol, or trust-boundary decision.

## Required checks

Run checks relevant to the changed area, followed by the repository-wide gates before proposing a
merge:

```powershell
pnpm -r lint
pnpm -r typecheck
pnpm -r test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
git diff --check
node scripts/check-version-drift.mjs --json
```

If a documented command emits JSON, verify its exit code and parse its one stdout document; do not
selectively rerun failed candidates to manufacture a pass. Record tests that could not run and the
reason. A CI configuration is not evidence that a remote job passed.

Additional protocol and integration checks may be required:

```powershell
pnpm --filter @useful/protocol test
pnpm --filter @useful/mcp test
pnpm --filter @useful/mcp typecheck
```

Do not commit generated media, binaries, release bundles, private keys, `.env`, or local databases.

## Change submission

A useful change description states:

- what was implemented;
- which compatibility and security boundaries were preserved;
- exact commands and pass/fail counts;
- what was not executed or not verified;
- known blockers and the narrow next step.

Do not claim a public release, remote CI result, signed artifact, download URL, or production service
unless the corresponding evidence exists in the repository target being reviewed.

## Licensing

The root [LICENSE](LICENSE) records the owner-approved copyright notice and component license map.
Before submitting a change, check the applicable entry in [LICENSES.md](LICENSES.md) and preserve
file-level SPDX notices, [NOTICE](NOTICE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Changing the license map, copyright holder, or third-party notices requires a separate maintainer
and legal review; an ordinary contribution must not alter those terms incidentally.

The component map defines outbound licenses only. Before public contribution intake opens, the
Owner must separately publish the inbound grant mechanism (for example, an approved DCO, CLA, or
explicit inbound-equals-outbound policy) and its enforcement process. Until then, this repository
does not claim that an external patch has been accepted or licensed for redistribution.
