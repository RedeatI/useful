# Useful

[简体中文](README.zh-CN.md) · English

Useful is a local-first desktop app for the small jobs that otherwise end up spread across browser
tabs, command-line snippets, and one-off applications. It includes 31 developer utilities, a small
set of local Office file workflows, video trimming, Windows process inspection, and an extension
format for adding more tools.

The app is built with Vue 3, Tauri 2, and Rust. Utility input stays on the device unless a feature
explicitly needs the network. Useful does not bundle an AI model or change the configuration of an
Agent host.

> [!IMPORTANT]
> Useful is currently a developer preview. Build it from source for evaluation; there are no
> official signed installers or production update feed yet. Windows is the primary development
> platform, and some native features are unavailable on macOS and Linux. See
> [Known limitations](docs/KNOWN-LIMITATIONS.md) for the current platform and release boundaries.

![Useful tool library](docs/assets/readme/product-overview.svg)

## What is included

- **Everyday utilities:** JSON formatting, Base64 and URL encoding, hashes, UUIDs, timestamps,
  regular expressions, JSON/YAML conversion, text diffing, IPv4/CIDR inspection, unit conversion,
  color tools, and more. These tools run locally and do not need a network connection.
- **Office files:** compose, inspect, and extract DOCX and PPTX; move between Markdown and simple
  documents or slides; inspect and convert XLSX, CSV, and simple Markdown tables; and inspect,
  merge, split, extract, delete, reorder, rotate, or clean PDF pages. This is a bounded document
  toolkit, not an Office-compatible editor.
- **Video work:** inspect media, trim without re-encoding when possible, transcode precise ranges,
  extract audio, and cancel long-running jobs.
- **Process monitor:** inspect CPU, memory, disk, GPU, and network activity on Windows. The first
  release is read-only: ending a process or process tree and one-click elevation are disabled. If
  administrator access is required, exit Useful and manually run it as administrator in Windows.
- **Tool library:** search, pin, and favorite built-in and installed tools from one screen.
- **Extensions:** validate and package web tools as `.useful` archives, verify publisher signatures
  during trusted installation, or host a compatible source yourself.
- **Agent access:** call 36 built-in Actions through a JSON CLI or local stdio MCP server. An Agent
  profile can narrow that set for a particular host.
- **Client setup plans:** generate secret-free, reviewable MCP configuration plans for Codex,
  Claude Code, Claude Desktop, or an `mcpServers` JSON host without changing host configuration.

The interface is available in Simplified Chinese and English, with light and dark themes. Portable
mode is supported on Windows by placing `portable.flag` next to `Useful.exe`; data is then stored in
`./data` instead of `%APPDATA%\Useful`.

## Run from source

You will need:

- Node.js `^20.9.0` or `>=22.0.0` for source development and desktop builds
- pnpm 9.15.0
- the stable Rust toolchain
- the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

After the sanitized repository is made public:

```console
git clone https://github.com/RedeatI/useful.git
cd useful
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm dev` starts only the web frontend. It is useful for interface work, but native media,
process, and local-state features require the Tauri app and will report that the native backend is
unavailable.

Release-profile builds intentionally fail when production update-trust settings are missing. For a
local release-style build, follow [Developer Preview](docs/DEVELOPER-PREVIEW.md); do not publish its
QA artifacts as official binaries.

## CLI and MCP

The built-in Action registry currently contains 36 callable contracts: the 31 utility Actions
listed in [Tool Actions](docs/TOOL-ACTIONS.md), plus five Office action families:

```text
builtin.office.docx
builtin.office.pptx
builtin.office.spreadsheet
builtin.office.pdf
builtin.office.markdown
```

Use the registry instead of copying identifiers into an integration by hand:

```console
node packages/useful-runtime/bin/useful-runtime.mjs actions search --query office --category office --json
node packages/useful-runtime/bin/useful-runtime.mjs actions describe builtin.office.docx --json
node packages/useful-runtime/bin/useful-runtime.mjs actions suggest --input @sample.txt --limit 5 --json
node packages/useful-runtime/bin/useful-runtime.mjs actions recipe --input @examples/action-recipes/json-base64.json --output json
```

Inspect the wider machine-readable CLI contract with:

```console
pnpm useful -- agent-contract --json
```

Generate or diagnose a host-specific stdio configuration without writing it:

```console
pnpm useful -- agent plan --target codex --launcher C:\ABSOLUTE\useful-mcp.mjs --json
pnpm useful -- agent doctor --target claude-code --launcher C:\ABSOLUTE\useful-mcp.mjs --json
```

The plan target is one of `codex`, `claude-code`, `claude-desktop`, or `mcp-servers-json`.
Codex and Claude keep their own approval and sandbox policies; Useful does not generate bypass or
always-allow settings. See [AI Integration](docs/AI-INTEGRATION.md) for scope and merge semantics.

