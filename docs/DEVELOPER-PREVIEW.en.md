# Developer preview (local plugin flow)

[简体中文](DEVELOPER-PREVIEW.md) · English

This page is for human developers. It shows a local preview path.

The non-interactive Agent path is:
`create → doctor → validate → pack → publisher init → publisher sign → publisher verify`.

The single source of truth for that path is [`agent/BUILD-A-TOOL.md`](agent/BUILD-A-TOOL.md)
(document in Chinese). This page does not replace that path.

These names are fixed compatibility interfaces:

- `useful` CLI and package names
- signature domain `useful-artifact-v1`
- file extension `.useful`

## Choose one local entry

Use only one entry that already exists on the machine:

- Extracted Agent Kit: `<ABS_KIT>\bin\useful.cmd` (Windows) or `<ABS_KIT>/bin/useful`
  (macOS/Linux). The [README](../README.md) and [Known limitations](KNOWN-LIMITATIONS.en.md)
  identify the current public Release/entry, including the Agent Kit, as
  [`v0.1.0-beta.11`](https://github.com/RedeatI/useful/releases/tag/v0.1.0-beta.11). For that version,
  obtain the exact Agent Kit from the matching Release and check that Release’s `SHA256SUMS.txt` and
  source evidence. The repository’s last exact cross-platform Agent Kit acceptance remains bound only
  to beta.10; see [`0.1.0-beta.10-agent-kit-acceptance.md`](releases/0.1.0-beta.10-agent-kit-acceptance.md).
- Source checkout: `packages/useful-cli/bin/useful.mjs` with Node.js `^20.9.0` or `>=22.0.0`.
  The examples below use this entry.

Do not use an online package runner. Do not use a global command that resolves packages from a
registry during execution. Prepare locked dependencies before this flow. If launcher resolve fails,
stop. Do not fall back to a network download. A local Agent Kit build still does not authorize public
distribution; the beta.10 acceptance record must not be reused as beta.11 acceptance or checksum evidence.

```powershell
$useful = (Resolve-Path '.\packages\useful-cli\bin\useful.mjs').Path
node $useful agent-contract --json
```

Parse one JSON document from stdout per command. Stop on the first non-zero exit code. Target,
output, and publisher directories must not already exist. Do not use force. Do not overwrite old
outputs.

## Create and check a local tool

```powershell
node $useful create '.\my-tool' --id com.example.mytool --name 'My Tool' --template minimal-web --json
node $useful doctor '.\my-tool' --json
node $useful validate '.\my-tool' --json
node $useful pack '.\my-tool' '.\dist-useful' --json
```

`minimal-web` is the default zero-permission template. Use `minimal-action` only when you need a
declarative `pipeline-v1` Action. That template does not provide arbitrary scripts, workers,
WASM/WASI, native code, or command execution.

## Publisher signature

Read `<ARTIFACT_PATH>` from `data.artifactPath` in a successful pack result. Do not invent or reuse
paths:

```powershell
node $useful publisher init '.\publisher' --id com.example.preview --name 'Preview Publisher' --json
node $useful publisher sign '<ARTIFACT_PATH>' --key '.\publisher\publisher.private.pem' --json
node $useful publisher verify '<ARTIFACT_PATH>' '<ARTIFACT_PATH>.publisher-signature.json' --json
```

The signature domain is `useful-artifact-v1`. It covers tool ID, version, and `.useful` SHA-256. Keep
the private key outside the repository. Do not commit it. Do not copy it into diagnostics or logs.
`verify` must return `valid: true` and match the pack SHA-256.

## Local static source preview

`source publish` writes signed metadata in a local source directory only. It does not upload. It
does not create a GitHub Release. It does not authorize public distribution:

```powershell
node $useful source init '.\preview-source' --name 'Preview Source' --id com.example.preview-source --json
node $useful source add-package '.\preview-source' '<ARTIFACT_PATH>' --json
node $useful source publish '.\preview-source' --json
node $useful source validate '.\preview-source' --json
node $useful source export-static '.\preview-source' '.\preview-source-dist' --json
```

Only the public directory from `export-static` is deploy input. Deploy, remote upload, dynamic
source registration, withdraw, and any public network operation need separate authorization. The CLI
does not publish automatically.

## Examples

- [`base64-tool`](../examples/base64-tool/): minimal web tool with no permissions
- [`file-hash-tool`](../examples/file-hash-tool/): explicit file permission, chunked read, progress,
  cancel
- [`qr-code-tool`](../examples/qr-code-tool/): offline static dependency, CSP, license sample
- [`json-diff-pro-tool`](../examples/json-diff-pro-tool/): advanced local diff sample; “Pro” is a
  sample name only

## Security limits

- Plugins cannot access `window.__TAURI__` directly. Plugins request declared permissions through the
  SDK or host bridge only.
- Do not grant arbitrary filesystem, network, or process access by default.
- Updates must keep source, publisher, tool, and action identity consistent. New permissions require
  a new confirmation.
- Withdraw blocks new installs. Withdraw does not delete installed copies remotely.
- Local pack or sign success is not formal signing, notarization, GitHub release, or public
  distribution.
