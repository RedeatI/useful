# Tool Actions

[简体中文](TOOL-ACTIONS.md) · English

The default built-in registry holds **36** AI-callable Actions:

- 31 utility Actions (table below)
- 5 Office Action groups

This count excludes the 4 MCP helpers. It also excludes optional native host Actions that need
explicit config. Default MCP `tools/list` therefore returns **40** tools.

## Action ID format

```text
<parent>.<short_id>
```

Examples:

```text
builtin.utilities.base64
builtin.office.docx
builtin.office.spreadsheet
com.example.tool.convert
```

## 31 utility Actions

| Action ID | Short ID | Route | Keywords | Aliases |
| --- | --- | --- | --- | --- |
| builtin.utilities.json | json | /tools/utilities/json | json, format, pretty | pretty, beautify, minify |
| builtin.utilities.base64 | base64 | /tools/utilities/base64 | base64, encode, decode | b64, atob, btoa |
| builtin.utilities.url | url | /tools/utilities/url | url, encode, decode | - |
| builtin.utilities.hash | hash | /tools/utilities/hash | hash, sha | sha1, sha384, checksum |
| builtin.utilities.uuid | uuid | /tools/utilities/uuid | uuid, guid | v4, guid |
| builtin.utilities.password | password | /tools/utilities/password | password | pwd, pass, secret |
| builtin.utilities.timestamp | timestamp | /tools/utilities/timestamp | timestamp | epoch, date |
| builtin.utilities.base-convert | base-convert | /tools/utilities/base-convert | radix, binary, hex | bin, oct, decimal |
| builtin.utilities.color | color | /tools/utilities/color | color, hex, rgb | colour, picker |
| builtin.utilities.case | case | /tools/utilities/case | case, naming, camel | - |
| builtin.utilities.regex | regex | /tools/utilities/regex | regex, match | regular expression, pattern |
| builtin.utilities.jwt | jwt | /tools/utilities/jwt | jwt, token, decode | json web token, bearer |
| builtin.utilities.html | html | /tools/utilities/html | html, entity, escape | - |
| builtin.utilities.hex-text | hex-text | /tools/utilities/hex-text | hex, text | - |
| builtin.utilities.morse | morse | /tools/utilities/morse | morse | - |
| builtin.utilities.text-stats | text-stats | /tools/utilities/text-stats | word count, stats | count, words |
| builtin.utilities.text-lines | text-lines | /tools/utilities/text-lines | lines, sort, dedupe | sort, dedupe, lines |
| builtin.utilities.slug | slug | /tools/utilities/slug | slug, url | - |
| builtin.utilities.byte-size | byte-size | /tools/utilities/byte-size | bytes, kb, mb | - |
| builtin.utilities.lorem | lorem | /tools/utilities/lorem | lorem, ipsum | placeholder |
| builtin.utilities.duration | duration | /tools/utilities/duration | date interval, duration | - |
| builtin.utilities.byte-unit | byte-unit | /tools/utilities/byte-unit | unit convert | unit, convert |
| builtin.utilities.number-format | number-format | /tools/utilities/number-format | number, thousands | number, format |
| builtin.utilities.unicode | unicode | /tools/utilities/unicode | unicode, code point | - |
| builtin.utilities.caesar | caesar | /tools/utilities/caesar | caesar, rot13 | cipher |
| builtin.utilities.luhn | luhn | /tools/utilities/luhn | luhn, card | card, credit card |
| builtin.utilities.contrast | contrast | /tools/utilities/contrast | contrast, wcag | a11y |
| builtin.utilities.random-number | random-number | /tools/utilities/random-number | random | number |
| builtin.utilities.data-format | data-format | /tools/utilities/data-format | json, yaml, convert | json yaml, yaml json |
| builtin.utilities.text-diff | text-diff | /tools/utilities/text-diff | diff, compare | compare, patch |
| builtin.utilities.ipv4 | ipv4 | /tools/utilities/ipv4 | ipv4, cidr, subnet | subnet, network |

## 5 Office Actions

Each Office Action uses one stable ID. Select the operation with a validated `operation` field.

| Action ID | Supported operations | Main outputs |
| --- | --- | --- |
| `builtin.office.docx` | `compose`, `extract`, `inspect`, `to-markdown`, `from-markdown` | DOCX Base64, blocks, Markdown, or summary |
| `builtin.office.pptx` | `compose`, `extract`, `inspect`, `to-markdown`, `from-markdown` | PPTX Base64, slides, Markdown, or summary |
| `builtin.office.spreadsheet` | `compose`, `extract`, `csv-parse`, `csv-stringify`, `csv-to-xlsx`, `xlsx-to-csv`, `inspect-xlsx`, `inspect-csv`, `to-markdown`, `from-markdown` | XLSX Base64, rows, CSV, Markdown, or summary |
| `builtin.office.pdf` | `merge`, `split`, `reorder`, `rotate`, `sanitize`, `inspect`, `extract-pages`, `delete-pages` | One or more PDF Base64; `inspect.pageDetails` has page index, point size, rotation |
| `builtin.office.markdown` | `parse`, `to-docx`, `to-pptx` | Outline blocks or DOCX/PPTX Base64 |

