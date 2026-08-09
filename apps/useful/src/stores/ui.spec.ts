import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";

const setNativeTheme = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const ipcMock = vi.hoisted(() => ({
  getSettings: vi.fn().mockResolvedValue({ theme: "system", language: "zh-CN", developerMode: false, sidebarCollapsed: false }),
  updateSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: setNativeTheme }) }));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));

import { useUiStore } from "@/stores/ui";

describe("UI settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    setActivePinia(createPinia());
  });

  it("recovers a corrupt layout to the strict v1 default", async () => {
    localStorage.setItem("useful.navigation-layout.v1", '{"schemaVersion":"navigation-layout.v1","nav":[{"id":"/evil"}]}');
    const store = useUiStore();
    await store.load();
    expect(store.navigationLayout.nav.map((item) => item.id)).toEqual(["home", "library", "shop", "downloads", "settings"]);
    expect(JSON.parse(localStorage.getItem("useful.navigation-layout.v1")!).schemaVersion).toBe("navigation-layout.v1");
  });

  it("rejects duplicate or out-of-range persisted order values", async () => {
    localStorage.setItem("useful.navigation-layout.v1", JSON.stringify({
      schemaVersion: "navigation-layout.v1",
      density: "compact",
      nav: ["home", "library", "shop", "downloads", "settings"].map((id) => ({ id, visible: true, order: 0 })),
      home: ["recent", "favorites", "builtin"].map((id, order) => ({ id, visible: true, order })),
    }));
    const store = useUiStore();
    await store.load();
    expect(store.navigationLayout).toEqual({
      schemaVersion: "navigation-layout.v1",
      density: "comfortable",
      nav: ["home", "library", "shop", "downloads", "settings"].map((id, order) => ({ id, visible: true, order })),
      home: ["recent", "favorites", "builtin"].map((id, order) => ({ id, visible: true, order })),
    });
  });

  it("migrates the legacy data-only layout and forces settings visible", async () => {
    localStorage.setItem("useful.navigation-layout", JSON.stringify({
      density: "compact",
      navOrder: ["settings", "home", "library", "shop", "downloads"],
      hiddenNavIds: ["settings", "shop"],
      homeOrder: ["builtin", "recent", "favorites"],
      hiddenHomeSectionIds: ["recent"],
    }));
    const store = useUiStore();
    await store.load();
    expect(store.navigationLayout.density).toBe("compact");
    expect(store.navigationLayout.nav[0]).toMatchObject({ id: "settings", visible: true });
    expect(store.navigationLayout.nav.find((item) => item.id === "shop")?.visible).toBe(false);
    expect(localStorage.getItem("useful.navigation-layout")).toBeNull();
  });

  it("applies browser theme without invoking a native window outside Tauri", async () => {
    const store = useUiStore();
    await store.load();
    store.setTheme("dark");
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(setNativeTheme).not.toHaveBeenCalled();
  });

  it("hydrates native theme once, maps system to null, and does not write loaded settings back", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    ipcMock.getSettings.mockResolvedValueOnce({ theme: "dark", language: "en-US", developerMode: true, sidebarCollapsed: true });
    const store = useUiStore();
    await store.load();
    expect(setNativeTheme).toHaveBeenCalledTimes(1);
    expect(setNativeTheme).toHaveBeenLastCalledWith("dark");
    expect(ipcMock.updateSetting).not.toHaveBeenCalled();

    store.setTheme("system");
    await nextTick();
    expect(setNativeTheme).toHaveBeenLastCalledWith(null);
    expect(ipcMock.updateSetting).toHaveBeenCalledWith("theme", "system");
  });

});
