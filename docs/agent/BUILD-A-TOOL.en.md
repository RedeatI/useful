# Build and sign a Useful tool with an Agent

[简体中文](BUILD-A-TOOL.md) · English

Useful is the public product and repository name. Keep these developer interfaces unchanged:

- commands and packages: `useful`, `useful-runtime`, `useful-mcp`
- schemas and protocols: `useful.*`
- package extension: `.useful`
- placeholder: `<USEFUL_REPOSITORY_URL>`

This page is the only procedure fact source for Agent-first external developers.

Goal: produce a local shareable `.useful` file, a publisher signature sidecar, and a SHA-256 digest
in a clean directory. “Share” means attach those files to a GitHub Release or give them to a Useful
source maintainer. The CLI does not upload. The CLI does not bypass source or publisher trust.

Canonical source repository: `https://github.com/RedeatI/useful`. Use that URL as a clone entry only
when it is public and reachable. Do not invent other remotes.

## Agent Kit entry (expected attachment)

An extracted `Useful-<version>-agent-kit.zip` needs Node.js 20 or newer. It does not need the
monorepo, the GUI, or a global install. It does not change this page’s non-interactive JSON rules,
stop-on-nonzero rule, default `minimal-web` choice, or signature trust chain.

Treat a kit on disk as not published until a controlled release attaches it.

Windows:

```powershell
& "<ABS_KIT>\bin\useful.cmd" agent-contract --json
& "<ABS_KIT>\bin\useful-runtime.cmd" actions list --json
node "<ABS_KIT>\lib\useful-mcp.mjs"
```

POSIX:

```bash
"<ABS_KIT>/bin/useful" agent-contract --json
"<ABS_KIT>/bin/useful-runtime" actions list --json
node "<ABS_KIT>/lib/useful-mcp.mjs"
```

MCP hosts should prefer `node <ABS_KIT>/lib/useful-mcp.mjs`. Do not depend on shell PATH for MCP.

## Hard limits

- Use Node.js 20 or newer.
- Choose one local entry only: extracted Agent Kit launcher (absolute path), or a locked source
  checkout entry. Do not install globally. Do not use a package runner that resolves the CLI from a
  network registry.
- Read root [`AGENTS.md`](../../AGENTS.md) first (Chinese). Run only non-interactive `--json`
  commands.
- Parse one JSON document from stdout per step. stderr should be empty. Stop on non-zero exit code.
  Do not retry by sampling other inputs.
- Keep private keys only in `<PUBLISHER_DIR>`. Do not commit or print private keys, `.env` files, or
  Bearer/admin tokens.
- `minimal-action` creates a declarative `pipeline-v1` only. It is not arbitrary JavaScript, worker,
  WASM, WASI, native, or script execution. It does not publish to the network.

Below, `useful` means the launcher you already resolved to a local file. Do not fall back to network
resolve during execution.

Run first:

```console
useful agent-contract --json
```

That returns current command shapes, exit codes, and template names.

## Stable JSON contract

Success:

```json
{"schemaVersion":"useful.cli.result.v1","ok":true,"command":"doctor","data":{}}
```

Failure (still one JSON document):

```json
{
  "schemaVersion": "useful.cli.result.v1",
  "ok": false,
  "command": "doctor",
  "error": {
    "code": "DOCTOR_FAILED",
    "message": "tool directory failed doctor hard checks",
    "details": {}
  },
  "data": {}
}
```

Use `error.code`, `message`, and `details` to decide repair. doctor/validate/pack failures may include
`data.checks`, `summary`, and per-item `remediation`.

Exit codes:

| Code | Meaning | Agent action |
| ---: | --- | --- |
| 0 | success | continue |
| 2 | usage or unknown option | fix the command; do not guess interactive prompts |
| 3 | manifest, doctor, or pre-pack validation failed | repair from checks/remediation; restart affected steps |
| 4 | security reject or I/O failure | stop; check existing dirs, secrets, links, permissions, paths |
| 5 | internal error | stop; keep full redacted JSON for handoff |

## Templates

