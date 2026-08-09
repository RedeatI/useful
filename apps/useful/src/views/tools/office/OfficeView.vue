<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import { t } from "@/i18n";
import { findOfficeTool, OFFICE_TOOLS, type OfficeToolDefinition } from "@/lib/officeRegistry";
import { useAppStore } from "@/stores/app";

const props = defineProps<{ id?: string }>();
const router = useRouter();
const appStore = useAppStore();
const current = computed(() => props.id ? findOfficeTool(props.id) : undefined);
const notFound = computed(() => Boolean(props.id && !current.value));
const lastRecordedAction = ref<string | null>(null);

function actionId(tool: OfficeToolDefinition): string {
  return `builtin.office.${tool.id}`;
}

function record(tool: OfficeToolDefinition): void {
  const id = actionId(tool);
  if (lastRecordedAction.value === id) return;
  lastRecordedAction.value = id;
  void appStore.recordActionUse(id).catch(() => undefined);
}

watch(current, (tool) => {
  if (tool) record(tool);
  else lastRecordedAction.value = null;
}, { immediate: true });

function open(tool: OfficeToolDefinition): void {
  record(tool);
  void router.push(tool.route);
}

function toggleFavorite(tool: OfficeToolDefinition): void {
  void appStore.toggleActionFav(actionId(tool));
}

function favoriteLabel(tool: OfficeToolDefinition): string {
  const key = appStore.isActionFavorite(actionId(tool)) ? "library.unfavorite" : "library.favorite";
  return t(key, { name: t(tool.nameKey) });
}

function back(): void {
  void router.push("/tools/office");
}
</script>

<template>
  <div class="office-view" data-testid="office-view">
    <template v-if="notFound">
      <section class="office-view__state" role="alert">
        <AppIcon name="alert" :size="30" />
        <h1>{{ t("office.view.notFoundTitle") }}</h1>
        <p>{{ t("office.view.unknownId", { id: props.id ?? "" }) }}</p>
        <button class="useful-btn useful-btn--primary" type="button" @click="back">{{ t("office.view.backToTools") }}</button>
      </section>
    </template>

    <template v-else-if="current">
      <nav class="office-view__bar" :aria-label="t('office.view.navigationLabel')">
        <button class="useful-btn useful-btn--ghost" type="button" @click="back">
          <AppIcon name="chevronLeft" :size="16" /> {{ t("office.view.back") }}
        </button>
        <span><AppIcon name="office" :size="16" /> {{ t("tools.office.name") }} / {{ t(current.nameKey) }}</span>
      </nav>
      <component :is="current.component" />
    </template>

    <template v-else>
      <header class="office-view__head">
        <div>
          <h1>{{ t("tools.office.name") }}</h1>
          <p>{{ t("office.view.subtitle") }}</p>
        </div>
        <span class="useful-badge useful-badge--ok">{{ t("office.view.localOnly") }}</span>
      </header>
      <div class="office-view__grid">
        <article
          v-for="tool in OFFICE_TOOLS"
          :key="tool.id"
          class="office-card"
          :data-tool-id="tool.id"
        >
          <button class="office-card__open" type="button" @click="open(tool)">
            <span class="office-card__icon"><AppIcon :name="tool.icon" :size="24" /></span>
            <span>
              <strong>{{ t(tool.nameKey) }}</strong>
              <small>{{ t(tool.descKey) }}</small>
            </span>
          </button>
          <button
            class="office-card__favorite"
            :class="{ 'office-card__favorite--active': appStore.isActionFavorite(actionId(tool)) }"
            type="button"
            :aria-label="favoriteLabel(tool)"
            :aria-pressed="appStore.isActionFavorite(actionId(tool))"
            @click="toggleFavorite(tool)"
          >
            <AppIcon name="star" :size="18" />
          </button>
        </article>
      </div>
    </template>
  </div>
</template>

<style scoped>
.office-view { height: 100%; overflow: auto; padding: var(--useful-space-4) var(--useful-space-5); }
.office-view__head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--useful-space-4); margin-bottom: var(--useful-space-4); }
.office-view__head h1, .office-view__state h1 { margin: 0; }
.office-view__head p, .office-view__state p { color: var(--useful-text-secondary); margin: var(--useful-space-1) 0 0; }
.office-view__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--useful-space-3); }
.office-card { position: relative; min-height: 100px; border: 1px solid var(--useful-border); border-radius: var(--useful-radius-lg); background: var(--useful-bg-layer); overflow: hidden; }
.office-card:hover, .office-card:focus-within { border-color: var(--useful-accent); background: var(--useful-bg-hover); }
.office-card__open { display: flex; align-items: flex-start; gap: var(--useful-space-3); width: 100%; min-height: 100px; padding: var(--useful-space-4); padding-right: 56px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.office-card__favorite { position: absolute; top: var(--useful-space-3); right: var(--useful-space-3); display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: var(--useful-radius-md); background: transparent; color: var(--useful-text-tertiary); cursor: pointer; }
.office-card__favorite:hover, .office-card__favorite:focus-visible, .office-card__favorite--active { background: var(--useful-bg-layer); color: var(--useful-accent); }
.office-card__icon { color: var(--useful-accent); flex: none; }
.office-card strong, .office-card small { display: block; }
.office-card small { color: var(--useful-text-secondary); margin-top: var(--useful-space-1); line-height: 1.45; }
.office-view__bar { display: flex; align-items: center; gap: var(--useful-space-3); margin-bottom: var(--useful-space-4); color: var(--useful-text-secondary); }
.office-view__bar span { display: inline-flex; align-items: center; gap: var(--useful-space-2); }
.office-view__state { display: flex; flex-direction: column; align-items: center; gap: var(--useful-space-3); padding: var(--useful-space-8); text-align: center; }
</style>
