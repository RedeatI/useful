<script setup lang="ts">
import { computed, defineAsyncComponent, defineComponent, onErrorCaptured, onMounted, ref } from "vue";
import { useUiStore } from "@/stores/ui";
import { useAppStore } from "@/stores/app";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import { formatBytes } from "@/lib/format";
import type { AppUpdateSourceInfo, DiagEntry } from "@/lib/types";
import type { HomeSectionId, NavigationItemId } from "@/lib/types";
import PerfPanel from "@/components/PerfPanel.vue";

const uiStore = useUiStore();
const appStore = useAppStore();
const pageError = ref<string | null>(null);
const agentPanelError = ref<string | null>(null);
const agentConnectionPanelError = ref<string | null>(null);

const PanelErrorBoundary = defineComponent({
  name: "PanelErrorBoundary",
  emits: { error: (message: string) => typeof message === "string" },
  setup(_props, { emit, slots }) {
    onErrorCaptured((error) => {
      emit("error", error instanceof Error ? error.message : String(error));
      return false;
    });
    return () => slots.default?.();
  },
});

// 异步加载 Agent 面板，避免依赖包加载失败时整页设置无法打开。
const AgentProfilePanel = defineAsyncComponent({
  loader: () => import("@/components/AgentProfilePanel.vue"),
  suspensible: false,
  onError(error, _retry, fail) {
    console.error("AgentProfilePanel failed to load", error);
    agentPanelError.value = error instanceof Error ? error.message : String(error);
    fail();
  },
});

const AgentConnectionPanel = defineAsyncComponent({
  loader: () => import("@/components/AgentConnectionPanel.vue"),
  suspensible: false,
  onError(error, _retry, fail) {
    console.error("AgentConnectionPanel failed to load", error);
    agentConnectionPanelError.value = error instanceof Error ? error.message : String(error);
    fail();
  },
});

onErrorCaptured((err, _instance, info) => {
  // 其他子树出错时仍保留设置页骨架；Agent 两个异步面板各有自己的边界。
  const message = err instanceof Error ? err.message : String(err);
  pageError.value = message;
  console.error("SettingsView captured error", err, info);
  return false;
});

const info = computed(() => appStore.appInfo);
const diagEntries = ref<DiagEntry[] | null>(null);
const diagMessage = ref<string | null>(null);
const diagError = ref<string | null>(null);
const themes = [
  { value: "system", label: "settings.themeSystem" },
  { value: "light", label: "settings.themeLight" },
  { value: "dark", label: "settings.themeDark" },
] as const;

