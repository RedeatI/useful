<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { BUILTIN_ACTION_DESCRIPTORS, suggestActions } from "@useful/action-runtime/browser";
import AppIcon from "@/components/AppIcon.vue";
import { t } from "@/i18n";
import {
  buildLibraryItems,
  filterLibraryItems,
  type LibraryFilter,
  type LibraryFunctionalCategory,
  type LibraryItem,
  type LibrarySort,
} from "@/lib/toolLibrary";
import { useAppStore } from "@/stores/app";

const appStore = useAppStore();
const router = useRouter();
const query = ref("");
const sample = ref("");
const activeFilter = ref<LibraryFilter>("all");
const activeCategory = ref<LibraryFunctionalCategory>("all");
const activeSort = ref<LibrarySort>("recommended");
const filters: Array<{ id: LibraryFilter; labelKey: string }> = [
  { id: "all", labelKey: "library.filterAll" },
  { id: "gui", labelKey: "library.filterGui" },
  { id: "agent", labelKey: "library.filterAgent" },
  { id: "installed", labelKey: "library.filterInstalled" },
  { id: "favorites", labelKey: "library.filterFavorites" },
];
const categories: LibraryFunctionalCategory[] = ["all", "encode", "convert", "text", "generate", "web", "office", "media", "system", "plugin", "other"];
const sorts: LibrarySort[] = ["recommended", "name", "category", "source"];

const items = computed(() => buildLibraryItems({
  tools: appStore.tools,
  toolFavorites: appStore.favorites,
  actionFavorites: appStore.actionFavorites,
  pins: appStore.navigationPins,
}));
const visible = computed(() => filterLibraryItems(
  items.value,
  activeFilter.value,
  query.value,
  t,
  activeCategory.value,
  activeSort.value,
));
const itemById = computed(() => new Map(items.value.map((item) => [item.id, item])));
const smartSampleTooLarge = computed(() => new TextEncoder().encode(sample.value).byteLength > 65536);
const smartSuggestions = computed(() => {
  if (!sample.value.trim() || smartSampleTooLarge.value) return [];
  return suggestActions([...BUILTIN_ACTION_DESCRIPTORS], sample.value, { limit: 5 }).suggestions
    .flatMap((suggestion) => {
      const item = itemById.value.get(suggestion.actionId);
      return item ? [{ suggestion, item }] : [];
    });
});

const label = (item: LibraryItem): string => item.translated ? t(item.name) : item.name;
const description = (item: LibraryItem): string => item.translated ? t(item.description) : item.description;
const sourceLabel = (item: LibraryItem): string => t(item.source === "builtin" ? "library.sourceBuiltin" : "library.sourcePlugin");
const publisherLabel = (item: LibraryItem): string => item.publisherId
  ? t("library.publisher", { publisher: item.publisherId })
  : t(item.source === "plugin" ? "library.publisherRuntime" : "library.publisherUndeclared");
const categoryLabel = (category: LibraryFunctionalCategory): string => t(`library.category.${category}`);
const sortLabel = (sort: LibrarySort): string => t(`library.sort.${sort}`);

async function openItem(item: LibraryItem): Promise<void> {
  if (item.kind === "tool") await appStore.recordUse(item.id);
  await router.push(item.route);
}

async function toggleFavorite(item: LibraryItem): Promise<void> {
  if (item.kind === "action") await appStore.toggleActionFav(item.id);
  else await appStore.toggleFavorite(item.id);
}

async function configureAgent(item: LibraryItem): Promise<void> {
  await router.push({ path: "/settings", query: { section: "agent", action: item.id } });
}
</script>

