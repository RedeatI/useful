<script setup lang="ts">
// Ctrl+K 命令面板：统一搜索工具、Action 与导航，并支持完整键盘操作。
import { computed, ref, watch, nextTick } from "vue";
import { useRouter } from "vue-router";
import { useAppStore } from "@/stores/app";
import { useUiStore } from "@/stores/ui";
import { t } from "@/i18n";
import AppIcon from "./AppIcon.vue";
import { buildLibraryItems } from "@/lib/toolLibrary";
import { BUILTIN_GUI_ACTIONS } from "@/lib/actionCatalog";
import { discoverItems } from "@/lib/toolDiscovery";

interface PaletteItem {
  id: string;
  label: string;
  subLabel?: string;
  route: string;
  icon: string;
  toolId?: string;
  actionId?: string;
  description?: string;
  keywords: string[];
  aliases: string[];
  category: string;
  source: string;
  order: number;
}

const appStore = useAppStore();
const uiStore = useUiStore();
const router = useRouter();

const query = ref("");
const activeIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

const open = computed(() => uiStore.commandPaletteOpen);
const libraryItems = computed(() => buildLibraryItems({
  tools: appStore.tools,
  toolFavorites: appStore.favorites,
  actionFavorites: appStore.actionFavorites,
  pins: appStore.navigationPins,
}));
const libraryById = computed(() => new Map(libraryItems.value.map((item) => [item.id, item])));

function metadata(id: string): string {
  const item = libraryById.value.get(id);
  if (!item) return "";
  const source = t(item.source === "builtin" ? "commandPalette.sourceBuiltin" : "commandPalette.sourcePlugin");
  const publisher = item.publisherId
    ? t("commandPalette.publisher", { publisher: item.publisherId })
    : item.source === "plugin"
      ? t("commandPalette.publisherRuntime")
      : t("commandPalette.publisherUndeclared");
  const surfaces = item.surfaces.map((surface) => surface.toUpperCase()).join(" · ");
  const access = item.readOnly === true
    ? t("commandPalette.readOnly")
    : item.permissions.length
      ? t("commandPalette.permissions", { permissions: item.permissions.join(", ") })
      : t("commandPalette.noExtraPermissions");
  const runtime = item.agentResolution === "runtime-required"
    ? ` · ${t("commandPalette.runtimeRequired")}`
    : "";
  return `${source} · ${publisher} · ${surfaces} · ${access}${runtime}`;
}

const allItems = computed<PaletteItem[]>(() => {
  // Rust 后端注册的顶级 GUI 工具。
  const toolItems: PaletteItem[] = appStore.tools
    .filter((tool) => !["builtin.utilities", "builtin.office"].includes(tool.id))
    .map((tool) => ({
      id: tool.id,
      label: tool.category === "builtin" ? t(tool.name) : tool.name,
      subLabel: metadata(tool.id),
      route: tool.route,
      icon: tool.category === "builtin" ? iconForBuiltin(tool.id) : "puzzle",
      toolId: tool.id,
      description: tool.category === "builtin" ? t(tool.description) : tool.description,
      keywords: [tool.id],
      aliases: [],
      category: tool.category,
      source: tool.category === "installed" ? "plugin" : "builtin",
      order: 10_000 + tool.order,
    }));

  // 31 个 utility 与 5 个 Office Action 从统一 GUI catalog 派生。
  const actionItems: PaletteItem[] = BUILTIN_GUI_ACTIONS.map((action) => ({
    id: action.id,
    label: t(action.nameKey),
    subLabel: metadata(action.id),
    route: action.route,
    icon: action.icon,
    actionId: action.id,
    description: t(action.descKey),
    keywords: [...action.keywords],
    aliases: [...action.aliases],
    category: action.category,
    source: "builtin",
    order: action.order,
  }));

  const actionItemsNav: PaletteItem[] = [
    ["nav-home", "nav.home", "/", "home"],
    ["nav-library", "nav.library", "/library", "grid"],
    ["nav-utilities", "util.title", "/tools/utilities", "grid"],
    ["nav-office", "tools.office.name", "/tools/office", "office"],
    ["nav-shop", "nav.toolShop", "/shop", "shop"],
    ["nav-sources", "nav.sourceCenter", "/sources", "source"],
    ["nav-downloads", "nav.downloads", "/downloads", "download"],
    ["nav-settings", "nav.settings", "/settings", "settings"],
  ].map(([id, labelKey, route, icon], index) => ({
    id,
    label: t(labelKey),
    route,
    icon,
    keywords: [],
    aliases: [],
    category: "navigation",
    source: "navigation",
    order: 100_000 + index,
  }));
  return [...toolItems, ...actionItems, ...actionItemsNav];
});

