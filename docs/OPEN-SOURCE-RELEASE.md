# Useful open-source release readiness

This checklist prevents repository publication, community launch, and binary release from being
collapsed into one ambiguous “open-source” event. It supplements, and does not replace,
[RELEASE-PROCESS.md](RELEASE-PROCESS.md).

No unchecked item below may be described as complete without current evidence from the final
repository and release target.

## Publication evidence boundary

- **Implemented in the development tree:** bilingual entry documentation, community templates,
  Useful-only product identities, fail-closed workflow configuration, public-source projection and
  strict-candidate checks, and a receipt-to-public-commit verifier.
- **Evidence boundary:** `release-readiness.mjs` is a local source preflight. Its output always states
  `publicationAuthorized: false`, `remoteStateChecked: false`, and
  `strictPublicCommitChecked: false`. A final public commit must separately pass the strict checker
  and receipt verifier described below.
- **Repository history:** never expose a repository or ref that contains non-public development
  history. The public default branch and every other exposed ref must descend only from the verified
  sanitized initial commit. Local preparation scripts do not create or mutate GitHub repositories.
- **External actions:** no visibility, ref, ruleset, workflow, security setting, Release, feed, or
  production-service change is authorized by this document.
- **Participation boundary:** keep Issues and public contribution intake closed until GitHub Private
  Vulnerability Reporting is enabled and tested, a private Code of Conduct reporting route and
  enforcement owner are named, and default-branch review rules are active.

## Dirty-tree commit inventory

Before any authorized commit, classify the dirty worktree:

```powershell
node scripts/list-public-commit-candidates.mjs --json
```

It reports recommended paths, do-not-commit paths, review paths, and whether a root LICENSE is still required. It never stages or commits.

## Machine-readable readiness gate

Run the local readiness aggregator before asking for publication authorization. It does not create a
repository, upload assets, run remote workflows, or invent legal identity:

```powershell
node scripts/check-brand.mjs --json
node scripts/release-readiness.mjs --json
pnpm release:readiness -- --json
```

A blocked result is expected until the worktree is a clean, reviewed candidate and every remaining
hard gate is closed. A present root `LICENSE`, configured Git remote, or available `gh` binary does
not by itself authorize publication.

If the approved copyright holder or multi-license map ever changes, regenerate the root `LICENSE`
only through a separately reviewed replacement procedure. The existing generator refuses generic
placeholders and never overwrites the current file:

```powershell
# 1) copy and edit docs/license-mapping-approval.example.json
# 2) set approved=true only after review
node scripts/generate-root-license.mjs `
  --holder "Exact Legal Subject Name" `
  --year 2026 `
  --mapping-approval path\to\approval.json `
  --json
```

Package/crate SPDX fields, full license body files, and the sanitized public snapshot remain separate
gates after the root notice exists.

## 1. Repository identity and community

- [x] Reconcile the root `LICENSE`, `LICENSES.md`, `NOTICE`, package/Crate metadata, root policy
  documents, `.github/`, shared service code and deployment examples into one owner-approved path
  map. The Owner confirmed this component classification on 2026-08-09; candidate-specific legal
  and third-party review remains a separate unchecked gate below.
- [ ] Before first publication, confirm `https://github.com/RedeatI/useful` as the canonical target and
  prove that every exposed ref descends only from the verified sanitized initial commit.
- [x] Use **Useful** consistently for the product and technical identities: `Useful.exe`,
  `io.github.redeati.useful`, `%APPDATA%\Useful`, `useful.db`, packages, commands, and schemas.
- [ ] Configure repository owners, branch protection, review requirements, and least-privilege bot
  permissions.