| Template | Default permissions | Use |
| --- | --- | --- |
| `minimal-web` | `[]` | Recommended. Minimal zero-permission web tool |
| `minimal-action` | `[]` | Zero-permission web shell plus declarative Action for runtime/MCP |
| `starter-web` | none | Legacy handshake sample for old `create-useful-tool <dir>` |

`create` does not accept arbitrary permission strings. Permissions come only from the selected
template. The `minimal-action` action spec is `actions/base64-sha256.json`: call
`builtin.utilities.base64`, then `builtin.utilities.hash`. The plugin does not ship or execute handler
code.

## Command sequence

Replace placeholders with absolute paths or clear paths under the current working directory. Target
directories must not exist. Do not pass force. Run steps in order. Parse one JSON. Stop on non-zero:

```powershell
useful create "<TOOL_DIR>" --id com.example.agent-tool --name "Agent Tool" --template minimal-action --json
useful doctor "<TOOL_DIR>" --json
useful validate "<TOOL_DIR>" --json
useful pack "<TOOL_DIR>" "<OUT_DIR>" --json
useful publisher init "<PUBLISHER_DIR>" --id com.example.agent-publisher --name "Agent Publisher" --json
useful publisher sign "<ARTIFACT_PATH>" --key "<PUBLISHER_DIR>/publisher.private.pem" --json
useful publisher verify "<ARTIFACT_PATH>" "<ARTIFACT_PATH>.publisher-signature.json" --json
```

Read `<ARTIFACT_PATH>` from pack `data.artifactPath`. Keep pack `sha256`, `sizeBytes`, and
`entryCount`. Sign writes the sidecar to `<ARTIFACT_PATH>.publisher-signature.json` by default.
Verify must return `valid: true`. Verify `artifactSha256` must match pack.

## Explicit plugin config and run

Write a new `useful.plugin-set.v1` file. `artifactPath` and `signaturePath` must be safe relative
paths resolved from the config file directory. Pins must come from successful verify and pack
results:

```json
{
  "schemaVersion": "useful.plugin-set.v1",
  "plugins": [
    {
      "artifactPath": "artifacts/com.example.agent-tool-1.0.0.useful",
      "signaturePath": "artifacts/com.example.agent-tool-1.0.0.useful.publisher-signature.json",
      "expectedPublisherKeyId": "<VERIFY_DATA_PUBLISHER_KEY_ID>",
      "expectedArtifactSha256": "<PACK_DATA_SHA256>"
    }
  ]
}
```

Global `useful-runtime` flags must appear before `actions`. Unknown, duplicate, or misplaced flags
fail closed:

```powershell
useful-runtime --plugin-config "<PLUGIN_CONFIG>" actions list --json
useful-runtime --plugin-config "<PLUGIN_CONFIG>" actions describe com.example.agent-tool.base64-sha256 --json
useful-runtime --plugin-config "<PLUGIN_CONFIG>" actions run com.example.agent-tool.base64-sha256 --input @request.json --output json
useful-mcp --plugin-config "<PLUGIN_CONFIG>"
```

Without `--plugin-config`, the default registry loads 36 built-in Actions (31 utilities + 5 Office
families). MCP also registers 4 read-only helpers, so default `tools/list` has 40 tools. Helpers are
not registry Actions. Plugins cannot use helper names as Action IDs or aliases.

With `--plugin-config`, runtime does not scan AppData, databases, or marketplaces. Startup verifies
archive budgets, manifest, signature receipt, dual pins, action schema, pipeline, and test vectors.
Any failure stops before third-party Actions are registered. Plugin config extends the default
registry after that chain. It does not replace or weaken built-in Action contracts.

## Optional Agent allowlist

`useful.agent-profile.v1` is a local allowlist. It does not replace signature or dual-pin trust.
Runtime always verifies the plugin registry first, then applies the profile. Without a profile, the
default 36 built-in Actions stay visible. With a profile, unknown Action IDs, stale
version/publisher pins, or disabled surfaces fail closed. A profile does not add permissions,
capabilities, or trusted identity.

## Full Chinese procedure

Longer remediation detail, handoff rules, and edge cases are in [BUILD-A-TOOL.md](BUILD-A-TOOL.md).