`packages/useful-runtime` provides the JSON runtime, and `packages/useful-mcp` exposes the same
registry over stdio. Both are development entry points that currently require Node.js; they are not
published as standalone binaries. MCP also provides `useful.actions.search`,
`useful.actions.describe`, `useful.actions.suggest`, and `useful.actions.recipe`; these four helper
tools are not part of the 36-Action count, so the default MCP `tools/list` contains 40 tools.

Suggestions inspect only text supplied explicitly by the caller, in local memory, with a 64 KiB
limit. They do not read the clipboard or echo the sample. Recipes use the closed
`useful.action-recipe.v1` format: at most 16 ordered steps, exact JSON Pointer references to recipe
input or completed step output, and only currently exposed, read-only, non-destructive,
idempotent, closed-world Actions that require no confirmation, permission, capability, or side
effect. A complete recipe has a 60-second timeout, while each step still keeps its descriptor
timeout. See the
[runnable recipe example](examples/action-recipes/README.md).

Office Actions carry file bytes as canonical Base64 inside bounded JSON and run in terminable local
workers. They do not accept arbitrary file paths or use the network. The document code does not run
macros, spreadsheet formulas, embedded scripts, or external relationships; CSV formula-like cells
are escaped by default. Binary results include their byte size and SHA-256 so callers can verify
what they received.

Useful applies the same policy whether an Action is started from the GUI, CLI, or MCP. An Agent
profile is an allowlist, not a way to gain permissions. Network access, process control,
installation, and destructive operations still require the capability declaration and confirmation
defined by the app.

Native media and process Actions live in a separate optional host pack and are never part of the
default 36. A source checkout can opt in with `--host-config`: the CLI also requires a per-call
`--confirm` for destructive work, while the MCP binary grants configured read-only Actions only and
never invents user confirmation. The pack still needs real-platform and release-candidate validation.

The repository also contains a provider-neutral [Computer Use contract](docs/COMPUTER-USE.md) for
future isolated-browser or isolated-VM adapters. It is disabled by default, has no executable
provider, is not registered as an Action or MCP tool, and cannot control the host desktop.

The Agent Kit builder produces a local candidate with `publicationAuthorized: false`; building it
does not grant release authority. An Agent Kit is officially available only when the controlled
release workflow attaches it to a matching GitHub Release, and that source/Agent Kit release does
not imply desktop-platform validation.
To build a third-party tool, start with the [Agent tool guide](docs/agent/BUILD-A-TOOL.md). The
longer [developer guide](docs/DEVELOPER-GUIDE.md) covers package sources, signing, updates, and
self-hosting for human maintainers.

## Repository map

```text
apps/useful/              Vue frontend and Tauri desktop host
crates/useful-*/          Rust core, media, process, and trust components
packages/useful-sdk/      SDK for web-based tools
packages/useful-cli/      Tool creation, validation, packaging, and source CLI
packages/agent-integrations/  Codex/Claude/MCP configuration plans and read-only doctor
packages/computer-use-contract/  Disabled-by-default isolated Computer Use contract
packages/action-runtime/  Shared Action registry, contracts, and local handlers
packages/useful-runtime/  Deterministic JSON Action runtime
packages/useful-mcp/      Local stdio MCP server
packages/office-core/     Bounded DOCX, PPTX, XLSX/CSV, Markdown, and PDF core
packages/host-actions/    Optional native host contracts; not in the default registry
services/                 Self-hostable source services
repositories/             Static-source examples and fixtures
examples/                 Example third-party tools
docs/                     Architecture, integration, security, and release docs
```

Useful uses a monorepo because the desktop app, package format, runtime, and source services share
protocol contracts. Start with [Utilities architecture](docs/UTILITIES-ARCHITECTURE.md),
[Tool Actions](docs/TOOL-ACTIONS.md), or [Plugin SDK](docs/PLUGIN_SDK.md) if you are changing one of
those boundaries.

## Development

Common checks are available from the repository root:

```console
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm workflow:check
pnpm release:checks
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before changing code or a
public protocol. Release maintainers should also use the local readiness checks documented in the
[open-source release checklist](docs/OPEN-SOURCE-RELEASE.md).

## Security and licensing

Security reports should follow [SECURITY.md](SECURITY.md). The trust model for packages and Actions
is described in [Security assurance](docs/SECURITY-ASSURANCE.md).

This is a multi-license repository. The root [LICENSE](LICENSE) and [LICENSES.md](LICENSES.md) record
the owner-approved component map; third-party components remain under their own licenses. Every
public candidate still requires candidate-specific legal and dependency review.
Also see [Third-party notices](THIRD_PARTY_NOTICES.md) and the [trademark policy](TRADEMARKS.md).
