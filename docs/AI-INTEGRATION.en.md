# Call Useful from an external Agent (CLI / MCP)

[简体中文](AI-INTEGRATION.md) · English

An external Agent can call Useful through:

- the `useful-runtime` JSON command-line interface (CLI)
- the local stdio `useful-mcp` Model Context Protocol (MCP) server

Both use the same Action registry and executor.

Useful does not include a model. Useful does not read model configuration. Useful does not sample.
Useful does not open the network for an Agent.

## Default surface

Without plugin config, the default registry exposes **36** built-in Actions:

- 31 `builtin.utilities.*` utilities
- 5 Office Action groups:

| Action ID | Operations |
| --- | --- |
| `builtin.office.docx` | `compose`, `extract`, `inspect`, `to-markdown`, `from-markdown` |
| `builtin.office.pptx` | `compose`, `extract`, `inspect`, `to-markdown`, `from-markdown` |
| `builtin.office.spreadsheet` | XLSX/CSV compose, extract, inspect, convert; simple Markdown tables |
| `builtin.office.pdf` | `inspect`, `merge`, `split`, `extract-pages`, `delete-pages`, `reorder`, `rotate`, `sanitize` |
| `builtin.office.markdown` | Parse Markdown outline, or build simple DOCX/PPTX |

MCP also registers 4 helpers. Helpers are not Actions:

- `useful.actions.search`
- `useful.actions.describe`
- `useful.actions.suggest`
- `useful.actions.recipe`

Default MCP `tools/list` returns **40 tools** (36 Actions + 4 helpers).

Plugin Action IDs and aliases cannot use the four `useful.actions.*` helper names.

## Quick commands

```console
node packages/useful-runtime/bin/useful-runtime.mjs actions list --json
node packages/useful-runtime/bin/useful-runtime.mjs actions search --query office --category office --json
node packages/useful-runtime/bin/useful-runtime.mjs actions describe builtin.office.docx --json
node packages/useful-runtime/bin/useful-runtime.mjs actions suggest --input @sample.txt --limit 5 --json
node packages/useful-runtime/bin/useful-runtime.mjs actions recipe --input @examples/action-recipes/json-base64.json --output json
pnpm useful -- agent-contract --json
```

## Connect a host without writing config

Create a review-only MCP stdio candidate:

```console
pnpm useful -- agent plan --target codex --launcher /ABS/PATH/useful-mcp.mjs --json
pnpm useful -- agent export --target claude-code --launcher /ABS/PATH/useful-mcp.mjs --json
pnpm useful -- agent doctor --target claude-desktop --launcher /ABS/PATH/useful-mcp.mjs --json
```

Valid targets: `codex`, `claude-code`, `claude-desktop`, `mcp-servers-json`.

Self-check and bind:

```console
pnpm useful -- agent probe --json
pnpm useful -- agent verify --target codex --launcher /ABS/PATH/packages/useful-mcp/bin/useful-mcp.mjs --json
pnpm useful -- agent verify-all --launcher /ABS/PATH/packages/useful-mcp/bin/useful-mcp.mjs --json
```

These commands do not write host configuration files. They do not install Codex or Claude. They do
not prove that a host will accept the candidate. Results describe the current process and local
paths. A successful parse checks structure only.

## Plugin trust (optional)

Use `--plugin-config` only with a `useful.plugin-set.v1` file that pins publisher key and artifact
SHA-256. Startup verifies signature and pins before any plugin tool is exposed. Failure stops the
process before tools appear.

`--plugin-config` loads signed declarative `useful.plugin-action.v1` pipelines only. The runtime does
not import or eval plugin code. Plugins cannot request worker, native, script, or WASM/WASI launch.

## Agent profile (optional)

`useful.agent-profile.v1` is an allowlist. Without a profile, the default 36 Actions stay visible.
With a profile, only matching enabled Actions remain. A profile does not add permissions.

## Office limits

- Office Actions accept closed-set JSON with Base64 file bytes only.
- Office Actions reject arbitrary file paths and URLs.
- Office Actions do not use the network.
- Office Actions do not run macros, formulas, embedded scripts, or external relationships.
- Size limits apply to Base64 fields and JSON envelopes. Oversized or encrypted inputs fail closed.
- “Local” means Useful does not upload content. Bytes still pass through the calling host, CLI or
  stdio process, and worker memory.

## Suggestions and recipes

- Suggestions inspect only caller-supplied text. Limit: 64 KiB in local memory. Suggestions do not
  read the clipboard.
- Recipes use `useful.action-recipe.v1`. Maximum 16 ordered steps. Steps use JSON Pointer links.
  Steps call only currently exposed read-only, non-destructive Actions.

## Optional host Actions

Media and process Actions are not in the default 36. Load them with
`--host-config <useful.host-actions.v1.json>`. Destructive CLI calls need per-call `--confirm`. MCP
grants only configured read-only host entries.

## Computer Use

Computer Use is a disabled contract for future isolated adapters. Run:

```console
pnpm useful -- computer-use probe --json
```

The probe does not control the desktop. It does not start a browser. It does not register Actions or
MCP tools.

## Full Chinese detail

This English page is an entry summary. Full protocol rules, schemas, and edge cases are in
[AI-INTEGRATION.md](AI-INTEGRATION.md) (Chinese).
