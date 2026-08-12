// UI 状态：主题、侧边栏折叠、命令面板、开发者模式。
import { defineStore } from "pinia";
import { computed, nextTick, ref, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ipc from "@/lib/ipc";
import { getLocale, setLocale } from "@/i18n";
import {
  HOME_SECTION_IDS,
  NAVIGATION_ITEM_IDS,
  type HomeSectionId,
  type Locale,
  type NavigationDensity,
  type NavigationItemId,
  type NavigationLayoutItem,
  type NavigationLayoutV1,
  type Settings,
  type Theme,
} from "@/lib/types";

const LAYOUT_STORAGE_KEY = "useful.navigation-layout.v1";
const LEGACY_LAYOUT_STORAGE_KEY = "useful.navigation-layout";

function orderedItems<T extends string>(ids: readonly T[]): NavigationLayoutItem<T>[] {
  return ids.map((id, order) => ({ id, visible: true, order }));
}

export function defaultNavigationLayout(): NavigationLayoutV1 {
  return {
    schemaVersion: "navigation-layout.v1",
    density: "comfortable",
    nav: orderedItems(NAVIGATION_ITEM_IDS),
    home: orderedItems(HOME_SECTION_IDS),
  };
}

function parseItems<T extends string>(value: unknown, ids: readonly T[], requiredVisible?: T): NavigationLayoutItem<T>[] | null {
  if (!Array.isArray(value) || value.length !== ids.length) return null;
  const allowed = new Set<string>(ids);
  const parsed: NavigationLayoutItem<T>[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !allowed.has(item.id) || typeof item.visible !== "boolean" || !Number.isInteger(item.order)) return null;
    parsed.push({ id: item.id as T, visible: item.id === requiredVisible ? true : item.visible, order: item.order as number });
  }
  if (new Set(parsed.map((item) => item.id)).size !== ids.length) return null;
  const orders = parsed.map((item) => item.order);
  if (new Set(orders).size !== ids.length || orders.some((order) => order < 0 || order >= ids.length)) return null;
  return parsed.sort((a, b) => a.order - b.order).map((item, order) => ({ ...item, order }));
}

export function parseNavigationLayout(raw: string | null): NavigationLayoutV1 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.schemaVersion !== "navigation-layout.v1" || (value.density !== "comfortable" && value.density !== "compact")) return null;
    const nav = parseItems(value.nav, NAVIGATION_ITEM_IDS, "settings");
    const home = parseItems(value.home, HOME_SECTION_IDS);
    return nav && home ? { schemaVersion: "navigation-layout.v1", density: value.density, nav, home } : null;
  } catch {
    return null;
  }
}

function migrateLegacyLayout(raw: string | null): NavigationLayoutV1 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const density = value.density === "compact" ? "compact" : "comfortable";
    const navOrder = Array.isArray(value.navOrder) ? value.navOrder : [];
    const homeOrder = Array.isArray(value.homeOrder) ? value.homeOrder : [];
    const hiddenNav = new Set(Array.isArray(value.hiddenNavIds) ? value.hiddenNavIds : []);
    const hiddenHome = new Set(Array.isArray(value.hiddenHomeSectionIds) ? value.hiddenHomeSectionIds : []);
    if (navOrder.length !== NAVIGATION_ITEM_IDS.length || homeOrder.length !== HOME_SECTION_IDS.length) return null;
    const nav = parseItems(navOrder.map((id, order) => ({ id, order, visible: id === "settings" || !hiddenNav.has(id) })), NAVIGATION_ITEM_IDS, "settings");
    const home = parseItems(homeOrder.map((id, order) => ({ id, order, visible: !hiddenHome.has(id) })), HOME_SECTION_IDS);
    return nav && home ? { schemaVersion: "navigation-layout.v1", density, nav, home } : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const resolved =
    theme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  // Keep the WebView form chrome and form controls aligned with the content theme.
  document.documentElement.style.colorScheme = resolved;
}

async function applyNativeTheme(theme: Theme): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  await getCurrentWindow().setTheme(theme === "system" ? null : theme);
}