// 内置工具图标映射。
function iconForBuiltin(toolId: string): string {
  const map: Record<string, string> = {
    "builtin.office": "office",
    "builtin.video-trim": "video",
    "builtin.process-monitor": "process",
  };
  return map[toolId] ?? "puzzle";
}

const filtered = computed<PaletteItem[]>(() => {
  return discoverItems(allItems.value, query.value, (item) => ({
    id: item.id,
    name: item.label,
    description: item.description,
    keywords: item.keywords,
    aliases: item.aliases,
    category: item.category,
    source: item.source,
    order: item.order,
  }));
});

watch(open, async (isOpen) => {
  if (isOpen) {
    previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    query.value = "";
    activeIndex.value = 0;
    await nextTick();
    inputRef.value?.focus();
  } else {
    await nextTick();
    previouslyFocused?.focus();
    previouslyFocused = null;
  }
});
watch(filtered, () => {
  activeIndex.value = 0;
});
watch(activeIndex, async (index) => {
  await nextTick();
  document.getElementById(`command-palette-option-${index}`)?.scrollIntoView({ block: "nearest" });
});

async function select(item: PaletteItem): Promise<void> {
  closePalette();
  if (item.toolId) await appStore.recordUse(item.toolId);
  await router.push(item.route);
}

function closePalette(): void {
  uiStore.commandPaletteOpen = false;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    closePalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % Math.max(filtered.value.length, 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex.value =
      (activeIndex.value - 1 + filtered.value.length) % Math.max(filtered.value.length, 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = filtered.value[activeIndex.value];
    if (item) void select(item);
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="palette-overlay"
      @click="closePalette"
    >
      <div
        class="palette"
        role="dialog"
        aria-modal="true"
        :aria-label="t('commandPalette.title')"
        @click.stop
      >
        <div class="palette__search">
          <AppIcon name="search" :size="18" />
          <input
            ref="inputRef"
            v-model="query"
            class="palette__input"
            type="text"
            :placeholder="t('commandPalette.placeholder')"
            :aria-label="t('commandPalette.placeholder')"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="command-palette-listbox"
            :aria-expanded="open"
            :aria-activedescendant="filtered.length ? `command-palette-option-${activeIndex}` : undefined"
            @keydown="onKeydown"
          />
        </div>
        <ul v-if="filtered.length" id="command-palette-listbox" class="palette__list" role="listbox">
          <li
            v-for="(item, idx) in filtered"
            :key="item.id"
            :id="`command-palette-option-${idx}`"
            class="palette__item"
            :class="{ 'palette__item--active': idx === activeIndex }"
            role="option"
            :aria-selected="idx === activeIndex"
            @click="select(item)"
            @mouseenter="activeIndex = idx"
          >
            <AppIcon :name="item.icon" :size="18" />
            <span class="palette__label">{{ item.label }}</span>
            <span v-if="item.subLabel" class="palette__sub">{{ item.subLabel }}</span>
            <span v-if="idx === activeIndex" class="palette__hint">
              {{ t("commandPalette.hintOpen") }} ↵
            </span>
          </li>
        </ul>
        <div v-else class="palette__empty">{{ t("commandPalette.noResults") }}</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.palette-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  z-index: 1000;
}
.palette {
  width: min(560px, 92vw);
  background: var(--useful-bg-elevated);
  border: 1px solid var(--useful-border-strong);
  border-radius: var(--useful-radius-lg);
  box-shadow: var(--useful-shadow-lg);
  overflow: hidden;
}
.palette__search {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  padding: var(--useful-space-3) var(--useful-space-4);
  border-bottom: 1px solid var(--useful-border);
  color: var(--useful-text-secondary);
}
.palette__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--useful-text);
  font-size: var(--useful-text-lg);
  font-family: inherit;
}
.palette__list {
  list-style: none;
  margin: 0;
  padding: var(--useful-space-2);
  max-height: 50vh;
  overflow-y: auto;
}
.palette__item {
  display: flex;
  align-items: center;
  gap: var(--useful-space-3);
  padding: 10px 12px;
  border-radius: var(--useful-radius-md);
  cursor: pointer;
  color: var(--useful-text);
}
.palette__item--active {
  background: var(--useful-bg-selected);
  color: var(--useful-accent);
}
.palette__label {
  flex: 1;
}
.palette__sub {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
}
.palette__hint {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
}
.palette__empty {
  padding: var(--useful-space-5);
  text-align: center;
  color: var(--useful-text-tertiary);
}
</style>