File bytes enter as size-limited strict canonical Base64. Arbitrary file paths and URLs are rejected.
Office handlers run in a single terminable worker thread. Binary outputs include `sizeBytes` and
SHA-256.

OOXML archives get ZIP path, duplicate entry, count, expand size, compression ratio, and part-size
checks first. Macros, formulas, embedded scripts, and external relationships are not executed.
Formulas return as data. CSV formula-like cells are escaped by default.

These tools target simple local conversion. They do not claim full Microsoft Office layout,
animation, chart, comment, track-change, or digital-signature compatibility. See
[Known limitations](KNOWN-LIMITATIONS.en.md).

PDF `sanitize` removes trailer `Info`, persistent `ID`, Catalog/Page XMP `Metadata`, and known
active-content entry points. It then copies cleaned pages into a second PDF so detached objects from
the first pass are not serialized again. It does not audit content-stream semantics. It is not a
malware analyzer, signature verifier, or full redaction tool.

PDF `inspect.pageDetails` returns zero-based `index`, `widthPoints`, `heightPoints`, and
`rotationDegrees` per page. These fields describe parsed page geometry only.

## CLI and MCP discovery

From a source tree, query Actions that the current registry or profile exposes:

```console
node packages/useful-runtime/bin/useful-runtime.mjs actions search --query office --category office --json
node packages/useful-runtime/bin/useful-runtime.mjs actions describe builtin.office.pptx --json
```

`actions search` supports source, category, execution mode, read-only, and idempotent filters. It
supports stable sort and cursor pagination.

Without a profile, `actions list` uses stable Action ID order. With a profile, CLI list and MCP
registration keep the profile Action array order. Search sort keys are independent of list order.

MCP provides the same discovery helpers:

- `useful.actions.search`
- `useful.actions.describe`
- `useful.actions.suggest`
- `useful.actions.recipe`

Helpers see only the profile-exposed set. They do not bypass the allowlist. Helpers are not part of
`BUILTIN_ACTIONS`. Default MCP `tools/list` has 40 tools.

The four helper names are reserved. Plugins cannot declare them as Action IDs or aliases. Profiles
cannot redirect them to plugin handlers.

### Suggestions

```console
node packages/useful-runtime/bin/useful-runtime.mjs actions suggest --input @file --limit 5 --json
```

Suggestions score caller-supplied text only. Limit: 64 KiB in local memory. Suggestions do not read
the clipboard or other app state. Candidates are filtered by the current profile before scoring. Ties
sort by canonical `actionId`.

### Recipes

```console
node packages/useful-runtime/bin/useful-runtime.mjs actions recipe --input @recipe.json --output json
```

Format: `useful.action-recipe.v1`. Maximum 16 ordered steps. Steps call only currently exposed
canonical Actions that are read-only, non-destructive, idempotent, closed-world, confirmation-free,
permission-free, and side-effect free. Aliases and dynamic Action IDs are rejected.

Step inputs and final output use JSON constants and exact `$ref` objects. References may target only
`/input/...` or `/steps/<completed-step>/output/...`. Forward references, self-references,
interpolation, expressions, scripts, files, network, and process entry points fail closed.

Limits: request ≤ 1 MiB, intermediate values ≤ 8 MiB total, recipe wall time ≤ 60 s, plus each Action
descriptor timeout. Results keep final output and redacted per-step receipts. Example:
[action recipes](../examples/action-recipes/README.md).

## Optional native host pack

`@useful/host-actions` adds four opt-in Actions:

- `builtin.video-trim.probe`
- `builtin.video-trim.export`
- `builtin.process-monitor.snapshot`
- `builtin.process-monitor.terminate`

They are not in the default 36. Source entry points register them only after a validated
`useful.host-actions.v1` file:

```console
node packages/useful-runtime/bin/useful-runtime.mjs --host-config /ABS/PATH/host-actions.json actions list --json
node packages/useful-mcp/bin/useful-mcp.mjs --host-config /ABS/PATH/host-actions.json
```

Config format: [`packages/host-actions/README.md`](../packages/host-actions/README.md).

CLI grants capabilities only for entries loaded on that run. Export and terminate require
`--confirm` on the same `actions run`. MCP grants only loaded entries that are strictly read-only,
non-destructive, and confirmation-free. Destructive Actions fail closed under MCP even if discovered.

Source wiring is not a published binary. Source wiring is not real ffmpeg/ffprobe proof. Source
wiring is not cross-platform validation.

## Stability rules

1. Do not change Action IDs casually. Favorites, recent history, and shortcuts use IDs.
2. Display name changes are safe. Favorites and recent history key on ID, not display name.
3. Plugin Actions and built-in Actions share the same execution abstraction. The public AI contract is
   `ActionDescriptor`. GUI tool metadata links to it but is not an interchangeable permission claim.
4. Unknown Action IDs show a safe error page. The app does not crash.

Full Chinese detail: [TOOL-ACTIONS.md](TOOL-ACTIONS.md).