export const useUiStore = defineStore("ui", () => {
  const theme = ref<Theme>("system");
  const language = ref<Locale>("zh-CN");
  const requestedLanguage = ref<Locale>("zh-CN");
  const sidebarCollapsed = ref(false);
  const developerMode = ref(false);
  const commandPaletteOpen = ref(false);
  const loaded = ref(false);
  const navigationLayout = ref<NavigationLayoutV1>(defaultNavigationLayout());
  let languageIntentGeneration = 0;
  let suppressLanguageWatch = false;

  const visibleNavigation = computed(() => navigationLayout.value.nav.filter((item) => item.visible).sort((a, b) => a.order - b.order));
  const visibleHomeSections = computed(() => navigationLayout.value.home.filter((item) => item.visible).sort((a, b) => a.order - b.order));

  function loadNavigationLayout(): void {
    if (typeof localStorage === "undefined") return;
    const current = parseNavigationLayout(localStorage.getItem(LAYOUT_STORAGE_KEY));
    const migrated =
      current ??
      migrateLegacyLayout(localStorage.getItem(LEGACY_LAYOUT_STORAGE_KEY));
    navigationLayout.value = migrated ?? defaultNavigationLayout();
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(navigationLayout.value));
    if (migrated && !current) {
      localStorage.removeItem(LEGACY_LAYOUT_STORAGE_KEY);
    }
  }

  function syncLanguageState(locale: Locale): void {
    if (language.value === locale) return;
    suppressLanguageWatch = true;
    language.value = locale;
    suppressLanguageWatch = false;
  }

  async function applyLanguageIntent(locale: Locale, generation: number, persist: boolean): Promise<boolean> {
    const applied = await setLocale(locale);
    if (generation !== languageIntentGeneration) return false;
    if (!applied) {
      const activeLocale = getLocale();
      syncLanguageState(activeLocale);
      requestedLanguage.value = activeLocale;
      return false;
    }
    syncLanguageState(locale);
    requestedLanguage.value = locale;
    if (persist) void ipc.updateSetting("language", locale).catch(() => {});
    return true;
  }

  async function load(): Promise<void> {
    const languageIntent = ++languageIntentGeneration;
    let persistedLanguage = language.value;
    try {
      const settings: Settings = await ipc.getSettings();
      theme.value = settings.theme;
      persistedLanguage = settings.language;
      sidebarCollapsed.value = settings.sidebarCollapsed;
      developerMode.value = settings.developerMode;
    } catch {
      // 后端不可用（如纯前端测试）时使用默认值
    }
    applyTheme(theme.value);
    void applyNativeTheme(theme.value).catch(() => {});
    if (languageIntent === languageIntentGeneration) {
      requestedLanguage.value = persistedLanguage;
      await applyLanguageIntent(persistedLanguage, languageIntent, false);
    }
    loadNavigationLayout();
    // Flush hydration watchers while persistence is still disabled. Loaded settings
    // must not be written back or invoke the native theme contract a second time.
    await nextTick();
    loaded.value = true;
  }

  watch(theme, (t) => {
    applyTheme(t);
    if (!loaded.value) return;
    void applyNativeTheme(t).catch(() => {});
    void ipc.updateSetting("theme", t).catch(() => {});
  });
  watch(language, (locale) => {
    if (suppressLanguageWatch) return;
    const generation = ++languageIntentGeneration;
    requestedLanguage.value = locale;
    void applyLanguageIntent(locale, generation, loaded.value).catch(() => {});
  }, { flush: "sync" });
  watch(sidebarCollapsed, (v) => {
    if (!loaded.value) return;
    void ipc.updateSetting("sidebarCollapsed", String(v)).catch(() => {});
  });
  watch(developerMode, (v) => {
    if (!loaded.value) return;
    void ipc.updateSetting("developerMode", String(v)).catch(() => {});
  });

  // 跟随系统主题变化
  if (typeof window !== "undefined" && window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (theme.value === "system") applyTheme("system");
      });
  }

  function setTheme(t: Theme): void {
    theme.value = t;
  }
  function setLanguage(locale: Locale): Promise<boolean> {
    const generation = ++languageIntentGeneration;
    requestedLanguage.value = locale;
    return applyLanguageIntent(locale, generation, true);
  }
  function setNavigationDensity(density: NavigationDensity): void {
    navigationLayout.value = { ...navigationLayout.value, density };
    persistNavigationLayout();
  }
  function setLayoutItemVisible(group: "nav" | "home", id: NavigationItemId | HomeSectionId, visible: boolean): void {
    if (group === "nav" && id === "settings") return;
    navigationLayout.value = {
      ...navigationLayout.value,
      [group]: navigationLayout.value[group].map((item) => item.id === id ? { ...item, visible } : item),
    } as NavigationLayoutV1;
    persistNavigationLayout();
  }
  function moveLayoutItem(group: "nav" | "home", id: NavigationItemId | HomeSectionId, direction: -1 | 1): void {
    const items = [...navigationLayout.value[group]].sort((a, b) => a.order - b.order);
    const index = items.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
    navigationLayout.value = { ...navigationLayout.value, [group]: items.map((item, order) => ({ ...item, order })) } as NavigationLayoutV1;
    persistNavigationLayout();
  }
  function persistNavigationLayout(): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(navigationLayout.value));
  }
  function resetNavigationLayout(): void {
    navigationLayout.value = defaultNavigationLayout();
    persistNavigationLayout();
  }
  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }
  function toggleCommandPalette(): void {
    commandPaletteOpen.value = !commandPaletteOpen.value;
  }

  return {
    theme,
    language,
    requestedLanguage,
    sidebarCollapsed,
    developerMode,
    commandPaletteOpen,
    loaded,
    navigationLayout,
    visibleNavigation,
    visibleHomeSections,
    load,
    setTheme,
    setLanguage,
    setNavigationDensity,
    setLayoutItemVisible,
    moveLayoutItem,
    resetNavigationLayout,
    toggleSidebar,
    toggleCommandPalette,
  };
});