- [ ] Enable and test GitHub Private Vulnerability Reporting.
- [ ] Name the private Code of Conduct reporting route and enforcement team.
- [ ] Review `LICENSES.md`, license files, `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `TRADEMARKS.md`
  with qualified counsel; this checklist does not alter them.

## 2. Public-source hygiene

- [ ] Generate a fresh sanitized initial-history candidate from the final clean development commit.
- [ ] Initialize and commit that prepared directory in place, then run both the strict checker and
  receipt verifier against the exact clean public commit. Preserve their machine-readable results
  with the preparation receipt and complete transaction marker.
- [ ] Before first publication, ensure the default branch and every exposed ref contain only the
  reviewed initial history.
- [ ] Require the strict default check to fail when any non-public path remains. An inventory or
  export-mode exclusion list, if produced, is non-authoritative and cannot prove publish readiness;
  GitHub source archives expose the complete tag tree.
- [ ] Confirm the tree contains no private keys, `.env`, credentials, tokens, production config,
  user data, local databases, private artifacts, or generated release bundles.
- [ ] Confirm symlinks/junctions are not followed or packaged.
- [ ] Confirm documentation has no invented repository, download, update, security-email, or
  production-service URL.
- [ ] Confirm generated fixtures are reproducible and no large media/binary samples are committed.

### Reproducible local snapshot preparation

The preparation command is local-only. It does not initialize a repository, configure a remote,
commit, upload, publish, open a GUI, or run a container or security scanner:

```powershell
node scripts/prepare-public-source.mjs --repo-root <CLEAN_REPO> --output <NEW_DIR> --receipt <NEW_JSON> --json
```

`<CLEAN_REPO>` must be the exact root of a clean Git worktree at a fixed `HEAD`, with a tracked root
`LICENSE`. Both destinations must be new local absolute paths outside the source repository, their
nearest existing parents must have stable canonical identities, and the receipt must be outside the
output directory. UNC/device/alias paths, unsupported Windows names, links/reparse points and
hard-linked generated files fail closed. There is no force or overwrite mode. The command copies
only policy-eligible regular files tracked by the fixed commit/tree, reading their exact Git blobs
rather than checkout-transformed bytes. Ignored/untracked files, internal
phase/round/handoff/report/draft material, generated directories, secrets, links, unapproved
archives/containers, and binary release products are not copied.

The sibling receipt is deterministic JSON. It binds the source commit and tree, shared policy
version, sorted relative paths, Git modes, byte lengths, per-file SHA-256 values, a manifest digest,
and a total snapshot digest; it intentionally contains no timestamp or destination path. The
generator independently re-reads the generated output through the same policy module used by
`public-source-check.mjs` and verifies the source and destination identities again.

The command also creates the sibling marker
`<NEW_DIR>.useful-public-source.transaction.json`. A receipt or output directory alone is never
authoritative: the successful CLI result, receipt and marker must agree, the marker must have
`phase: "complete"`, and its recorded output/receipt identities must still match. The successful
result records the exact receipt and marker SHA-256 values; preserve all three JSON documents.
Controlled failure
exits nonzero, emits one JSON document with no stderr in `--json` mode, retains generator-owned
artifacts for evidence, and leaves or restores the marker as `incomplete`; it never recursively
deletes paths merely by name.

This preparation is not publication evidence. Review the exact output and receipt first. Only then
may an authorized owner initialize and commit the output in place. The public commit must be the
repository's root commit. On Windows, apply every receipt mode explicitly rather than relying on
filesystem executable bits:

```powershell
$candidateRoot = '<REVIEWED_PUBLIC_REPO>'
$receiptPath = '<RECEIPT_JSON>'
$receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json

Push-Location -LiteralPath $candidateRoot
try {
  git init --initial-branch=main
  if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
  git add --all
  if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
  foreach ($entry in $receipt.files) {
    $modeArg = if ($entry.mode -eq '100755') { '--chmod=+x' } elseif ($entry.mode -eq '100644') { '--chmod=-x' } else { throw "unsupported Git mode: $($entry.mode)" }
    git update-index $modeArg -- $entry.path
    if ($LASTEXITCODE -ne 0) { throw "mode application failed: $($entry.path)" }
  }
  git -c user.name='<PUBLIC_GIT_NAME>' -c user.email='<PUBLIC_NOREPLY_EMAIL>' commit -m 'chore: initial Useful public source snapshot'
  if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
  $parents = @(git cat-file commit HEAD | Where-Object { $_ -match '^parent ' })
  if ($LASTEXITCODE -ne 0 -or $parents.Count -ne 0) { throw 'public commit is not a root commit' }
} finally {
  Pop-Location
}
```

Then run both checks against that exact clean commit:

```powershell
node scripts/public-source-check.mjs --repo-root <REVIEWED_PUBLIC_REPO> --json
node scripts/verify-public-commit.mjs `
  --repo-root <REVIEWED_PUBLIC_REPO> `
  --receipt <RECEIPT_JSON> `
  --transaction-marker <TRANSACTION_JSON> `
  --json
