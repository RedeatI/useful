# Utilities architecture

[简体中文](UTILITIES-ARCHITECTURE.md) · English

Useful uses a two-level tool model.

```text
ToolDefinition          (level 1: tool package)
  └─ ToolActionDefinition[]  (level 2: tool actions)
```

## Level 1: Rust backend registry

`crates/useful-core/src/registry.rs` declares three top-level tools in `builtin_tools()`:

| ID | Route | Description |
| --- | --- | --- |
| `builtin.utilities` | `/tools/utilities` | Utilities (31 child tools) |
| `builtin.video-trim` | `/tools/video-trim` | Video trim |
| `builtin.process-monitor` | `/tools/process-monitor` | Process monitor |

## Level 2: frontend Action registry

`apps/useful/src/lib/tools/registry.ts` builds 31 Actions from `UTIL_TOOLS` into `UTIL_ACTIONS`.

Examples:

```text
builtin.utilities.base64
builtin.utilities.url
builtin.utilities.hash
builtin.utilities.uuid
builtin.utilities.json
```

Each Action has:

- stable ID: `builtin.utilities.<short_id>` (do not change casually)
- deep link: `/tools/utilities/<short_id>`
- keywords for search
- aliases for common short names
- capability flags: `supportsShortcut`, `supportsFavorite`, `supportsRecent`

The 31 utilities also have shared `ActionDescriptor` values and headless handlers. They enter the
default AI-callable registry.

`data-format` only converts bounded JSON ↔ YAML. `text-diff` produces deterministic line diffs.
`ipv4` does offline IPv4/CIDR checks only. These Actions do not read files, clipboard, or network.

Five Office families come from a separate Office registry. They are not part of the 31 utilities.

## Shared data flow

```text
registry.ts (source of truth)
  ├─ UtilitiesView.vue      (tool grid + detail)
  ├─ CommandPalette.vue     (Ctrl+K search)
  ├─ HomeView.vue           (favorites + recent)
  ├─ AppSidebar.vue         (sidebar)
  └─ stores/app.ts          (favorite + recent state)
```

## Command-line open

```powershell
# Useful.exe is the reserved Windows main executable name.
Useful.exe --open-tool builtin.video-trim
Useful.exe --open-action builtin.utilities.base64
Useful.exe --open-action=builtin.utilities.json
```

Single-instance rule: a second process sends arguments to the first process. The first process
activates the window and switches tool.

## Database migration

Phase 12 adds migration v5 (`action_level_state`):

- `action_favorites`: Action-level favorites
- `action_recent`: Action-level recent use (includes use count)

## Related pages

- Full Action list: [Tool Actions](TOOL-ACTIONS.en.md)
- Agent call surface: [AI Integration](AI-INTEGRATION.en.md)

Full Chinese detail: [UTILITIES-ARCHITECTURE.md](UTILITIES-ARCHITECTURE.md).