<template>
  <div class="useful-page library" data-testid="tool-library">
    <header class="library__head">
      <div>
        <h1 class="useful-page__title">{{ t("library.title") }}</h1>
        <p class="library__subtitle">{{ t("library.subtitle") }}</p>
      </div>
      <label class="library__search-label">
        <span class="sr-only">{{ t("library.searchLabel") }}</span>
        <AppIcon name="search" :size="18" />
        <input v-model="query" class="useful-input library__search" :placeholder="t('library.searchPlaceholder')" />
      </label>
    </header>

    <section class="useful-card library__smart" aria-labelledby="library-smart-title">
      <div class="library__smart-copy">
        <h2 id="library-smart-title">{{ t("library.smartTitle") }}</h2>
        <p>{{ t("library.smartDescription") }}</p>
        <p class="library__smart-privacy">{{ t("library.smartPrivacy") }}</p>
      </div>
      <div class="library__smart-input">
        <label for="library-smart-sample">{{ t("library.smartInputLabel") }}</label>
        <textarea
          id="library-smart-sample"
          v-model="sample"
          class="useful-input useful-mono"
          :maxlength="65536"
          :placeholder="t('library.smartPlaceholder')"
          spellcheck="false"
        />
        <button v-if="sample" class="useful-btn" @click="sample = ''">{{ t("common.clear") }}</button>
      </div>
      <div v-if="smartSuggestions.length" class="library__smart-results" :aria-label="t('library.smartResults')">
        <button
          v-for="entry in smartSuggestions"
          :key="entry.item.id"
          class="library__smart-result"
          @click="openItem(entry.item)"
        >
          <AppIcon :name="entry.item.icon" :size="18" />
          <span>{{ label(entry.item) }}</span>
          <span class="useful-badge">{{ t(`library.smartConfidence.${entry.suggestion.confidence}`) }}</span>
        </button>
      </div>
      <p v-else-if="smartSampleTooLarge" class="library__smart-empty" role="alert">{{ t("library.smartTooLarge") }}</p>
      <p v-else-if="sample.trim()" class="library__smart-empty">{{ t("library.smartEmpty") }}</p>
    </section>

    <div class="library__filters" role="group" :aria-label="t('library.filterGroup')">
      <button
        v-for="filter in filters"
        :key="filter.id"
        class="useful-btn library__filter"
        :class="{ 'library__filter--active': activeFilter === filter.id }"
        :aria-pressed="activeFilter === filter.id"
        @click="activeFilter = filter.id"
      >
        {{ t(filter.labelKey) }}
      </button>
      <label class="library__select-label">
        <span>{{ t("library.categoryLabel") }}</span>
        <select v-model="activeCategory" class="useful-input" data-testid="library-category">
          <option v-for="category in categories" :key="category" :value="category">{{ categoryLabel(category) }}</option>
        </select>
      </label>
      <label class="library__select-label">
        <span>{{ t("library.sortLabel") }}</span>
        <select v-model="activeSort" class="useful-input" data-testid="library-sort">
          <option v-for="sort in sorts" :key="sort" :value="sort">{{ sortLabel(sort) }}</option>
        </select>
      </label>
    </div>

    <p class="library__count" role="status">{{ t("library.itemCount", { count: visible.length }) }}</p>
    <div v-if="visible.length" class="library__grid">
      <article v-for="item in visible" :key="item.id" class="useful-card library-card">
        <div class="library-card__top">
          <span class="library-card__icon"><AppIcon :name="item.icon" :size="22" /></span>
          <div class="library-card__identity">
            <h2>{{ label(item) }}</h2>
            <code class="useful-mono">{{ item.id }}</code>
          </div>
          <button
            class="useful-icon-btn"
            :aria-label="t(item.favorite ? 'library.unfavorite' : 'library.favorite', { name: label(item) })"
            :aria-pressed="item.favorite"
            @click="toggleFavorite(item)"
          >
            <AppIcon name="star" :size="17" />
          </button>
        </div>
        <p class="library-card__desc">{{ description(item) }}</p>
        <div class="library-card__badges" :aria-label="t('library.attributes')">
          <span class="useful-badge">{{ categoryLabel(item.functionalCategory) }}</span>
          <span class="useful-badge">{{ sourceLabel(item) }}</span>
          <span class="useful-badge">{{ publisherLabel(item) }}</span>
          <span v-for="surface in item.surfaces" :key="surface" class="useful-badge">{{ surface.toUpperCase() }}</span>
          <span v-if="item.readOnly" class="useful-badge useful-badge--ok">{{ t("library.readOnly") }}</span>
          <span v-if="item.permissions.length" class="useful-badge useful-badge--warning">{{ t("library.permissionCount", { count: item.permissions.length }) }}</span>
          <span v-else class="useful-badge">{{ t("library.zeroPermissions") }}</span>
        </div>
        <p v-if="item.agentResolution === 'runtime-required'" class="library-card__notice">
          {{ t("library.runtimeNotice") }}
        </p>
        <div class="library-card__actions">
          <button class="useful-btn useful-btn--primary" @click="openItem(item)">{{ t("library.openGui") }}</button>
          <button class="useful-btn" :aria-pressed="item.pinned" @click="appStore.setPinned(item.id, !item.pinned)">
            {{ t(item.pinned ? "library.unpin" : "library.pin") }}
          </button>
          <button v-if="item.agentConfigurable" class="useful-btn" @click="configureAgent(item)">{{ t("library.agentConfig") }}</button>
        </div>
      </article>
    </div>
    <p v-else class="library__empty">{{ t("library.empty") }}</p>
  </div>
