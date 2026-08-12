# Known limitations

[简体中文](KNOWN-LIMITATIONS.md) · English

This page lists what Useful supports today and what still needs tests on real platforms.

This page does not claim that a build is signed, notarized, or ready for production.

## Platforms

| Scope | Available now | Still needs real-platform tests |
| --- | --- | --- |
| Windows | Background builds, automated tests, and native QA entry points | GUI start, themes, navigation, video preview, process views, installers, and signing for a specific candidate |
| macOS | Static checks of workflows and dependency graphs | Build, DMG package, sign, notarize, install, and launch on a real macOS runner |
| Linux | Static checks of workflows and dependency graphs | Build, AppImage/deb package, install, and launch on a real Linux runner |

A continuous integration (CI) workflow file shows only that the path is configured. It does not show
that a remote job ran. It does not show that a platform binary works.

## Product limits

### Desktop application

- Treat the current build as a source-based developer preview.
- Video preview needs real media, `ffprobe`, and the preview backend. A listed file extension does
  not mean every file plays.
- Process and network views depend on platform APIs and permissions.
- Embedded mpv preview, ETW/network/GPU sampling, Job Objects, and `.lnk` shortcuts are Windows-first
  or Windows-only. On macOS and Linux, Useful must degrade the feature or report that the feature is
  not available.

### Office tools

- DOCX, PPTX, XLSX, CSV, and Markdown support simple create, extract, and convert flows. They do not
  replace Word, PowerPoint, or Excel.
- Complex styles, image layout, masters, animations, charts, comments, track changes,
  password-protected files, and digital signatures can be rejected, ignored, or changed.
- PDF support covers structure inspection, page merge, split, extract, delete, reorder, rotate, and
  limited metadata cleanup. PDF support does not include OCR, content edit, signature verification,
  or full redaction.
- Office Actions accept only closed-set JSON with Base64 file bytes. They reject arbitrary file paths
  and URLs. They do not use the network. They do not run macros, formulas, embedded scripts, or
  external relationships.
- “Local processing” means Useful does not upload the content. The bytes still pass through the
  calling Agent host, the CLI or stdio process, and worker memory.

### Agent, CLI, and MCP

- Default callable set: **36 Actions** (31 utilities + 5 Office groups). Default MCP also registers
  4 helpers (`search`, `describe`, `suggest`, `recipe`). MCP `tools/list` shows **40 tools**.
- CLI and MCP need Node.js. They are not signed standalone binaries.
- Suggestions inspect only text that you supply. Limit: 64 KiB in local memory. Suggestions do not
  read the clipboard.
- Recipes use `useful.action-recipe.v1`. Recipes allow a short ordered list of steps. Steps call only
  currently exposed read-only, non-destructive Actions.
- Media and process host Actions are optional. Load them with `--host-config`. They are not part of
  the default 36 Actions.
- Agent setup commands (`plan`, `export`, `probe`, `verify`, `verify-all`) create local candidates or
  self-checks for review. They do not write host configuration. They do not install Codex or Claude.
  They do not prove that an external host will accept the candidate.
- Computer Use is a contract for future isolated adapters. It is disabled by default. It cannot
  control the host desktop. It does not register as an Action or MCP tool.

### Distribution

- Public repository: `https://github.com/RedeatI/useful`.
- Source/Agent Kit and unsigned Windows desktop preview releases exist (for example `v0.1.0-beta.3`, `v0.1.0-beta.4`).
- Official **signed** desktop installers and a production update feed are not available unless a
  later release explicitly provides signature evidence.
- Development-trust Windows installers or portable packages are preview artifacts. They are not a
  signed production channel.
- Full media editions that ship `ffmpeg`, `ffprobe`, and `mpv` stay blocked until GPL
  corresponding-source and license evidence are complete.
- An Agent Kit ZIP is official only when the controlled release workflow attaches it to a matching
  GitHub Release. A local kit build does not authorize publication.

### Still missing owner or platform evidence

- Windows/macOS production code-signing identity and macOS notarization credentials
- Production update root and HTTPS update feed
- Full edition GPL corresponding-source evidence
- Enabled and tested GitHub Private Vulnerability Reporting ([SECURITY.md](../SECURITY.md))
- Real macOS/Linux runner results and candidate-bound Windows native visual acceptance
- Public contribution intake (Issues/PR) remains closed until private reporting and CoC enforcement
  routes are ready

## Related documents

- Full Chinese detail: [已知限制](KNOWN-LIMITATIONS.md)
- Security reports: [SECURITY.md](../SECURITY.md)
- Trust model: [Security assurance](SECURITY-ASSURANCE.md) (document in Chinese)
