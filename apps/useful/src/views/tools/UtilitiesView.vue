<script setup lang="ts">
// 实用工具：DevToys 风格的可搜索工具网格；选中工具时渲染其组件。
// 网格与工具组件同页切换，路由 /tools/utilities/:id 决定当前工具。
// Phase 12：action 级收藏、最近使用、快捷方式均从统一注册表派生。
// 记住上次打开的 action：访问 /tools/utilities 无 id 时打开最近使用的。
import { computed, ref, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { t } from "@/i18n";
import AppIcon from "@/components/AppIcon.vue";
import { useAppStore } from "@/stores/app";
import ipc from "@/lib/ipc";
import { discoverItems } from "@/lib/toolDiscovery";
import {
  UTIL_CATEGORIES,
  UTIL_TOOLS,
  PARENT_TOOL_ID,
  findTool,
  shortIdToAction,
  type UtilTool,
} from "@/lib/tools/registry";

const props = defineProps<{ id?: string }>();
const router = useRouter();
const appStore = useAppStore();
const search = ref("");

const current = computed<UtilTool | undefined>(() =>
  props.id ? findTool(props.id) : undefined,
);

// 未知 action ID 错误状态
const notFound = ref(false);

// 搜索与排序使用全应用统一的 NFKC/分词/相关性契约。
const filtered = computed<UtilTool[]>(() => {
  return discoverItems(UTIL_TOOLS, search.value, (tool) => ({
    id: tool.id,
    name: t(tool.nameKey),
    description: t(tool.descKey),
    keywords: tool.keywords,
    aliases: tool.aliases,
    category: tool.category,
    source: "builtin",
    order: tool.order ?? UTIL_TOOLS.indexOf(tool),
  }));
});

const grouped = computed(() =>
  UTIL_CATEGORIES.map((c) => ({
    ...c,
    tools: filtered.value.filter((tool) => tool.category === c.key),
  })).filter((g) => g.tools.length > 0),
);

// 收藏的 actions（仅显示存在的）
const favoriteActions = computed(() => appStore.favoriteActions.filter((action) => action.parentToolId === PARENT_TOOL_ID));
// 最近使用的 actions
const recentActions = computed(() => appStore.recentActions.filter((action) => action.parentToolId === PARENT_TOOL_ID));

function open(tool: UtilTool): void {
  router.push(`/tools/utilities/${tool.id}`);
}
function back(): void {
  router.push("/tools/utilities");
}

function toggleFav(tool: UtilTool): void {
  void appStore.toggleActionFav(shortIdToAction(tool.id));
}

function isFav(tool: UtilTool): boolean {
  return appStore.isActionFavorite(shortIdToAction(tool.id));
}

function openAction(actionId: string): void {
  const shortId = actionId.replace(/^builtin\.utilities\./, "");
  router.push(`/tools/utilities/${shortId}`);
}

async function createShortcut(tool: UtilTool): Promise<void> {
  try {
    await ipc.createActionShortcut(shortIdToAction(tool.id), t(tool.nameKey));
  } catch {
    // 非 Tauri 环境忽略
  }
}

// 路由 id 处理：无效 ID 显示错误页（不崩溃），有效 ID 记录使用
watch(
  () => props.id,
  (id) => {
    notFound.value = false;
    if (!id) return; // 无 id = 网格首页
    const tool = findTool(id);
    if (!tool) {
      // 未知 action ID：安全错误页，不崩溃
      notFound.value = true;
      return;
    }
    // 有效工具：记录使用
    void appStore.recordActionUse(shortIdToAction(id));
  },
  { immediate: true },
);

// 访问 /tools/utilities 无 id 时，打开最近使用的 action
onMounted(() => {
  if (!props.id && recentActions.value.length > 0) {
    const lastAction = recentActions.value[0];
    const shortId = lastAction.id.replace(/^builtin\.utilities\./, "");
    // 仅替换 URL，不额外记录（避免循环）
    router.replace(`/tools/utilities/${shortId}`);
  }
});
</script>

<template>
  <div class="util">
    <!-- 未知 action ID 安全错误页 -->
    <template v-if="notFound">
      <div class="util__notfound">
        <AppIcon name="alert" :size="32" />
        <h2>{{ t('util.notFound') }}</h2>
        <p>{{ t('util.notFoundHint', { id: props.id ?? 'unknown' }) }}</p>
        <button class="useful-btn useful-btn--primary" @click="back">
          <AppIcon name="grid" :size="16" /> {{ t('util.backToGrid') }}
        </button>
      </div>
    </template>

    <!-- 工具详情 -->
    <template v-else-if="current">
      <div class="util__bar">
        <button class="useful-btn useful-btn--ghost" @click="back">
          <AppIcon name="chevronLeft" :size="16" />{{ t("util.back") }}
        </button>
        <span class="util__crumb">
          <AppIcon name="grid" :size="14" /> {{ t("util.title") }} /
          {{ t(current.nameKey) }}
        </span>
        <button
          class="useful-icon-btn util__fav-btn"
          :class="{ 'util__fav-btn--active': isFav(current) }"
          :title="isFav(current) ? t('util.unfavorite') : t('util.favorite')"
          :aria-label="isFav(current) ? `${t('util.unfavorite')} ${t(current.nameKey)}` : `${t('util.favorite')} ${t(current.nameKey)}`"
          :aria-pressed="isFav(current)"
          @click="toggleFav(current)"
        >
          <AppIcon :name="isFav(current) ? 'star' : 'star'" :size="18" />
        </button>
        <button
          class="useful-icon-btn util__shortcut-btn"
          :title="t('util.createShortcut')"
          :aria-label="`${t('util.createShortcut')} ${t(current.nameKey)}`"
          @click="createShortcut(current)"
        >
          <AppIcon name="link" :size="18" />
        </button>
      </div>
      <div class="util__tool">
        <component :is="current.component" />
      </div>
    </template>

    <!-- 工具网格 -->
    <template v-else>
      <div class="util__head">
        <div>
          <h1 class="util__title">{{ t("util.title") }}</h1>
          <p class="util__subtitle">
            {{ t("util.subtitle", { count: UTIL_TOOLS.length }) }}
          </p>
        </div>
        <input
          v-model="search"
          class="useful-input util__search"
          type="text"
          :placeholder="t('util.searchPlaceholder')"
          :aria-label="t('util.searchPlaceholder')"
        />
      </div>

      <div class="util__scroll">
        <!-- 收藏的 actions -->
        <section v-if="favoriteActions.length > 0" class="util__group util__group--fav">
          <h2 class="util__cat">
            <AppIcon name="star" :size="14" /> {{ t("util.favorites") }}
          </h2>
          <div class="util__grid">
            <button
              v-for="action in favoriteActions"
              :key="action.id"
              class="tool-card tool-card--fav"
              @click="openAction(action.id)"
            >
              <span class="tool-card__icon"><AppIcon :name="action.icon" :size="22" /></span>
              <span class="tool-card__body">
                <span class="tool-card__name">{{ t(action.nameKey) }}</span>
                <span class="tool-card__desc">{{ t(action.descKey) }}</span>
              </span>
            </button>
          </div>
        </section>

        <!-- 最近使用 -->
        <section v-if="recentActions.length > 0" class="util__group">
          <h2 class="util__cat">
            <AppIcon name="clock" :size="14" /> {{ t("util.recent") }}
          </h2>
          <div class="util__grid">
            <button
              v-for="action in recentActions"
              :key="action.id"
              class="tool-card"
              @click="openAction(action.id)"
            >
              <span class="tool-card__icon"><AppIcon :name="action.icon" :size="22" /></span>
              <span class="tool-card__body">
                <span class="tool-card__name">{{ t(action.nameKey) }}</span>
                <span class="tool-card__desc">{{ t(action.descKey) }}</span>
              </span>
            </button>
          </div>
        </section>

        <p v-if="grouped.length === 0" class="util__empty">
          {{ t("util.noMatch") }}
        </p>
        <section v-for="g in grouped" :key="g.key" class="util__group">
          <h2 class="util__cat">{{ t(g.labelKey) }}</h2>
          <div class="util__grid">
            <article
              v-for="tool in g.tools"
              :key="tool.id"
              class="tool-card"
            >
              <button class="tool-card__main" @click="open(tool)">
                <span class="tool-card__icon"><AppIcon :name="tool.icon" :size="22" /></span>
                <span class="tool-card__body">
                  <span class="tool-card__name">{{ t(tool.nameKey) }}</span>
                  <span class="tool-card__desc">{{ t(tool.descKey) }}</span>
                </span>
              </button>
              <button
                class="tool-card__fav useful-icon-btn"
                :class="{ 'tool-card__fav--active': isFav(tool) }"
                :title="isFav(tool) ? t('util.unfavorite') : t('util.favorite')"
                :aria-label="isFav(tool) ? `${t('util.unfavorite')} ${t(tool.nameKey)}` : `${t('util.favorite')} ${t(tool.nameKey)}`"
                :aria-pressed="isFav(tool)"
                @click="toggleFav(tool)"
              >
                <AppIcon name="star" :size="14" />
              </button>
            </article>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.util {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: var(--useful-space-4) var(--useful-space-5);
  overflow: hidden;
}
.util__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--useful-space-3);
  margin-bottom: var(--useful-space-3);
}
.util__title {
  font-size: var(--useful-text-xl);
  font-weight: 700;
  margin: 0;
}
.util__subtitle {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
  margin: 4px 0 0;
}
.util__search {
  max-width: 280px;
}
.util__scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.util__group {
  margin-bottom: var(--useful-space-4);
}
.util__cat {
  font-size: var(--useful-text-sm);
  color: var(--useful-text-tertiary);
  font-weight: 600;
  margin: 0 0 var(--useful-space-2);
}
.util__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: var(--useful-space-3);
}
.tool-card {
  display: flex;
  align-items: flex-start;
  gap: var(--useful-space-3);
  padding: 0;
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-lg);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: border-color var(--useful-transition), background var(--useful-transition);
}
.tool-card__main {
  display: flex;
  align-items: flex-start;
  gap: var(--useful-space-3);
  width: 100%;
  min-height: 76px;
  padding: var(--useful-space-3) 44px var(--useful-space-3) var(--useful-space-3);
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tool-card:hover {
  border-color: var(--useful-accent);
  background: var(--useful-bg-hover);
}
.tool-card__icon {
  color: var(--useful-accent);
  flex-shrink: 0;
  margin-top: 2px;
}
.tool-card__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tool-card__name {
  font-weight: 600;
  color: var(--useful-text);
}
.tool-card__desc {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.util__bar {
  display: flex;
  align-items: center;
  gap: var(--useful-space-3);
  margin-bottom: var(--useful-space-3);
}
.util__crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
}
.util__tool {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.util__empty {
  color: var(--useful-text-tertiary);
  text-align: center;
  padding: var(--useful-space-6);
}
.util__notfound {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--useful-space-3);
  padding: var(--useful-space-8) var(--useful-space-4);
  text-align: center;
}
.util__notfound h2 {
  font-size: var(--useful-text-lg);
  margin: 0;
}
.util__notfound p {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
  margin: 0;
}
.util__fav-btn {
  margin-left: auto;
  color: var(--useful-text-tertiary);
}
.util__fav-btn--active {
  color: var(--useful-accent);
}
.util__shortcut-btn {
  color: var(--useful-text-tertiary);
}
.tool-card__fav {
  position: absolute;
  top: 8px;
  right: 8px;
  color: var(--useful-text-tertiary);
  opacity: 0;
  min-width: 36px;
  min-height: 36px;
  transition: opacity var(--useful-transition);
}
.tool-card:hover .tool-card__fav {
  opacity: 1;
}
.tool-card:focus-within .tool-card__fav,
.tool-card__fav:focus-visible {
  opacity: 1;
}
.tool-card__fav--active {
  color: var(--useful-accent);
  opacity: 1;
}
.tool-card {
  position: relative;
}
.util__group--fav {
  margin-bottom: var(--useful-space-4);
  padding-bottom: var(--useful-space-3);
  border-bottom: 1px solid var(--useful-border);
}
</style>
