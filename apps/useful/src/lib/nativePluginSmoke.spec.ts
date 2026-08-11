import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  emit: vi.fn().mockResolvedValue(undefined),
  createShortcut: vi.fn(),
  toggleFavorite: vi.fn(),
  uninstallPlugin: vi.fn(),
  listPlugins: vi.fn(),
  listShortcuts: vi.fn(),
  getFavorites: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.eventHandlers.set(name, handler);
    return vi.fn();
  }),
}));

vi.mock("@/lib/ipc", () => ({
  default: {
    createShortcut: mocks.createShortcut,
    toggleFavorite: mocks.toggleFavorite,
    uninstallPlugin: mocks.uninstallPlugin,
    listPlugins: mocks.listPlugins,
    listShortcuts: mocks.listShortcuts,
    getFavorites: mocks.getFavorites,
  },
}));

import { runNativePluginSmoke } from "./nativePluginSmoke";

describe("native plugin smoke", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.eventHandlers.clear();
    mocks.emit.mockClear();
    mocks.createShortcut.mockReset();
    mocks.toggleFavorite.mockReset();
    mocks.uninstallPlugin.mockReset();
    mocks.listPlugins.mockReset();
    mocks.listShortcuts.mockReset();
    mocks.getFavorites.mockReset();
    vi.stubGlobal("CSS", { escape: (value: string) => value });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for a cold async palette chunk and always closes it after inspection", async () => {
    const plugin = {
      id: "plugin.cold-palette",
      name: "Cold Palette Plugin",
      route: "/plugins/cold-palette",
      version: "1.0.0",
    };
    let installed = true;
    let paletteOpenedAt = -1;
    let paletteClosed = false;

    const frame = document.createElement("iframe");
    frame.className = "plugin-host__frame";
    frame.title = plugin.name;
    document.body.append(frame);

    const onKeydown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.key.toLowerCase() !== "k") return;
      window.setTimeout(() => {
        paletteOpenedAt = performance.now();
        const palette = document.createElement("div");
        const input = document.createElement("input");
        input.className = "palette__input";
        input.addEventListener("input", () => {
          const label = document.createElement("div");
          label.className = "palette__label";
          label.textContent = input.value;
          palette.append(label);
        });
        input.addEventListener("keydown", (inputEvent) => {
          if (inputEvent.key !== "Escape") return;
          paletteClosed = true;
          palette.remove();
        });
        palette.append(input);
        document.body.append(palette);
      }, 125);
    };
    window.addEventListener("keydown", onKeydown);

    const router = {
      push: vi.fn(async () => {
        mocks.eventHandlers.get("plugin-ready-observed")?.({
          payload: { pluginId: plugin.id, details: { cold: true } },
        });
      }),
    };
    const appStore = {
      toolById: vi.fn(() => (installed ? plugin : undefined)),
      reloadTools: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createShortcut.mockResolvedValue({
      id: "shortcut-1",
      lnkPath: "C:\\isolated\\plugin.lnk",
      args: `--open-tool ${plugin.id}`,
    });
    mocks.toggleFavorite.mockResolvedValue(true);
    mocks.uninstallPlugin.mockImplementation(async () => {
      installed = false;
    });
    mocks.listPlugins.mockResolvedValue([]);
    mocks.listShortcuts.mockResolvedValue([]);
    mocks.getFavorites.mockResolvedValue([plugin.id]);

    try {
      const smoke = runNativePluginSmoke(
        router as never,
        appStore as never,
        { commit: "cold-commit", version: "0.1.0", plugins: [plugin], bootstrapFailures: [] },
      );
      expect(document.querySelector(".palette__input")).toBeNull();
      await vi.runAllTimersAsync();
      await smoke;
    } finally {
      window.removeEventListener("keydown", onKeydown);
    }

    expect(paletteOpenedAt).toBeGreaterThanOrEqual(125);
    expect(paletteClosed).toBe(true);
    expect(document.querySelector(".palette__input")).toBeNull();
    expect(mocks.uninstallPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith(
      "native-plugin-smoke-result",
      expect.objectContaining({
        scenario: "native-tauri-plugin-lifecycle",
        commit: "cold-commit",
        version: "0.1.0",
        total: 1,
        passed: 1,
        failed: 0,
      }),
    );
  });

  it.each([
    { outcome: "rejected", settleDelayMs: null },
    { outcome: "after the deadline", settleDelayMs: 10_050 },
  ])("closes global palette state when the lazy chunk settles $outcome", async ({ settleDelayMs }) => {
    const plugin = {
      id: "plugin.palette-timeout",
      name: "Palette Timeout Plugin",
      route: "/plugins/palette-timeout",
      version: "1.0.0",
    };
    let installed = true;
    let paletteOpen = false;
    let paletteToggleCount = 0;
    let chunkRequested = false;
    let chunkSettled = false;

    const frame = document.createElement("iframe");
    frame.className = "plugin-host__frame";
    frame.title = plugin.name;
    document.body.append(frame);

    const onKeydown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      paletteOpen = !paletteOpen;
      paletteToggleCount += 1;
      if (!paletteOpen || chunkRequested) return;
      chunkRequested = true;
      if (settleDelayMs === null) {
        // A rejected async component never contributes an input node.
        chunkSettled = true;
        return;
      }
      window.setTimeout(() => {
        chunkSettled = true;
        // Mirrors CommandPalette mounting after its App-level open state was
        // already closed: the component may settle, but its input stays hidden.
        if (!paletteOpen) return;
        const input = document.createElement("input");
        input.className = "palette__input";
        document.body.append(input);
      }, settleDelayMs);
    };
    window.addEventListener("keydown", onKeydown);

    const router = {
      push: vi.fn(async () => {
        mocks.eventHandlers.get("plugin-ready-observed")?.({
          payload: { pluginId: plugin.id, details: { ready: true } },
        });
      }),
    };
    const appStore = {
      toolById: vi.fn(() => (installed ? plugin : undefined)),
      reloadTools: vi.fn().mockResolvedValue(undefined),
    };
    mocks.uninstallPlugin.mockImplementation(async () => {
      installed = false;
    });
    mocks.listPlugins.mockResolvedValue([]);
    mocks.listShortcuts.mockResolvedValue([]);
    mocks.getFavorites.mockResolvedValue([]);

    try {
      const smoke = runNativePluginSmoke(
        router as never,
        appStore as never,
        { commit: "timeout-commit", version: "0.1.0", plugins: [plugin], bootstrapFailures: [] },
      );
      await vi.runAllTimersAsync();
      await smoke;
    } finally {
      window.removeEventListener("keydown", onKeydown);
    }

    expect(chunkRequested).toBe(true);
    expect(chunkSettled).toBe(true);
    expect(paletteToggleCount).toBe(2);
    expect(paletteOpen).toBe(false);
    expect(document.querySelector(".palette__input")).toBeNull();
    expect(mocks.createShortcut).not.toHaveBeenCalled();
    expect(mocks.uninstallPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith(
      "native-plugin-smoke-result",
      expect.objectContaining({
        scenario: "native-tauri-plugin-lifecycle",
        commit: "timeout-commit",
        version: "0.1.0",
        total: 1,
        passed: 0,
        failed: 1,
        failures: expect.arrayContaining([
          expect.objectContaining({
            id: plugin.id,
            message: expect.stringContaining("Ctrl+K 未在 10000ms 内打开命令面板"),
          }),
        ]),
      }),
    );
  });
});
