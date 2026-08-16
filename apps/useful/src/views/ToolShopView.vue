<script setup lang="ts">
// 发现与安装：本地 .useful 导入 + legacy catalog 浏览与安装。
// legacy/TRP 源信任管理统一从 Source Center 进入；安装、下载与信任契约保持不变。
import { computed, onMounted, ref } from "vue";
import { confirm as confirmDialog, open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/stores/app";
import { useUiStore } from "@/stores/ui";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import { formatBytes } from "@/lib/format";
import {
  catalogCategories,
  filterCatalog,
  latestPerPackage,
} from "@/lib/shop";
import type { ShopPackage, SourceInfo } from "@/lib/types";
import AppIcon from "@/components/AppIcon.vue";
import StateBlock from "@/components/StateBlock.vue";

const appStore = useAppStore();
const uiStore = useUiStore();

const busy = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);

const sources = ref<SourceInfo[]>([]);
const catalog = ref<ShopPackage[]>([]);
const keyword = ref("");
const category = ref("");
const expandedPkg = ref<string | null>(null);

const categories = computed(() => catalogCategories(catalog.value));
const visiblePackages = computed(() =>
  latestPerPackage(filterCatalog(catalog.value, keyword.value, category.value)),
);

function note(msg: string): void {
  message.value = msg;
  error.value = null;
}
function fail(e: unknown): void {
  const raw = e instanceof Error ? e.message : String(e);
  // Tauri CmdError 序列化为 {message}
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    if (parsed.message) text = parsed.message;
  } catch {
    /* 原样展示 */
  }
  error.value = t("shop.actionFailed", { err: text });
  message.value = null;
}

async function reload(): Promise<void> {
  try {
    const [s, c] = await Promise.all([ipc.sourceList(), ipc.shopCatalog()]);
    sources.value = s;
    catalog.value = c;
  } catch (e) {
    fail(e);
  }
}

onMounted(() => {
  void reload();
});

