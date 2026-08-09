<script setup lang="ts">
// 工具卡片：展示工具，支持收藏、打开、创建桌面快捷方式；右键提供完整操作菜单。
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAppStore } from "@/stores/app";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import AppIcon from "./AppIcon.vue";
import type { ToolDefinition } from "@/lib/types";

const props = defineProps<{ tool: ToolDefinition }>();

const appStore = useAppStore();
const router = useRouter();
const toast = ref<string | null>(null);
const menu = ref<{ x: number; y: number } | null>(null);

const displayName = computed(() =>
  props.tool.category === "builtin" ? t(props.tool.name) : props.tool.name,
);
const displayDesc = computed(() =>
  props.tool.category === "builtin" ? t(props.tool.description) : props.tool.description,
);
const isFav = computed(() => appStore.isFavorite(props.tool.id));
const isPinned = computed(() => appStore.navigationPins.includes(props.tool.id));

const builtinIcon: Record<string, string> = {
  "builtin.video-trim": "video",
  "builtin.process-monitor": "process",
  "builtin.utilities": "wrench",
  "builtin.office": "office",
};
const iconName = computed(() => builtinIcon[props.tool.id] ?? "puzzle");

async function open(): Promise<void> {
  closeMenu();
  await appStore.recordUse(props.tool.id);
  await router.push(props.tool.route);
}

async function toggleFavorite(): Promise<void> {
  closeMenu();
  await appStore.toggleFavorite(props.tool.id);
}

async function togglePin(): Promise<void> {
  closeMenu();
  const next = !isPinned.value;
  try {
    await appStore.setPinned(props.tool.id, next);
    showToast(next ? t("tools.pinned") : t("tools.unpinned"));
  } catch {
    showToast(t("tools.pinFailed"));
  }
}

async function createShortcut(): Promise<void> {
  closeMenu();
  try {
    await ipc.createShortcut(props.tool.id);
    showToast(t("tools.shortcutCreated"));
  } catch {
    showToast(t("tools.shortcutFailed"));
  }
}

async function copyToolId(): Promise<void> {
  closeMenu();
  try {
    await navigator.clipboard.writeText(props.tool.id);
    showToast(t("tools.idCopied"));
  } catch {
    showToast(t("tools.idCopyFailed"));
  }
}

function openMenu(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const width = 200;
  const height = 220;
  const x = Math.min(e.clientX, window.innerWidth - width - 8);
  const y = Math.min(e.clientY, window.innerHeight - height - 8);
  menu.value = { x: Math.max(8, x), y: Math.max(8, y) };
}

function closeMenu(): void {
  menu.value = null;
}

function onGlobalClick(): void {
  closeMenu();
}

function showToast(msg: string): void {
  toast.value = msg;
  setTimeout(() => (toast.value = null), 2400);
}

onMounted(() => window.addEventListener("click", onGlobalClick));
onUnmounted(() => window.removeEventListener("click", onGlobalClick));
</script>

<template>
  <div class="useful-card tool-card" @contextmenu="openMenu">
    <div class="tool-card__head">
      <div class="tool-card__icon">
        <AppIcon :name="iconName" :size="24" />
      </div>
      <button
        class="useful-icon-btn tool-card__fav"
        :class="{ 'tool-card__fav--on': isFav }"
        :aria-label="isFav ? t('tools.unfavorite') : t('tools.favorite')"
        :aria-pressed="isFav"
        @click="toggleFavorite"
      >
        <AppIcon name="star" :size="18" />
      </button>
    </div>
    <h3 class="tool-card__title">{{ displayName }}</h3>
    <p class="tool-card__desc">{{ displayDesc }}</p>
    <div class="tool-card__footer">
      <button class="useful-btn useful-btn--primary" @click="open">
        {{ t("tools.open") }}
      </button>
      <button
        v-if="tool.supportsShortcut"
        class="useful-btn"
        :title="t('tools.createShortcut')"
        @click="createShortcut"
      >
        <AppIcon name="plus" :size="16" />
      </button>
    </div>
    <transition name="fade">
      <div v-if="toast" class="tool-card__toast" role="status">{{ toast }}</div>
    </transition>

    <Teleport to="body">
      <div
        v-if="menu"
        class="tool-card__menu"
        role="menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @click.stop
        @contextmenu.prevent
      >
        <div class="tool-card__menu-head">{{ displayName }}</div>
        <button class="tool-card__menu-item" role="menuitem" @click="open">
          {{ t("tools.open") }}
        </button>
        <button class="tool-card__menu-item" role="menuitem" @click="toggleFavorite">
          {{ isFav ? t("tools.unfavorite") : t("tools.favorite") }}
        </button>
        <button class="tool-card__menu-item" role="menuitem" @click="togglePin">
          {{ isPinned ? t("tools.unpin") : t("tools.pin") }}
        </button>
        <button
          v-if="tool.supportsShortcut"
          class="tool-card__menu-item"
          role="menuitem"
          @click="createShortcut"
        >
          {{ t("tools.createShortcut") }}
        </button>
        <div class="tool-card__menu-sep" />
        <button class="tool-card__menu-item" role="menuitem" @click="copyToolId">
          {{ t("tools.copyId") }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tool-card {
  display: flex;
  flex-direction: column;
  position: relative;
}
.tool-card__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.tool-card__icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--useful-radius-md);
  background: var(--useful-bg-selected);
  color: var(--useful-accent);
}
.tool-card__fav {
  color: var(--useful-text-tertiary);
}
.tool-card__fav--on {
  color: #f2b705;
}
.tool-card__title {
  font-size: var(--useful-text-lg);
  font-weight: 600;
  margin: var(--useful-space-3) 0 var(--useful-space-1);
}
.tool-card__desc {
  flex: 1;
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
  margin: 0 0 var(--useful-space-3);
  min-height: 34px;
}
.tool-card__footer {
  display: flex;
  gap: var(--useful-space-2);
}
.tool-card__toast {
  position: absolute;
  bottom: var(--useful-space-3);
  left: 50%;
  transform: translateX(-50%);
  background: var(--useful-bg-active);
  color: var(--useful-text);
  padding: 4px 12px;
  border-radius: var(--useful-radius-md);
  font-size: var(--useful-text-xs);
  white-space: nowrap;
  z-index: 2;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--useful-transition);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

<style>
.tool-card__menu {
  position: fixed;
  z-index: 1000;
  min-width: 200px;
  max-width: min(280px, calc(100vw - 16px));
  background: var(--useful-bg-elevated);
  border: 1px solid var(--useful-border-strong);
  border-radius: var(--useful-radius-md);
  box-shadow: var(--useful-shadow-lg);
  padding: 4px;
}
.tool-card__menu-head {
  padding: 8px 12px 6px;
  font-size: var(--useful-text-sm);
  font-weight: 600;
  color: var(--useful-text);
  border-bottom: 1px solid var(--useful-border);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-card__menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--useful-text);
  cursor: pointer;
  border-radius: var(--useful-radius-sm);
  font-family: inherit;
  font-size: var(--useful-text-sm);
}
.tool-card__menu-item:hover {
  background: var(--useful-bg-hover);
}
.tool-card__menu-sep {
  height: 1px;
  background: var(--useful-border);
  margin: 4px 0;
}
</style>
