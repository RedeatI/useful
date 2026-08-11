import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, createWebHistory, type Router } from "vue-router";

const lifecycle = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  paletteModuleLoads: 0,
  paletteMounts: 0,
  nativeSmokeModuleLoads: 0,
  nativePluginSmokeModuleLoads: 0,
  nativeSmokeImportGate: null as Promise<void> | null,
  nativeSmokeImportFailure: null as unknown,
  runNativeSmoke: vi.fn().mockResolvedValue(undefined),
  runNativePluginSmoke: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn().mockResolvedValue(undefined),
  uiStore: null as null | {
    commandPaletteOpen: boolean;
    load: ReturnType<typeof vi.fn>;
    toggleCommandPalette: () => void;
  },
  appStore: null as null | {
    loadAll: ReturnType<typeof vi.fn>;
    recordUse: ReturnType<typeof vi.fn>;
    toolById: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: lifecycle.emit,
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    lifecycle.listeners.set(name, handler);
    return vi.fn();
  }),
}));

vi.mock("@/stores/ui", async () => {
  const { reactive } = await import("vue");
  const uiStore = reactive({
    commandPaletteOpen: false,
    load: vi.fn().mockResolvedValue(undefined),
    toggleCommandPalette() {
      uiStore.commandPaletteOpen = !uiStore.commandPaletteOpen;
    },
  });
  lifecycle.uiStore = uiStore;
  return { useUiStore: () => uiStore };
});

vi.mock("@/stores/app", () => {
  const appStore = {
    loadAll: vi.fn().mockResolvedValue(undefined),
    recordUse: vi.fn().mockResolvedValue(undefined),
    toolById: vi.fn(),
  };
  lifecycle.appStore = appStore;
  return { useAppStore: () => appStore };
});

vi.mock("@/components/AppSidebar.vue", () => ({
  default: { template: "<aside data-testid='sidebar' />" },
}));

vi.mock("@/components/CommandPalette.vue", async () => {
  lifecycle.paletteModuleLoads += 1;
  const { defineComponent } = await import("vue");
  return {
    // Vitest's dynamic-import mock is a namespace object. Mark it as an ES
    // module so defineAsyncComponent unwraps this valid component from default.
    __esModule: true,
    default: defineComponent({
      name: "CommandPaletteTestStub",
      mounted() {
        lifecycle.paletteMounts += 1;
      },
      template: "<div data-testid='command-palette-chunk' />",
    }),
  };
});

vi.mock("@/lib/nativeSmoke", async () => {
  lifecycle.nativeSmokeModuleLoads += 1;
  if (lifecycle.nativeSmokeImportGate) await lifecycle.nativeSmokeImportGate;
  if (lifecycle.nativeSmokeImportFailure) throw lifecycle.nativeSmokeImportFailure;
  return { runNativeSmoke: lifecycle.runNativeSmoke };
});

vi.mock("@/lib/nativePluginSmoke", () => {
  lifecycle.nativePluginSmokeModuleLoads += 1;
  return { runNativePluginSmoke: lifecycle.runNativePluginSmoke };
});