async function importLocalPlugin(): Promise<void> {
  error.value = null;
  message.value = null;
  const selected = await open({
    multiple: false,
    filters: [{ name: t("shop.pluginFileType"), extensions: ["useful"] }],
  });
  if (!selected || typeof selected !== "string") return;
  busy.value = true;
  try {
    const tool = await ipc.installLocalPlugin(selected);
    await appStore.reloadTools();
    note(t("shop.installedOk", { name: tool.name }));
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

// ---- 固定 / 回滚 / 卸载 ----
async function togglePin(pkg: ShopPackage): Promise<void> {
  try {
    await ipc.toolSetPinned(pkg.id, !pkg.pinned);
    await reload();
  } catch (e) {
    fail(e);
  }
}

async function rollbackTool(toolId: string): Promise<void> {
  if (!(await confirmDialog(t("shop.rollbackConfirm")))) return;
  try {
    const tool = await ipc.toolRollback(toolId);
    await Promise.all([appStore.reloadTools(), reload()]);
    note(t("shop.rollbackDone", { version: tool.version ?? "" }));
  } catch (e) {
    fail(e);
  }
}

async function uninstallTool(toolId: string, name: string): Promise<void> {
  if (!(await confirmDialog(t("shop.uninstallConfirm", { name })))) return;
  try {
    // 卸载时提示是否删除对应桌面快捷方式
    const shortcuts = (await ipc.listShortcuts()).filter((s) => s.toolId === toolId);
    if (shortcuts.length > 0 && await confirmDialog(t("shortcut.uninstallWithShortcut"))) {
      for (const s of shortcuts) {
        await ipc.deleteShortcut(s.id);
      }
    }
    await ipc.uninstallPlugin(toolId);
    await Promise.all([appStore.reloadTools(), reload()]);
  } catch (e) {
    fail(e);
  }
}

</script>

<template>
  <div class="useful-page">
    <div class="shop-head">
      <h1 class="useful-page__title">{{ t("nav.toolShop") }}</h1>
      <div class="shop-actions">
        <button class="useful-btn useful-btn--primary" :disabled="busy" @click="importLocalPlugin">
          <AppIcon name="plus" :size="16" />
          {{ t("shop.importLocal") }}
        </button>
      </div>
    </div>

    <p v-if="uiStore.developerMode" class="shop-msg shop-msg--warn" role="alert">
      <AppIcon name="alert" :size="16" />
      {{ t("shop.devSourceWarning") }}
    </p>
    <p v-if="message" class="shop-msg shop-msg--ok" role="status">{{ message }}</p>
    <p v-if="error" class="shop-msg shop-msg--err" role="alert">{{ error }}</p>

    <!-- 工具铺只负责浏览/安装；源信任管理收敛到 Source Center。 -->
    <div class="useful-card source-management" data-testid="source-management-link">
      <div>
        <h2 class="useful-section__title">{{ t("shop.sourceSummaryTitle") }}</h2>
        <p>{{ t("shop.sourceSummary", { count: sources.length }) }}</p>
      </div>
      <router-link class="useful-btn" to="/sources"><AppIcon name="source" :size="16" /> {{ t("shop.manageSources") }}</router-link>
    </div>

    <!-- 可安装工具 -->
    <h2 class="useful-section__title">{{ t("shop.catalogSection") }}</h2>
    <div v-if="catalog.length" class="catalog-filter">
      <input
        v-model="keyword"
        class="useful-input catalog-filter__search"
        :placeholder="t('shop.searchPlaceholder')"
        :aria-label="t('common.search')"
      />
      <select v-model="category" class="useful-input" :aria-label="t('shop.allCategories')">
        <option value="">{{ t("shop.allCategories") }}</option>
        <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
      </select>
    </div>
    <div v-if="visiblePackages.length" class="catalog-list">
      <div v-for="pkg in visiblePackages" :key="`${pkg.sourceId}/${pkg.id}`" class="useful-card pkg-item">
        <div class="pkg-item__row">
          <div class="pkg-item__main">
            <div class="pkg-item__name">
              <span class="useful-mono">{{ pkg.id }}</span>
              <span class="useful-badge">v{{ pkg.version }}</span>
              <span v-if="pkg.category" class="useful-badge">{{ pkg.category }}</span>
              <span v-if="pkg.installedVersion" class="useful-badge">
                {{ t("shop.installedBadge", { version: pkg.installedVersion }) }}
              </span>
              <span v-if="pkg.updateAvailable && !pkg.pinned" class="useful-badge pkg-item__update">
                {{ t("shop.updateBadge") }}
              </span>
              <span v-if="pkg.pinned" class="useful-badge">{{ t("shop.pinnedBadge") }}</span>
            </div>
            <div class="pkg-item__desc">{{ pkg.changelog || "—" }}</div>
          </div>
          <div class="pkg-item__actions">
            <button
              class="useful-btn useful-btn--ghost"
              @click="expandedPkg = expandedPkg === `${pkg.sourceId}/${pkg.id}` ? null : `${pkg.sourceId}/${pkg.id}`"
            >
              {{ t("shop.details") }}
            </button>
          </div>
        </div>
        <div v-if="expandedPkg === `${pkg.sourceId}/${pkg.id}`" class="pkg-item__details">
          <div>{{ t("shop.sizeLabel") }}: {{ formatBytes(pkg.size) }}</div>
          <div>{{ t("shop.sourceLabel") }}: <span class="useful-mono">{{ pkg.sourceId }}</span></div>
          <div>{{ t("shop.minHost") }}: {{ pkg.minHostVersion }}</div>
          <div>
            {{ t("shop.permissions") }}:
            <span v-if="pkg.permissions.length" class="useful-mono">{{ pkg.permissions.join(", ") }}</span>
            <span v-else>{{ t("shop.noPermissions") }}</span>
          </div>
          <div v-if="pkg.changelog">{{ t("shop.changelog") }}: {{ pkg.changelog }}</div>
          <div v-if="pkg.installedVersion" class="pkg-item__manage">
            <button class="useful-btn" @click="togglePin(pkg)">
              {{ pkg.pinned ? t("shop.unpin") : t("shop.pin") }}
            </button>
            <button class="useful-btn" @click="rollbackTool(pkg.id)">
              {{ t("shop.rollback") }}
            </button>
            <button class="useful-btn" @click="uninstallTool(pkg.id, pkg.id)">
              <AppIcon name="trash" :size="14" />
              {{ t("shop.uninstall") }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <StateBlock v-else-if="sources.length" variant="empty" :hint="t('shop.noCatalog')" />

    <!-- 已安装 -->
    <h2 class="useful-section__title">{{ t("shop.installedSection") }}</h2>
    <div v-if="appStore.installedTools.length" class="installed-list">
      <div v-for="tool in appStore.installedTools" :key="tool.id" class="useful-card installed-item">
        <div class="installed-item__main">
          <AppIcon name="puzzle" :size="22" />
          <div>
            <div class="installed-item__name">{{ tool.name }}</div>
            <div class="installed-item__id useful-mono">{{ tool.id }}</div>
          </div>
        </div>
        <div class="installed-item__actions">
          <span v-if="tool.version" class="useful-badge">v{{ tool.version }}</span>
          <button class="useful-btn" @click="uninstallTool(tool.id, tool.name)">
            <AppIcon name="trash" :size="14" />
            {{ t("shop.uninstall") }}
          </button>
        </div>
      </div>
    </div>
    <StateBlock v-else variant="empty" :hint="t('state.emptyHint')" />
  </div>
</template>

<style scoped>
.shop-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.shop-actions {
  display: flex;
  gap: var(--useful-space-2);
}
.shop-msg {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  padding: var(--useful-space-2) var(--useful-space-3);
  border-radius: var(--useful-radius-md);
  font-size: var(--useful-text-sm);
}
.shop-msg--ok {
  background: var(--useful-bg-selected);
  color: var(--useful-success);
}
.shop-msg--err {
  background: rgba(196, 43, 28, 0.12);
  color: var(--useful-danger);
}
.shop-msg--warn {
  background: rgba(157, 93, 0, 0.12);
  color: var(--useful-warning);
}
.source-add {
  display: flex;
  gap: var(--useful-space-2);
  padding: var(--useful-space-3);
  flex-wrap: wrap;
}
.source-add__url {
  flex: 2 1 280px;
}
.source-add__key {
  flex: 1 1 200px;
}
.source-list,
.catalog-list,
.installed-list {
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-2);
}
.source-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--useful-space-3);
  padding: var(--useful-space-3) var(--useful-space-4);
  flex-wrap: wrap;
}
.source-item__name {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
}
.source-item__meta {
  color: var(--useful-text-tertiary);
  font-size: var(--useful-text-sm);
  word-break: break-all;
}
.source-item__actions {
  display: flex;
  gap: var(--useful-space-2);
  flex-wrap: wrap;
}
.catalog-filter {
  display: flex;
  gap: var(--useful-space-2);
  margin-bottom: var(--useful-space-2);
}
.catalog-filter__search {
  flex: 1;
}
.pkg-item {
  padding: var(--useful-space-3) var(--useful-space-4);
}
.pkg-item__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--useful-space-3);
  flex-wrap: wrap;
}
.pkg-item__name {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  flex-wrap: wrap;
  font-weight: 600;
}
.pkg-item__update {
  color: var(--useful-accent);
}
.pkg-item__desc {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
  margin-top: var(--useful-space-1);
}
.pkg-item__actions {
  display: flex;
  gap: var(--useful-space-2);
}
.pkg-item__details {
  margin-top: var(--useful-space-3);
  padding-top: var(--useful-space-3);
  border-top: 1px solid var(--useful-border);
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-1);
  font-size: var(--useful-text-sm);
  color: var(--useful-text-secondary);
}
.pkg-item__manage {
  display: flex;
  gap: var(--useful-space-2);
  margin-top: var(--useful-space-2);
}
.installed-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--useful-space-3) var(--useful-space-4);
}
.installed-item__main {
  display: flex;
  align-items: center;
  gap: var(--useful-space-3);
  color: var(--useful-accent);
}
.installed-item__name {
  font-weight: 600;
  color: var(--useful-text);
}
.installed-item__id {
  color: var(--useful-text-tertiary);
}
.installed-item__actions {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
}
</style>
