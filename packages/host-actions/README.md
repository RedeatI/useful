# @useful/host-actions

Node-only, fail-closed host adapters for four native Useful actions:

- `builtin.video-trim.probe`
- `builtin.video-trim.export`
- `builtin.process-monitor.snapshot`
- `builtin.process-monitor.terminate`

The package does not discover binaries, scan application data, grant permissions, or register itself. Callers must explicitly load a regular JSON config file, then register the returned entries in an `ActionRegistry`.

```js
import { loadHostActionConfig, createHostActionEntries } from "@useful/host-actions";

const config = await loadHostActionConfig("C:\\Useful\\host-actions.json");
for (const entry of createHostActionEntries(config)) registry.register(entry);
```

The shipped Node adapters accept the same file explicitly at process startup:

```text
useful-runtime --host-config C:\Useful\host-actions.json actions list --json
useful-mcp --host-config C:\Useful\host-actions.json
```

`ffprobePath` is required only when `enabled.videoProbe` is true. `ffmpegPath` is required only when `enabled.videoExport` is true. The `video` policy and at least one read root are required for either video action; export additionally requires a write root.

The published JSON Schema expresses those enablement dependencies, the closed process/video fields and limits, and the permanent `video.allowOverwrite: false` policy. Path absoluteness, NUL rejection, filesystem existence and type, symlink checks, canonicalization, and platform executability are runtime checks performed by `loadHostActionConfig`; schema acceptance alone does not prove that a host config can be loaded on a particular machine.

Example `useful.host-actions.v1` config:

```json
{
  "schemaVersion": "useful.host-actions.v1",
  "ffmpegPath": "C:\\Useful\\media\\ffmpeg.exe",
  "ffprobePath": "C:\\Useful\\media\\ffprobe.exe",
  "readRoots": ["D:\\Media\\Input"],
  "writeRoots": ["D:\\Media\\Output"],
  "enabled": {
    "videoProbe": true,
    "videoExport": true,
    "processSnapshot": true,
    "processTerminate": true
  },
  "video": {
    "allowOverwrite": false,
    "maxDurationSec": 3600,
    "maxProbeOutputBytes": 4194304,
    "videoCodecs": ["copy", "libx264"],
    "audioCodecs": ["copy", "aac"]
  },
  "process": {
    "fields": ["pid", "startTime", "name"],
    "maxProcesses": 2048,
    "maxOutputBytes": 4194304
  }
}
```

Security boundary:

- Config, executable files, and roots must be explicit regular files/directories. A config, executable, or root entry that is itself a symlink is rejected; every accepted path is then canonicalized before use.
- Input paths are resolved with `realpath` and must remain inside a configured read root. Output parents are resolved and must remain inside a configured write root.
- Child processes always use `spawn` with `shell:false`, hidden windows, fixed executable sources, closed argument sets, bounded output, and a minimal environment.
- Export always invokes ffmpeg with `-n` and rejects existing targets. `video.allowOverwrite: true` is rejected at config load because Node/ffmpeg cannot prove one portable, race-free atomic replacement contract across supported filesystems. Export is still destructive and always requires executor confirmation.
- Snapshot exposes only configured fields; `pid` and `startTime` are mandatory. The entire process snapshot is marked sensitive.
- Windows termination compares both PID and start time inside one fixed PowerShell process-object flow before `Stop-Process`.
- POSIX termination is intentionally unsupported: Node does not expose a portable pidfd-equivalent that reliably closes the PID-reuse race. Enabling it makes config loading fail closed.
- Cancellation terminates ffmpeg/ffprobe/PowerShell/ps and schedules a forced kill if graceful termination does not complete.

Integration requirements:

- The consuming runtime must supply the descriptor permissions/capabilities to `ActionExecutor` through a trusted policy provider.
- `video-trim.export` and `process-monitor.terminate` require explicit per-call confirmation. Profile exposure alone is not permission or confirmation.
- The runtime CLI derives grants only from entries actually loaded by its `--host-config`, and `actions run --confirm` confirms only that invocation. The MCP binary grants only loaded read-only host entries and never fabricates destructive confirmation; an embedding may inject its own trusted `buildServer({ executionPolicy })` decision provider.
- This package is Node-only and does not bridge Tauri IPC. Packaging must include `ffmpeg`/`ffprobe` separately and point the config at their verified regular-file paths.
