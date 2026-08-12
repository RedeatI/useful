# Plugin development SDK

[简体中文](PLUGIN_SDK.md) · English

This page describes how to build a Useful plugin. Simple web tools do not require Rust.

These names are fixed compatibility interfaces:

- `useful-cli`
- `@useful/sdk`
- `useful.*` schemas
- `.useful` package extension

## Plugin types (`entry.type`)

| Type | Description |
| --- | --- |
| `web` | Static HTML/CSS/JS page in a sandboxed iframe with an isolated origin |
| `launcher` | Host starts a declared local program, script, or URL |
| `worker` | Separate native process over JSON-RPC on stdin/stdout (public sources do not auto-install by default) |

Third-party DLLs cannot load into the Useful main process.

## Package format (`.useful`)

A `.useful` file is a normalized ZIP. Root must include `manifest.json`.

Example layout:

```text
my-tool.useful
├── manifest.json
├── index.html
├── main.js
└── assets/icon.png
```

### Manifest example

```json
{
  "schemaVersion": 1,
  "id": "com.example.image-converter",
  "name": "Image Converter",
  "version": "1.0.0",
  "description": "Batch convert image formats",
  "icon": "assets/icon.png",
  "entry": { "type": "web", "path": "dist/index.html" },
  "contributes": {
    "sidebar": [
      { "id": "main", "title": "Image Converter", "group": "installed", "order": 100 }
    ]
  },
  "permissions": [],
  "platforms": ["windows-x64"],
  "minHostVersion": "0.1.0"
}
```

Rules:

- `id`: reverse-domain, at least two segments, each segment starts with a letter
- `version` / `minHostVersion`: semantic versions (reject invalid prerelease forms)
- `entry.path` (web/worker): relative path only; no `..`, absolute paths, or drive letters

The host validates the manifest with JSON Schema and Rust serde.

## CLI (`useful-cli`)

```console
pnpm create useful-tool my-tool
pnpm useful dev [dir]
pnpm useful validate [dir]
pnpm useful pack [dir] [outDir]
```

`pack` writes `<id>-<version>.useful`.

## SDK API (web tools)

Install `@useful/sdk`. Third-party pages cannot access `window.__TAURI__` directly.

First-release web plugins get theme, language, ready, and progress telemetry. Use browser APIs such
as `<input type="file">` for file pick inside the sandbox.

```ts
import { useful } from "@useful/sdk";

const theme = await useful.getTheme();
const lang = await useful.getLanguage();
await useful.ready({ version: 1 });
await useful.reportProgress(50, "Working");
```

`reportProgress` is telemetry only. It does not start native work.

## Permissions

| Permission | First-release status |
| --- | --- |
| `process.launch.declared` | Only launcher entries may declare it; treated as sensitive |

Web and worker plugins must use `permissions: []`.

These capabilities are rejected by first-release validators and runtime:

- `dialog.open` / `dialog.save`
- file read/write
- notifications
- clipboard
- `openExternal`
- `requestPermission`
- `network.fetch:*`

A manifest declaration alone does not enable them. Cancel and deadline bounds are not proven yet.

## Message protocol (without SDK)

Window RPC is removed. Old SDKs and old inline `postMessage` permission requests receive no grants.

Window messages allow one bootstrap only. After the host returns a port, all RPC uses that
`MessagePort`.

Bootstrap (iframe → host window, with one transferable `MessagePort` created by the plugin):

```json
{
  "__usefulBootstrap": true,
  "capability": "<one-time 256-bit secret from the URL fragment>"
}
```

The host does not send the port back through a navigable `WindowProxy`. The host checks the secret,
then confirms on the received port only. Later requests use that port only.

## Related pages

- Local preview flow: [Developer preview](DEVELOPER-PREVIEW.en.md)
- Agent-first tool build path: [agent/BUILD-A-TOOL.md](agent/BUILD-A-TOOL.md) (Chinese)
- Human maintainer source publish: [Developer guide](DEVELOPER-GUIDE.en.md)

Full Chinese detail: [PLUGIN_SDK.md](PLUGIN_SDK.md).
