<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "@/i18n";
import { buildLibraryItems } from "@/lib/toolLibrary";
import { useAppStore } from "@/stores/app";
import { useUiStore } from "@/stores/ui";
import AppIcon from "./AppIcon.vue";
import type { NavigationItemId } from "@/lib/types";

const appStore = useAppStore();
const uiStore = useUiStore();
const router = useRouter();
const route = useRoute();
const collapsed = computed(() => uiStore.sidebarCollapsed);
const navDefinitions: Record<NavigationItemId, { route: string; icon: string; label: string }> = {
  home: { route: "/", icon: "home", label: "nav.home" },
  library: { route: "/library", icon: "grid", label: "nav.library" },
  shop: { route: "/shop", icon: "shop", label: "nav.toolShop" },
  downloads: { route: "/downloads", icon: "download", label: "nav.downloads" },
  settings: { route: "/settings", icon: "settings", label: "nav.settings" },
};
const navigation = computed(() => uiStore.visibleNavigation.map((item) => ({ id: item.id, ...navDefinitions[item.id] })));
const pinned = computed(() => buildLibraryItems({
  tools: appStore.tools,
  toolFavorites: appStore.favorites,
  actionFavorites: appStore.actionFavorites,
  pins: appStore.navigationPins,
}).filter((item) => item.pinned));

function isActive(path: string): boolean {
  return route.path === path || (path !== "/" && route.path.startsWith(`${path}/`));
}
function itemLabel(item: (typeof pinned.value)[number]): string {
  return item.translated ? t(item.name) : item.name;
}
async function go(path: string, item?: (typeof pinned.value)[number]): Promise<void> {
  try {
    // Built-in Action destinations record their own visits so direct links and
    // every navigation source share one accounting path.
    if (item?.kind === "tool") await appStore.recordUse(item.id);
    const hashIndex = path.indexOf("#");
    if (hashIndex >= 0) {
      const routePath = path.slice(0, hashIndex) || "/";
      const hash = path.slice(hashIndex); // includes leading #
      await router.push({ path: routePath, hash });
    } else {
      await router.push(path);
    }
  } catch (error) {
    console.error("sidebar navigation failed", path, error);
  }
}
</script>

<template>
  <nav
    class="sidebar"
    :class="{ 'sidebar--collapsed': collapsed, 'sidebar--compact': uiStore.navigationLayout.density === 'compact' }"
    :aria-label="t('app.name')"
  >
    <div class="sidebar__header">
      <button class="useful-icon-btn" :aria-label="collapsed ? t('nav.expand') : t('nav.collapse')" @click="uiStore.toggleSidebar()">
        <AppIcon name="menu" />
      </button>
      <span v-if="!collapsed" class="sidebar__brand">{{ t("app.name") }}</span>
    </div>

    <div class="sidebar__scroll">
      <button
        v-for="item in navigation"
        :key="item.id"
        class="nav-item"
        :class="{ 'nav-item--active': isActive(item.route) }"
        :aria-current="isActive(item.route) ? 'page' : undefined"
        :title="t(item.label)"
        @click="go(item.route)"
      >
        <AppIcon :name="item.icon" /><span v-if="!collapsed">{{ t(item.label) }}</span>
      </button>

      <div v-if="!collapsed" class="nav-group-label">{{ t("nav.quickAccess") }}</div>
      <template v-if="pinned.length">
        <button
          v-for="item in pinned" :key="item.id" class="nav-item"
          :class="{ 'nav-item--active': isActive(item.route) }"
          :aria-current="isActive(item.route) ? 'page' : undefined"
          :title="itemLabel(item)" @click="go(item.route, item)"
        >
          <AppIcon :name="item.icon" /><span v-if="!collapsed">{{ itemLabel(item) }}</span>
        </button>
      </template>
      <p v-else-if="!collapsed" class="nav-empty">{{ t("nav.quickAccessEmpty") }}</p>
    </div>

    <div class="sidebar__footer">
      <button
        class="nav-item"
        :class="{ 'nav-item--active': isActive('/settings') && route.hash === '#navigation-layout' }"
        :title="t('nav.customizeLayout')"
        @click="go('/settings#navigation-layout')"
      >
        <AppIcon name="settings" /><span v-if="!collapsed">{{ t("nav.customizeLayout") }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.sidebar { display: flex; flex-direction: column; width: var(--useful-sidebar-width); height: 100%; background: var(--useful-bg-layer); border-right: 1px solid var(--useful-border); transition: width var(--useful-transition); flex-shrink: 0; }
.sidebar--collapsed { width: var(--useful-sidebar-width-collapsed); }
.sidebar__header { display: flex; align-items: center; gap: var(--useful-space-2); padding: var(--useful-space-3); height: 52px; }
.sidebar__brand { font-weight: 700; font-size: var(--useful-text-lg); white-space: nowrap; }
.sidebar__scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: var(--useful-space-2); }
.nav-group-label { font-size: var(--useful-text-xs); color: var(--useful-text-tertiary); padding: var(--useful-space-3) var(--useful-space-3) var(--useful-space-1); }
.nav-item { display: flex; align-items: center; gap: var(--useful-space-3); width: 100%; min-height: 40px; padding: 8px 10px; margin-bottom: 2px; font-size: var(--useful-text-md); font-family: inherit; color: var(--useful-text); background: transparent; border: none; border-radius: var(--useful-radius-md); cursor: pointer; text-align: left; white-space: nowrap; transition: background var(--useful-transition); }
.sidebar--compact .nav-item { min-height: 32px; padding-block: 4px; }
.nav-item:hover { background: var(--useful-bg-hover); }
.nav-item--active { background: var(--useful-bg-selected); color: var(--useful-accent); font-weight: 600; }
.nav-empty { font-size: var(--useful-text-xs); line-height: 1.45; color: var(--useful-text-tertiary); padding: 0 var(--useful-space-3) var(--useful-space-2); }
.sidebar__footer { border-top: 1px solid var(--useful-border); padding: var(--useful-space-2); }
</style>