</template>

<style scoped>
.library { overflow: auto; }
.library__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--useful-space-4); }
.library__subtitle { color: var(--useful-text-secondary); margin: var(--useful-space-1) 0 0; }
.library__search-label { display: flex; align-items: center; gap: var(--useful-space-2); min-width: min(360px, 42%); }
.library__search { width: 100%; }
.library__smart { display: grid; grid-template-columns: minmax(220px, .8fr) minmax(280px, 1fr) minmax(240px, 1fr); gap: var(--useful-space-4); margin-top: var(--useful-space-4); padding: var(--useful-space-4); }
.library__smart h2 { margin: 0 0 var(--useful-space-2); font-size: var(--useful-text-lg); }
.library__smart-copy p { margin: 0 0 var(--useful-space-2); color: var(--useful-text-secondary); }
.library__smart-copy .library__smart-privacy { color: var(--useful-text-tertiary); font-size: var(--useful-text-xs); }
.library__smart-input { display: flex; flex-direction: column; gap: var(--useful-space-2); color: var(--useful-text-secondary); font-size: var(--useful-text-sm); }
.library__smart-input textarea { min-height: 112px; resize: vertical; }
.library__smart-input .useful-btn { align-self: flex-end; }
.library__smart-results { display: flex; flex-direction: column; gap: var(--useful-space-2); }
.library__smart-result { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--useful-space-2); width: 100%; padding: var(--useful-space-2) var(--useful-space-3); color: var(--useful-text-primary); text-align: left; background: var(--useful-bg-layer); border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); cursor: pointer; }
.library__smart-result:hover { border-color: var(--useful-accent); }
.library__smart-empty { align-self: center; color: var(--useful-text-tertiary); }
.library__filters { display: flex; flex-wrap: wrap; gap: var(--useful-space-2); margin: var(--useful-space-4) 0 var(--useful-space-2); }
.library__select-label { display: inline-flex; align-items: center; gap: var(--useful-space-2); color: var(--useful-text-secondary); font-size: var(--useful-text-sm); }
.library__select-label:first-of-type { margin-left: auto; }
.library__filter--active { background: var(--useful-bg-selected); color: var(--useful-accent); border-color: var(--useful-accent); }
.library__count { color: var(--useful-text-tertiary); font-size: var(--useful-text-sm); }
.library__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--useful-space-3); padding-bottom: var(--useful-space-5); }
.library-card { padding: var(--useful-space-4); display: flex; flex-direction: column; gap: var(--useful-space-3); min-width: 0; }
.library-card__top { display: flex; align-items: flex-start; gap: var(--useful-space-3); }
.library-card__icon { color: var(--useful-accent); padding-top: 2px; }
.library-card__identity { min-width: 0; flex: 1; }
.library-card__identity h2 { font-size: var(--useful-text-md); margin: 0 0 3px; }
.library-card__identity code { color: var(--useful-text-tertiary); font-size: var(--useful-text-xs); overflow-wrap: anywhere; }
.library-card__desc { color: var(--useful-text-secondary); margin: 0; min-height: 2.6em; }
.library-card__badges, .library-card__actions { display: flex; flex-wrap: wrap; gap: var(--useful-space-2); }
.library-card__notice { color: var(--useful-warning); font-size: var(--useful-text-xs); margin: 0; }
.library-card__actions { margin-top: auto; }
.library__empty { padding: var(--useful-space-6); text-align: center; color: var(--useful-text-tertiary); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 1100px) {
  .library__head { flex-direction: column; }
  .library__search-label { min-width: 0; width: 100%; }
  .library__smart { grid-template-columns: 1fr; }
  .library__grid { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
}
</style>