```

The strict checker validates the complete public tree. The verifier additionally proves that every
committed path, Git mode, blob length, and SHA-256 matches the preparation receipt and that the
required complete transaction marker still binds the same output and receipt. Neither command has a
relaxed dirty mode. A dirty worktree returns nonzero with
`authoritative: false`; `--allow-dirty` is an invalid option rather than a way to manufacture release
evidence.

Do not run the preparation command against a dirty product worktree to manufacture a success. A
previous candidate or local pass does not authorize overwriting refs, changing visibility, or
publishing release assets.

## First-public GitHub activation boundary

The first public snapshot is intentionally fail closed:

- Every active file under `.github/workflows/` has only `workflow_dispatch`; a push, pull request,
  tag push, or schedule does not start CI, CodeQL, Dependency Review, Platform Bundles, or Release.
- Manual Dependency Review has no native pull-request event context, so its first step fails with a
  clear error before checkout or the review action. It must not turn a context-free manual run into a
  misleading success.
- `release.yml` remains manual-only, requires an existing tag ref at runtime, and keeps the required
  boolean `publish` input at `default: false`. This does not authorize dispatching the expensive
  release build or publishing a Release.
- `platform-bundles.yml` produces unsigned development previews. `release.yml` is the production
  release path and remains blocked until the repository is public and the expected repository,
  release-actor allowlist, protected `release` environment, signing trust, and update trust variables
  have been configured and verified.
- Active `.github/dependabot.yml` is absent. The inactive
  `.github/dependabot.yml.example` retains npm, Cargo, Go modules, Docker, and GitHub Actions examples
  for owner review. Each currently has a weekly Monday schedule and PR limit 5, so enabling the
  template unchanged could allow up to 25 open update PRs and fan out into every PR workflow that the
  owner later enables.

Enabling ordinary CI, CodeQL, Dependency Review, Dependabot, Platform Bundles, and any scheduled run
requires a separate owner decision for each item. To enable Dependabot, the owner must review and copy
the example to `.github/dependabot.yml` in an explicitly authorized change; first reduce or accept the
PR limits and account for workflow, platform-runner, cache, and artifact fan-out.

`node scripts/check-workflows.mjs --json` reports local static configuration evidence only. Its
`remoteExecutionChecked` field remains `false`; file presence and a successful local parse do not
claim that GitHub ran or passed any workflow or security scan.

## 3. Build and test gates

```powershell
pnpm install --frozen-lockfile
pnpm policy:test
pnpm -r lint
pnpm -r typecheck
pnpm -r test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
node scripts/check-version-drift.mjs --json
node scripts/check-brand.mjs --json
node scripts/check-workflows.mjs --json
node scripts/check-i18n.mjs --json
pnpm release:checks
node scripts/public-source-check.mjs --json
git diff --check
```

- [ ] Preserve the first failure and fix it before continuing; do not select reruns to manufacture a
  pass.
- [ ] After separate owner authorization, run supply-chain and dependency review workflows at pinned
  revisions and preserve the exact remote result.
- [ ] Verify Windows on the supported Windows matrix.
- [ ] Treat macOS and Linux as “CI configured” until their actual current jobs and produced bundles
  are verified. Do not convert configuration into a release claim.

## 4. Release and update trust

- [ ] Replace all development placeholder update/source keys through an authorized key ceremony.
- [ ] Configure and verify the canonical public GitHub repository, exact release-actor allowlist,
  production HTTPS feed template, update-root public key, and root-ceremony receipt digest.
- [ ] Keep client update, repository/TUF, and publisher trust roots separate.
- [ ] Produce channel-specific stable/beta/nightly metadata and artifacts; verify isolation and
  rollback behavior.
- [ ] Generate checksums and required SBOM/provenance material.
- [ ] Treat `Useful-<version>-agent-kit.zip` as a cross-platform supplemental asset, not a Windows
  Lite/Full edition. Require its closed `MANIFEST.json`, external
  `Useful-<version>-agent-kit.zip.sha256` receipt, explicit asset allowlist and final
  `SHA256SUMS.txt` entries, and build provenance. Its root legal declarations are `LICENSE`,
  `LICENSES.md`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `TRADEMARKS.md`; the referenced standard
  texts under `licenses/` must also be present, so `LICENSES.md` has no dangling in-archive links.
  The component map is owner-approved, so the builder reports `legalMappingApproved:true`; it must
  still retain `publicationAuthorized:false`, and the archive remains only an internal candidate
  until the exact snapshot completes legal, third-party, remote, signing, and release review. The
  archive must also contain exactly the expected five JavaScript bundles
  (`useful`, `useful-runtime`, `useful-mcp`, regex worker, Office worker), the canonical
  `lib/provenance/{action-runtime,office-core,host-actions}` source resources, and
  `THIRD_PARTY-LICENSES.json`. Every package listed there must have its actual license/notice files
  under `third-party/<package>/<version>/`, with hashes and sizes matching the index; a package
  metadata record or SPDX expression alone is not a distributable license body. SBOM remains a
  software-component inventory, not an Agent Kit asset inventory.
- [ ] Until actual macOS/Linux Agent Kit CI jobs run, record those paths only as configured and
  pending remote verification.
- [ ] Before publicly distributing Portable Full with GPL ffmpeg/mpv, close the Owner Gate for the
  exact corresponding source, build scripts/configuration, license texts, and continuously
  accessible evidence. An internal candidate is not public-release evidence; this checklist makes
  no legal conclusion.
- [ ] Verify the exact artifacts and signatures intended for release. Do not reuse an old receipt or
  describe an unsigned CI preview bundle as an official release.
- [ ] Verify upgrade and rollback while retaining Useful compatibility identities and user data.
- [ ] For stable, commit a reviewed `useful.stable-update-evidence.v1` document under
  `docs/releases/`, bind it to the tag and update-root fingerprint, and configure its exact SHA-256.

## 5. Third-party Agent path

- [ ] Re-run [agent/BUILD-A-TOOL.md](agent/BUILD-A-TOOL.md) from a clean directory using only
  non-interactive `--json` commands.
- [ ] Confirm `minimal-web` remains zero-permission by default and `minimal-action` remains a
  closed-world declarative pipeline.
- [ ] Verify create, doctor, validate, pack, publisher sign/verify, explicit double-pin config, CLI,
  and MCP behavior, including failed security vectors.
- [ ] Verify the extracted Agent Kit with Node.js 20+ and its `useful`, `useful-runtime`, and
  `useful-mcp` compatibility launchers without a monorepo, GUI, or global install; configure MCP
  through `node <ABS_KIT>/lib/useful-mcp.mjs`. Confirm the default runtime exposes 36 Actions, the
  default MCP surface exposes those 36 plus `search`/`describe`/`suggest`/`recipe` (40 tools total),
  and regex/Office calls start only the worker bundles shipped in the same archive. Exercise
  `actions suggest --input @file|- --limit ... --json` and
  `actions recipe --input @recipe.json [--validate-only] --output json`, including profile filtering,
  sample non-echo, canonical-ID recipe eligibility, 16-step/1 MiB/8 MiB/60-second limits, per-step
  timeouts and step receipts.
- [ ] Confirm the workflow creates local shareable artifacts only; it must not upload, publish, or
  bypass source/publisher trust.

## 6. Release statement

A release handoff must separate:

- **implemented:** code and documentation in the identified commit;
- **verified:** exact local and remote checks, platforms, artifact hashes, and signature evidence;
- **unexecuted:** builds, signing, uploads, deployments, or platform tests not performed;
- **blockers:** missing owners, keys, private reporting, failing tests, unverified platforms, or
  unavailable infrastructure;
- **next steps:** the smallest authorized action that resolves each blocker.

Do not publish a download URL, official badge, security contact, signed-release claim, or supported
platform claim before its corresponding evidence exists.