vi.mock("@/lib/actionCatalog", () => ({ findBuiltinAction: vi.fn() }));
vi.mock("@/lib/openFileBus", () => ({ requestOpenFile: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

import App from "./App.vue";

let wrapper: ReturnType<typeof mount> | null = null;
let router: Router;

async function mountApp() {
  router = createRouter({
    history: createWebHistory(),
    routes: [{ path: "/", component: { template: "<div>home</div>" } }],
  });
  await router.push("/");
  await router.isReady();
  wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("App lazy startup boundaries", () => {
  beforeEach(() => {
    lifecycle.listeners.clear();
    lifecycle.paletteModuleLoads = 0;
    lifecycle.paletteMounts = 0;
    lifecycle.nativeSmokeModuleLoads = 0;
    lifecycle.nativePluginSmokeModuleLoads = 0;
    lifecycle.nativeSmokeImportGate = null;
    lifecycle.nativeSmokeImportFailure = null;
    lifecycle.runNativeSmoke.mockReset().mockResolvedValue(undefined);
    lifecycle.runNativePluginSmoke.mockReset().mockResolvedValue(undefined);
    lifecycle.emit.mockClear();
    if (lifecycle.uiStore) lifecycle.uiStore.commandPaletteOpen = false;
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.innerHTML = "";
  });

  it("runs each native smoke at most once and emits stable failures for import and runner rejection", async () => {
    const nativeImport = deferred();
    const pluginRunner = deferred();
    lifecycle.nativeSmokeImportGate = nativeImport.promise;
    lifecycle.nativeSmokeImportFailure = new Error("native chunk unavailable");
    lifecycle.runNativePluginSmoke.mockReturnValueOnce(pluginRunner.promise);
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    try {
      await mountApp();

      expect(lifecycle.listeners.has("native-smoke-start")).toBe(true);
      expect(lifecycle.listeners.has("native-plugin-smoke-start")).toBe(true);
      expect(lifecycle.nativeSmokeModuleLoads).toBe(0);
      expect(lifecycle.nativePluginSmokeModuleLoads).toBe(0);

      const smokeStart = {
        commit: "native-commit",
        version: "1.0",
        clipboardPassed: true,
        clipboardError: "original clipboard detail",
        mediaInput: "C:\\fixtures\\clip.mp4",
      };
      const nativeListener = lifecycle.listeners.get("native-smoke-start")!;
      nativeListener({ payload: smokeStart });
      nativeListener({ payload: { ...smokeStart, commit: "ignored-before-load" } });
      await flushPromises();
      expect(lifecycle.nativeSmokeModuleLoads).toBe(1);
      nativeImport.resolve();
      await flushPromises();

      const nativeResultCalls = lifecycle.emit.mock.calls.filter(
        ([eventName]) => eventName === "native-smoke-result",
      );
      expect(nativeResultCalls).toHaveLength(1);
      expect(nativeResultCalls[0][1]).toEqual(expect.objectContaining({
        scenario: "native-tauri-all-tools",
        commit: smokeStart.commit,
        version: smokeStart.version,
        total: 0,
        passed: 0,
        failed: 1,
        failures: [{
          id: "bootstrap",
          message: expect.stringMatching(
            /^native smoke module load failed:/,
          ),
        }],
        uniqueFailureIds: ["bootstrap"],
        nativeCapabilities: expect.objectContaining({ isolatedPortableData: false }),
      }));
      expect(lifecycle.runNativeSmoke).not.toHaveBeenCalled();

      nativeListener({ payload: { ...smokeStart, commit: "ignored-after-load" } });
      await flushPromises();
      expect(lifecycle.nativeSmokeModuleLoads).toBe(1);
      expect(lifecycle.emit.mock.calls.filter(([name]) => name === "native-smoke-result")).toHaveLength(1);

      const pluginStart = {
        commit: "plugin-commit",
        version: "2.0",
        plugins: [{ id: "plugin.one", name: "Plugin One", route: "/plugins/one", version: "1.2.3" }],
        bootstrapFailures: ["backend bootstrap failed"],
      };
      const pluginListener = lifecycle.listeners.get("native-plugin-smoke-start")!;
      pluginListener({ payload: pluginStart });
      pluginListener({ payload: { ...pluginStart, commit: "ignored-before-load" } });
      await flushPromises();
      expect(lifecycle.nativePluginSmokeModuleLoads).toBe(1);
      expect(lifecycle.runNativePluginSmoke).toHaveBeenCalledTimes(1);
      expect(lifecycle.runNativePluginSmoke).toHaveBeenCalledWith(
        router,
        lifecycle.appStore,
        pluginStart,
      );

      pluginListener({ payload: { ...pluginStart, commit: "ignored-in-flight" } });
      pluginRunner.reject(new Error("plugin runner exploded"));
      await flushPromises();

      const pluginResultCalls = lifecycle.emit.mock.calls.filter(
        ([eventName]) => eventName === "native-plugin-smoke-result",
      );
      expect(pluginResultCalls).toHaveLength(1);
      expect(pluginResultCalls[0][1]).toEqual(expect.objectContaining({
        scenario: "native-tauri-plugin-lifecycle",
        commit: pluginStart.commit,
        version: pluginStart.version,
        total: 1,
        passed: 0,
        failed: 2,
        failures: [
          { id: "bootstrap", message: "backend bootstrap failed" },
          { id: "bootstrap", message: "native plugin smoke runner failed: plugin runner exploded" },
        ],
        checks: [],
      }));

      pluginListener({ payload: { ...pluginStart, commit: "ignored-after-runner" } });
      await flushPromises();
      expect(lifecycle.runNativePluginSmoke).toHaveBeenCalledTimes(1);
      expect(lifecycle.emit.mock.calls.filter(
        ([name]) => name === "native-plugin-smoke-result",
      )).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("does not request the palette on initial render and keeps it mounted after Ctrl+K", async () => {
    const app = await mountApp();
    expect(lifecycle.paletteModuleLoads).toBe(0);
    expect(app.find("[data-testid='command-palette-chunk']").exists()).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await nextTick();
    await flushPromises();
    expect(lifecycle.paletteModuleLoads).toBe(1);
    expect(lifecycle.paletteMounts).toBe(1);
    expect(app.find("[data-testid='command-palette-chunk']").exists()).toBe(true);

    lifecycle.uiStore!.commandPaletteOpen = false;
    await nextTick();
    expect(app.find("[data-testid='command-palette-chunk']").exists()).toBe(true);
  });

  it("loads the palette when programmatic open is the first trigger", async () => {
    const app = await mountApp();
    expect(app.find("[data-testid='command-palette-chunk']").exists()).toBe(false);

    lifecycle.uiStore!.commandPaletteOpen = true;
    await nextTick();
    await flushPromises();
    expect(app.find("[data-testid='command-palette-chunk']").exists()).toBe(true);
  });

  it("also opens the lazy palette through Cmd+K", async () => {
    const app = await mountApp();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "K", metaKey: true }));
    await nextTick();
    await flushPromises();
    expect(app.find("[data-testid='command-palette-chunk']").exists()).toBe(true);
  });
});