onMounted(() => {
  if (typeof window === "undefined") return;
  if (window.location.hash === "#navigation-layout") {
    document.getElementById("navigation-layout")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

const languages = [
  { value: "zh-CN", label: "settings.languageZh" },
  { value: "en-US", label: "settings.languageEn" },
] as const;
const navLabelKeys: Record<NavigationItemId, string> = {
  home: "nav.home",
  library: "nav.library",
  shop: "nav.toolShop",
  downloads: "nav.downloads",
  settings: "nav.settings",
};
const homeLabelKeys: Record<HomeSectionId, string> = {
  recent: "settings.homeSectionRecent",
  favorites: "settings.homeSectionFavorites",
  builtin: "settings.homeSectionBuiltin",
};
const orderedNav = computed(() => [...uiStore.navigationLayout.nav].sort((a, b) => a.order - b.order));
const orderedHome = computed(() => [...uiStore.navigationLayout.home].sort((a, b) => a.order - b.order));

async function openDataDir(): Promise<void> {
  if (info.value) await ipc.openPath(info.value.dataDir);
}
async function openLogsDir(): Promise<void> {
  if (info.value) await ipc.openPath(info.value.logsDir);
}

// 诊断包：先预览内容，确认后选择保存位置导出
async function previewDiagnostics(): Promise<void> {
  diagMessage.value = null;
  diagError.value = null;
  try {
    diagEntries.value = await ipc.diagnosticsPreview();
  } catch (e) {
    diagError.value = String(e);
  }
}

async function exportDiagnostics(): Promise<void> {
  diagMessage.value = null;
  diagError.value = null;
  try {
    // 动态导入，避免顶层 plugin-dialog 在部分环境下拖垮整个设置页模块加载。
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      defaultPath: "useful-beta-feedback.zip",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!dest) return;
    const path = await ipc.diagnosticsExport(dest);
    diagMessage.value = t("settings.diagExported", { path });
    diagEntries.value = null;
  } catch (e) {
    diagError.value = String(e);
  }
}

// Phase 10：客户端更新源（独立信任域）。更换=更换服务提供商/自托管，需单独警告确认。
const updateSource = ref<AppUpdateSourceInfo | null>(null);
const updateSourceError = ref<string | null>(null);
const replacing = ref(false);
const replaceFeedUrl = ref("");
const replaceRootKey = ref("");
const replaceWarningAck = ref(false);

async function loadUpdateSource(): Promise<void> {
  try {
    updateSource.value = await ipc.appUpdateSourceGet();
  } catch (e) {
    updateSourceError.value = String(e);
  }
}

async function applyCustomUpdateSource(): Promise<void> {
  updateSourceError.value = null;
  try {
    updateSource.value = await ipc.appUpdateSourceSetCustom(
      replaceFeedUrl.value.trim(),
      replaceRootKey.value.trim(),
      replaceWarningAck.value,
    );
    replacing.value = false;
  } catch (e) {
    updateSourceError.value = String(e);
  }
}

async function resetOfficialUpdateSource(): Promise<void> {
  updateSourceError.value = null;
  try {
    updateSource.value = await ipc.appUpdateSourceResetOfficial();
    replacing.value = false;
  } catch (e) {
    updateSourceError.value = String(e);
  }
}

async function setUpdateChannel(channel: "stable" | "beta" | "nightly"): Promise<void> {
  updateSourceError.value = null;
  try {
    updateSource.value = await ipc.appUpdateChannelSet(channel);
  } catch (e) {
    updateSourceError.value = String(e);
  }
}

onMounted(loadUpdateSource);
</script>

<template>
  <div class="useful-page" data-testid="settings-page">
    <h1 class="useful-page__title">{{ t("settings.title") }}</h1>
    <p v-if="pageError" class="diag-err" role="alert">{{ pageError }}</p>

    <!-- 外观 -->
    <section class="useful-card settings-section">
      <h2 class="settings-section__title">{{ t("settings.appearance") }}</h2>
      <div class="settings-row">
        <label class="settings-row__label">{{ t("settings.theme") }}</label>
        <div class="settings-row__control seg" role="group" :aria-label="t('settings.themeGroupLabel')">
          <button
            v-for="th in themes"
            :key="th.value"
            class="seg__btn"
            :class="{ 'seg__btn--active': uiStore.theme === th.value }"
            :aria-pressed="uiStore.theme === th.value"
            @click="uiStore.setTheme(th.value)"
          >
            {{ t(th.label) }}
          </button>
        </div>
      </div>
      <div class="settings-row">
        <label class="settings-row__label">{{ t("settings.language") }}</label>
        <div class="settings-row__control">
          <select
            class="useful-select"
            :value="uiStore.language"
            @change="uiStore.setLanguage(($event.target as HTMLSelectElement).value as 'zh-CN' | 'en-US')"
          >
            <option v-for="locale in languages" :key="locale.value" :value="locale.value">{{ t(locale.label) }}</option>
          </select>
        </div>
      </div>
    </section>

    <section id="navigation-layout" class="useful-card settings-section" data-testid="navigation-layout-settings">
      <h2 class="settings-section__title">{{ t("settings.navigationLayout") }}</h2>
      <p class="settings-row__hint">{{ t("settings.navigationLayoutHint") }}</p>
      <div class="settings-row">
        <span class="settings-row__label">{{ t("settings.density") }}</span>
        <div class="settings-row__control seg" role="group" :aria-label="t('settings.density')">
          <button class="seg__btn" :class="{ 'seg__btn--active': uiStore.navigationLayout.density === 'comfortable' }" :aria-pressed="uiStore.navigationLayout.density === 'comfortable'" @click="uiStore.setNavigationDensity('comfortable')">
            {{ t("settings.densityComfortable") }}
          </button>
          <button class="seg__btn" :class="{ 'seg__btn--active': uiStore.navigationLayout.density === 'compact' }" :aria-pressed="uiStore.navigationLayout.density === 'compact'" @click="uiStore.setNavigationDensity('compact')">
            {{ t("settings.densityCompact") }}
          </button>
        </div>
      </div>
      <h3 class="layout-heading">{{ t("settings.navigationItems") }}</h3>
      <ol class="layout-list">
        <li v-for="(item, index) in orderedNav" :key="item.id" class="layout-item">
          <label class="layout-item__visibility">
            <input type="checkbox" :checked="item.visible" :disabled="item.id === 'settings'" @change="uiStore.setLayoutItemVisible('nav', item.id, ($event.target as HTMLInputElement).checked)" />
            <span>{{ t(navLabelKeys[item.id]) }}</span>
          </label>
          <span v-if="item.id === 'settings'" class="layout-item__note">{{ t("settings.alwaysVisible") }}</span>
          <div class="layout-item__actions">
            <button class="useful-icon-btn" :disabled="index === 0" :aria-label="t('settings.moveUp', { item: t(navLabelKeys[item.id]) })" @click="uiStore.moveLayoutItem('nav', item.id, -1)">↑</button>
            <button class="useful-icon-btn" :disabled="index === orderedNav.length - 1" :aria-label="t('settings.moveDown', { item: t(navLabelKeys[item.id]) })" @click="uiStore.moveLayoutItem('nav', item.id, 1)">↓</button>
          </div>
        </li>
      </ol>
      <h3 class="layout-heading">{{ t("settings.homeSections") }}</h3>
      <ol class="layout-list">
        <li v-for="(item, index) in orderedHome" :key="item.id" class="layout-item">
          <label class="layout-item__visibility">
            <input type="checkbox" :checked="item.visible" @change="uiStore.setLayoutItemVisible('home', item.id, ($event.target as HTMLInputElement).checked)" />
            <span>{{ t(homeLabelKeys[item.id]) }}</span>
          </label>
          <div class="layout-item__actions">
            <button class="useful-icon-btn" :disabled="index === 0" :aria-label="t('settings.moveUp', { item: t(homeLabelKeys[item.id]) })" @click="uiStore.moveLayoutItem('home', item.id, -1)">↑</button>
            <button class="useful-icon-btn" :disabled="index === orderedHome.length - 1" :aria-label="t('settings.moveDown', { item: t(homeLabelKeys[item.id]) })" @click="uiStore.moveLayoutItem('home', item.id, 1)">↓</button>
          </div>
        </li>
      </ol>
      <button class="useful-btn" @click="uiStore.resetNavigationLayout()">{{ t("settings.resetLayout") }}</button>
    </section>

    <section id="agent-settings" class="useful-card settings-section">
      <p v-if="agentPanelError" class="diag-err" role="alert">
        {{ t("settings.agentPanelFailed", { err: agentPanelError }) }}
      </p>
      <PanelErrorBoundary v-else @error="agentPanelError = $event">
        <AgentProfilePanel />
      </PanelErrorBoundary>
    </section>

    <section id="agent-connections" class="useful-card settings-section" data-testid="agent-connections-settings">
      <p v-if="agentConnectionPanelError" class="diag-err" role="alert">
        {{ t("settings.agentConnectionPanelFailed", { err: agentConnectionPanelError }) }}
      </p>
      <PanelErrorBoundary v-else @error="agentConnectionPanelError = $event">
        <AgentConnectionPanel />
      </PanelErrorBoundary>
    </section>

    <section class="useful-card settings-section">
      <h2 class="settings-section__title">{{ t("settings.sourceManagement") }}</h2>
      <div class="settings-row">
        <div>
          <span class="settings-row__label">{{ t("settings.trustedSources") }}</span>
          <p class="settings-row__hint">{{ t("settings.trustedSourcesHint") }}</p>
        </div>
        <router-link class="useful-btn" to="/sources">{{ t("settings.openSourceCenter") }}</router-link>
      </div>
    </section>

    <!-- 常规 -->
    <section class="useful-card settings-section">
      <h2 class="settings-section__title">{{ t("settings.general") }}</h2>
      <div class="settings-row">
        <div>
          <label class="settings-row__label">{{ t("settings.developerMode") }}</label>
          <p class="settings-row__hint">{{ t("settings.developerModeHint") }}</p>
        </div>
        <div class="settings-row__control">
          <button
            class="switch"
            :class="{ 'switch--on': uiStore.developerMode }"
            role="switch"
            :aria-checked="uiStore.developerMode"
            @click="uiStore.developerMode = !uiStore.developerMode"
          >
            <span class="switch__thumb" />
          </button>
        </div>
      </div>
      <div class="settings-row">
        <label class="settings-row__label">{{ t("settings.dataDir") }}</label>
        <div class="settings-row__control settings-row__control--stack">
          <code class="useful-mono settings-path">{{ info?.dataDir ?? "—" }}</code>
          <div class="settings-actions">
            <button class="useful-btn" @click="openDataDir">
              {{ t("settings.openDataDir") }}
            </button>
            <button class="useful-btn" @click="openLogsDir">
              {{ t("settings.openLogsDir") }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 诊断 -->
    <section class="useful-card settings-section">
      <h2 class="settings-section__title">{{ t("settings.diagnostics") }}</h2>
      <div class="settings-row">
        <div>
          <label class="settings-row__label">{{ t("settings.diagExport") }}</label>
          <p class="settings-row__hint">{{ t("settings.diagHint") }}</p>
        </div>
        <div class="settings-row__control">
          <button class="useful-btn" @click="previewDiagnostics">
            {{ t("settings.diagPreview") }}
          </button>
        </div>
      </div>
      <div v-if="diagEntries" class="diag-preview">
        <ul class="diag-preview__list">
          <li v-for="e in diagEntries" :key="e.name" class="useful-mono">
            {{ e.name }} ({{ formatBytes(e.sizeBytes) }})
          </li>
        </ul>
        <div class="settings-actions">
          <button class="useful-btn" @click="diagEntries = null">{{ t("common.cancel") }}</button>
          <button class="useful-btn useful-btn--primary" @click="exportDiagnostics">
            {{ t("settings.diagExport") }}
          </button>
        </div>
      </div>
      <p v-if="diagMessage" class="diag-ok" role="status">{{ diagMessage }}</p>
      <p v-if="diagError" class="diag-err" role="alert">{{ diagError }}</p>
    </section>

    <!-- 客户端更新源（Phase 10：独立信任域，与工具源完全分离） -->
    <section class="useful-card settings-section" data-testid="app-update-source">
      <h2 class="settings-section__title">{{ t("settings.appUpdateSource") }}</h2>
      <p class="settings-row__hint">{{ t("settings.appUpdateSourceHint") }}</p>
      <template v-if="updateSource">
        <div class="settings-row">
          <span class="settings-row__label">{{ t("settings.updateFeedUrl") }}</span>
          <code class="useful-mono settings-path">{{ updateSource.updateFeedUrl }}</code>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">{{ t("settings.updateRootFingerprint") }}</span>
          <code class="useful-mono settings-path">{{ updateSource.rootFingerprint }}</code>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">{{ t("settings.updateSourceStatus") }}</span>
          <span>
            <span
              v-if="updateSource.usingDevelopmentUpdateTrust"
              class="useful-badge useful-badge--warning"
              data-testid="update-development-trust-badge"
            >
              {{ t("settings.updateSourceDevelopment") }}
            </span>
            <span v-else-if="updateSource.isOfficial" class="useful-badge useful-badge--ok" data-testid="update-official-badge">
              {{ t("settings.updateSourceOfficial") }}
            </span>
            <span v-else class="useful-badge useful-badge--warning" data-testid="update-custom-badge">
              {{ t("settings.updateSourceCustom") }}
            </span>
            <span v-if="updateSource.pendingUpdate" class="useful-badge">
              {{ t("settings.updatePending") }}
            </span>
          </span>
        </div>
        <p
          v-if="updateSource.usingDevelopmentUpdateTrust"
          class="update-replace__warning"
          role="alert"
          data-testid="development-update-trust-warning"
        >
          {{ t("settings.updateSourceDevelopmentWarning") }}
        </p>
        <div class="settings-row">
          <div>
            <span class="settings-row__label">{{ t("settings.updateChannel") }}</span>
            <p class="settings-row__hint">{{ t("settings.updateChannelHint") }}</p>
          </div>
          <div class="settings-row__control seg" role="group" :aria-label="t('settings.updateChannelGroupLabel')" data-testid="update-channel">
            <button
              class="seg__btn"
              :class="{ 'seg__btn--active': updateSource.channel === 'stable' }"
              :aria-pressed="updateSource.channel === 'stable'"
              @click="setUpdateChannel('stable')"
            >
              {{ t("settings.updateChannelStable") }}
            </button>
            <button
              class="seg__btn"
              :class="{ 'seg__btn--active': updateSource.channel === 'beta' }"
              :aria-pressed="updateSource.channel === 'beta'"
              @click="setUpdateChannel('beta')"
            >
              {{ t("settings.updateChannelBeta") }}
            </button>
            <button
              class="seg__btn"
              :class="{ 'seg__btn--active': updateSource.channel === 'nightly' }"
              :aria-pressed="updateSource.channel === 'nightly'"
              @click="setUpdateChannel('nightly')"
            >
              {{ t("settings.updateChannelNightly") }}
            </button>
          </div>
        </div>
        <div class="settings-actions">
          <button class="useful-btn" data-testid="replace-update-source" @click="replacing = !replacing">
            {{ t("settings.replaceUpdateSource") }}
          </button>
          <button
            v-if="!updateSource.isDefaultOfficial && !updateSource.usingDevelopmentUpdateTrust"
            class="useful-btn"
            data-testid="reset-official-update-source"
            @click="resetOfficialUpdateSource"
          >
            {{ t("settings.resetOfficialUpdateSource") }}
          </button>
        </div>
        <div v-if="replacing" class="update-replace" data-testid="replace-form">
          <p class="update-replace__warning" role="alert">
            {{ t("settings.replaceUpdateWarning") }}
          </p>
          <input
            v-model="replaceFeedUrl"
            class="useful-input"
            :placeholder="t('settings.updateFeedUrlPlaceholder')"
          />
          <input
            v-model="replaceRootKey"
            class="useful-input useful-mono"
            :placeholder="t('settings.updateRootKeyPlaceholder')"
          />
          <label class="update-replace__ack">
            <input v-model="replaceWarningAck" type="checkbox" data-testid="warning-ack" />
            {{ t("settings.replaceUpdateAck") }}
          </label>
          <div class="settings-actions">
            <button class="useful-btn" @click="replacing = false">{{ t("common.cancel") }}</button>
            <button
              class="useful-btn useful-btn--primary"
              :disabled="!replaceWarningAck"
              data-testid="apply-custom-update-source"
              @click="applyCustomUpdateSource"
            >
              {{ t("common.confirm") }}
            </button>
          </div>
        </div>
      </template>
      <p v-if="updateSourceError" class="diag-err" role="alert">{{ updateSourceError }}</p>
    </section>

    <!-- 关于 -->
    <section class="useful-card settings-section">
      <h2 class="settings-section__title">{{ t("settings.about") }}</h2>
      <div class="settings-row">
        <span class="settings-row__label">{{ t("settings.runMode") }}</span>
        <span class="useful-badge">{{ info?.runMode ?? "—" }}</span>
      </div>
      <div class="settings-row">
        <span class="settings-row__label">{{ t("settings.hostVersion") }}</span>
        <span class="useful-badge">{{ info?.version ?? "—" }}</span>
      </div>
    </section>
    <!-- 开发者性能面板（仅开发者模式） -->
    <PerfPanel v-if="uiStore.developerMode" />
  </div>
</template>

<style scoped>
.update-replace {
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-2);
  padding-top: var(--useful-space-2);
}
.update-replace__warning {
  background: rgba(157, 93, 0, 0.1);
  border-left: 3px solid var(--useful-warning);
  border-radius: var(--useful-radius-sm);
  padding: var(--useful-space-2) var(--useful-space-3);
  font-size: var(--useful-text-sm);
  margin: 0;
}
.update-replace__ack {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  font-size: var(--useful-text-sm);
}
.diag-preview {
  padding: var(--useful-space-2) 0;
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-2);
}
.diag-preview__list {
  margin: 0;
  padding-left: var(--useful-space-4);
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
  max-height: 180px;
  overflow: auto;
}
.diag-ok {
  color: var(--useful-success);
  font-size: var(--useful-text-sm);
  word-break: break-all;
}
.diag-err {
  color: var(--useful-danger);
  font-size: var(--useful-text-sm);
}
.settings-section {
  margin-bottom: var(--useful-space-4);
  max-width: 760px;
}
.settings-section__title {
  font-size: var(--useful-text-lg);
  font-weight: 600;
  margin: 0 0 var(--useful-space-3);
}
.layout-heading { margin: var(--useful-space-4) 0 var(--useful-space-2); font-size: var(--useful-text-md); }
.layout-list { display: flex; flex-direction: column; gap: var(--useful-space-1); margin: 0 0 var(--useful-space-3); padding: 0; list-style: none; }
.layout-item { display: flex; align-items: center; gap: var(--useful-space-2); min-height: 40px; padding: var(--useful-space-1) var(--useful-space-2); border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); }
.layout-item__visibility { display: flex; align-items: center; gap: var(--useful-space-2); flex: 1; }
.layout-item__note { color: var(--useful-text-tertiary); font-size: var(--useful-text-xs); }
.layout-item__actions { display: flex; gap: var(--useful-space-1); }
.settings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--useful-space-4);
  padding: var(--useful-space-3) 0;
  border-top: 1px solid var(--useful-border);
}
.settings-row:first-of-type {
  border-top: none;
}
.settings-row__label {
  font-weight: 500;
}
.settings-row__hint {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
  margin: 4px 0 0;
  max-width: 460px;
}
.settings-row__control--stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--useful-space-2);
}
.settings-path {
  color: var(--useful-text-secondary);
  word-break: break-all;
  text-align: right;
}
.settings-actions {
  display: flex;
  gap: var(--useful-space-2);
}
.seg {
  display: inline-flex;
  background: var(--useful-bg-active);
  border-radius: var(--useful-radius-md);
  padding: 2px;
}
.seg__btn {
  border: none;
  background: transparent;
  color: var(--useful-text-secondary);
  padding: 6px 14px;
  border-radius: var(--useful-radius-sm);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--useful-text-sm);
}
.seg__btn--active {
  background: var(--useful-bg-elevated);
  color: var(--useful-text);
  box-shadow: var(--useful-shadow-sm);
}
.switch {
  width: 40px;
  height: 22px;
  border-radius: 999px;
  background: var(--useful-border-strong);
  border: none;
  cursor: pointer;
  position: relative;
  transition: background var(--useful-transition);
}
.switch--on {
  background: var(--useful-accent);
}
.switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform var(--useful-transition);
}
.switch--on .switch__thumb {
  transform: translateX(18px);
}
</style>
