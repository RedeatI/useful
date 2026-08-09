<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useAppStore } from "@/stores/app";
import { useUiStore } from "@/stores/ui";
import { t } from "@/i18n";
import ToolCard from "@/components/ToolCard.vue";
import AppIcon from "@/components/AppIcon.vue";
import StateBlock from "@/components/StateBlock.vue";
import { actionRoute } from "@/lib/actionCatalog";

const appStore = useAppStore();
const uiStore = useUiStore();
const router = useRouter();

const modeLabel = computed(() =>
  appStore.appInfo?.runMode === "portable"
    ? t("home.portableMode")
    : t("home.installedMode"),
);

function openAction(actionId: string): void {
  const route = actionRoute(actionId);
  if (!route) return;
  void router.push(route);
}
</script>

<template>
  <div class="useful-page" :class="{ 'home--compact': uiStore.navigationLayout.density === 'compact' }">
    <div class="home-hero">
      <h1 class="useful-page__title">{{ t("home.welcome") }}</h1>
      <p class="home-hero__tagline">{{ t("app.tagline") }}</p>
      <div class="home-hero__badges">
        <span class="useful-badge useful-badge--accent">{{ modeLabel }}</span>
        <span v-if="appStore.appInfo" class="useful-badge">
          {{ t("common.version") }} {{ appStore.appInfo.version }}
        </span>
      </div>
    </div>

    <StateBlock v-if="appStore.loading" variant="loading" />
    <StateBlock
      v-else-if="appStore.error"
      variant="error"
      :hint="appStore.error"
      retryable
      @retry="appStore.loadAll()"
    />
    <template v-else>
      <section v-for="section in uiStore.visibleHomeSections" :key="section.id" :data-home-section="section.id">
        <template v-if="section.id === 'recent' && appStore.recentActions.length">
          <h2 class="useful-section__title"><AppIcon name="clock" :size="16" /> {{ t("home.recent") }}</h2>
          <div class="useful-grid useful-grid--actions">
            <button v-for="action in appStore.recentActions" :key="action.id" class="action-card" @click="openAction(action.id)">
              <span class="action-card__icon"><AppIcon :name="action.icon" :size="20" /></span>
              <span class="action-card__label">{{ t(action.nameKey) }}</span>
            </button>
          </div>
        </template>

        <template v-else-if="section.id === 'favorites' && (appStore.favoriteActions.length || appStore.favoriteTools.length)">
          <h2 class="useful-section__title"><AppIcon name="star" :size="16" /> {{ t("home.favorites") }}</h2>
          <div v-if="appStore.favoriteActions.length" class="useful-grid useful-grid--actions">
            <button v-for="action in appStore.favoriteActions" :key="action.id" class="action-card" @click="openAction(action.id)">
              <span class="action-card__icon"><AppIcon :name="action.icon" :size="20" /></span>
              <span class="action-card__label">{{ t(action.nameKey) }}</span>
            </button>
          </div>
          <div v-if="appStore.favoriteTools.length" class="useful-grid">
            <ToolCard v-for="tool in appStore.favoriteTools" :key="tool.id" :tool="tool" />
          </div>
        </template>

        <template v-else-if="section.id === 'builtin'">
          <h2 class="useful-section__title">{{ t("home.builtinTools") }}</h2>
          <div class="useful-grid">
            <ToolCard v-for="tool in appStore.builtinTools" :key="tool.id" :tool="tool" />
          </div>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.home-hero {
  margin-bottom: var(--useful-space-4);
}
.home-hero__tagline {
  color: var(--useful-text-secondary);
  margin: calc(-1 * var(--useful-space-2)) 0 var(--useful-space-3);
}
.home-hero__badges {
  display: flex;
  gap: var(--useful-space-2);
}
.home-empty {
  color: var(--useful-text-tertiary);
  font-size: var(--useful-text-sm);
  padding: var(--useful-space-2) 0;
}
.useful-grid--actions {
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--useful-space-2);
  margin-bottom: var(--useful-space-4);
}
.action-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--useful-space-2);
  padding: var(--useful-space-3);
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-lg);
  cursor: pointer;
  font-family: inherit;
  text-align: center;
  transition: border-color var(--useful-transition), background var(--useful-transition);
}
.home--compact .useful-grid--actions { grid-template-columns: repeat(auto-fill, minmax(116px, 1fr)); }
.home--compact .action-card { padding: var(--useful-space-2); }
.action-card:hover {
  border-color: var(--useful-accent);
  background: var(--useful-bg-hover);
}
.action-card__icon {
  color: var(--useful-accent);
}
.action-card__label {
  font-size: var(--useful-text-sm);
  font-weight: 600;
  color: var(--useful-text);
}
</style>
