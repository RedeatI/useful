<script setup lang="ts">
// 源中心：legacy catalog 兼容索引源 + TRP discovery 信任源的分区管理。
// 官方徽章只来自 isOfficial（预置根指纹匹配）；伪官方源永远不显示官方徽章。
import { computed, onMounted, ref } from "vue";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import {
  accessModeKey,
  advisoryBannerVisible,
  advisorySeverityKey,
  capabilityLabels,
  conflictCount,
  formatFingerprint,
  loginStatusKey,
  officialBadgeVisible,
  requiresAuth,
  reviewBadges,
  shortPublisherKey,
  splitSources,
  syncStatusKey,
} from "@/lib/sourceCenter";
import type {
  SourceAccountInfo,
  SourceInfo,
  TrpMergedItem,
  TrpSourceInfo,
  TrpSourcePreview,
} from "@/lib/types";
import AppIcon from "@/components/AppIcon.vue";
import StateBlock from "@/components/StateBlock.vue";
import PermissionDiffDialog from "@/components/PermissionDiffDialog.vue";

const sources = ref<TrpSourceInfo[]>([]);
const legacySources = ref<SourceInfo[]>([]);
const busy = ref(false);
const message = ref<string | null>(null);
const error = ref<string | null>(null);

// 安装权限确认对话框
const permDialog = ref<{
  open: boolean;
  packageName: string;
  permissions: string[];
  target: TrpMergedItem | null;
}>({ open: false, packageName: "", permissions: [], target: null });

// 添加源两步流程
const addUrl = ref("");
const preview = ref<TrpSourcePreview | null>(null);
const legacyUrl = ref("");
const legacyPublicKey = ref("");

// 多源本地搜索
const keyword = ref("");
const results = ref<TrpMergedItem[]>([]);
const searched = ref(false);

const grouped = computed(() => splitSources(sources.value));
const conflicts = computed(() => conflictCount(results.value));

// 源 -> 账户信息（登录状态）
const accounts = ref<Record<string, SourceAccountInfo | null>>({});

function note(msg: string): void {
  message.value = msg;
  error.value = null;
}
function fail(e: unknown): void {
  const raw = e instanceof Error ? e.message : String(e);
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    if (parsed.message) text = parsed.message;
  } catch {
    /* 原样展示 */
  }
  error.value = t("sourceCenter.actionFailed", { err: text });
  message.value = null;
}

async function reload(): Promise<void> {
  try {
    const [trp, legacy] = await Promise.all([ipc.trpSourceList(), ipc.sourceList()]);
    sources.value = trp;
    legacySources.value = legacy;
    // 拉取需登录源的账户状态
    for (const s of sources.value) {
      if (requiresAuth(s)) {
        try {
          accounts.value[s.id] = await ipc.sourceAccountGet(s.id);
        } catch {
          accounts.value[s.id] = null;
        }
      }
    }
  } catch (e) {
    fail(e);
  }
}

async function addLegacySource(): Promise<void> {
  if (!legacyUrl.value.trim()) return;
  busy.value = true;
  try {
    await ipc.sourceAdd(legacyUrl.value.trim(), legacyPublicKey.value.trim() || undefined);
    legacyUrl.value = "";
    legacyPublicKey.value = "";
    await reload();
  } catch (cause) { fail(cause); } finally { busy.value = false; }
}

async function refreshLegacySource(sourceId: string): Promise<void> {
  busy.value = true;
  try { await ipc.sourceRefresh(sourceId); await reload(); }
  catch (cause) { fail(cause); }
  finally { busy.value = false; }
}

async function toggleLegacySource(source: SourceInfo): Promise<void> {
  try { await ipc.sourceSetEnabled(source.id, !source.enabled); await reload(); }
  catch (cause) { fail(cause); }
}

async function removeLegacySource(source: SourceInfo): Promise<void> {
  if (!window.confirm(t("sourceCenter.legacyRemoveConfirm", { name: source.name }))) return;
  try { await ipc.sourceRemove(source.id); await reload(); }
  catch (cause) { fail(cause); }
}

async function login(s: TrpSourceInfo): Promise<void> {
  busy.value = true;
  note(t("sourceCenter.loginStarted"));
  try {
    const acct = await ipc.sourceLogin(s.id);
    accounts.value[s.id] = acct;
    note(t("sourceCenter.loginOk", { account: acct.displayName }));
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function logout(s: TrpSourceInfo): Promise<void> {
  if (!window.confirm(t("sourceCenter.logoutConfirm", { source: s.displayName }))) return;
  try {
    await ipc.sourceLogout(s.id);
    accounts.value[s.id] = null;
  } catch (e) {
    fail(e);
  }
}

onMounted(reload);

async function doPreview(): Promise<void> {
  if (!addUrl.value.trim() || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    preview.value = await ipc.trpSourcePreview(addUrl.value.trim());
  } catch (e) {
    preview.value = null;
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function confirmAdd(): Promise<void> {
  const p = preview.value;
  if (!p || busy.value) return;
  busy.value = true;
  try {
    const info = await ipc.trpSourceAdd(p.discoveryUrl, p.sourceId, p.rootKeyFingerprint);
    note(t("sourceCenter.addedOk", { name: info.displayName }));
    preview.value = null;
    addUrl.value = "";
    await reload();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function syncOne(sourceId: string): Promise<void> {
  busy.value = true;
  try {
    const r = await ipc.trpSourceSync(sourceId);
    if (!r.ok && r.message) error.value = t("sourceCenter.actionFailed", { err: r.message });
    await reload();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function syncAll(): Promise<void> {
  busy.value = true;
  try {
    const rs = await ipc.trpSourceSyncAll();
    const ok = rs.filter((r) => r.ok).length;
    note(t("sourceCenter.syncAllDone", { ok, failed: rs.length - ok }));
    await reload();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

async function setEnabled(s: TrpSourceInfo, enabled: boolean): Promise<void> {
  try {
    await ipc.trpSourceSetEnabled(s.id, enabled);
    await reload();
  } catch (e) {
    fail(e);
  }
}

async function setPriority(s: TrpSourceInfo, ev: Event): Promise<void> {
  const value = Number((ev.target as HTMLInputElement).value);
  if (!Number.isInteger(value)) return;
  try {
    await ipc.trpSourceSetPriority(s.id, value);
    await reload();
  } catch (e) {
    fail(e);
  }
}

async function removeSource(s: TrpSourceInfo): Promise<void> {
  if (!window.confirm(t("sourceCenter.removeConfirm", { name: s.displayName }))) return;
  try {
    await ipc.trpSourceRemove(s.id);
    await reload();
  } catch (e) {
    fail(e);
  }
}

async function doSearch(): Promise<void> {
  try {
    results.value = await ipc.trpCatalogSearch(keyword.value);
    searched.value = true;
  } catch (e) {
    fail(e);
  }
}

/** 安装：先直接尝试；后端返回“需要确认权限”时弹权限确认框（含敏感标记）。 */
async function requestInstall(r: TrpMergedItem): Promise<void> {
  try {
    await doInstall(r, false);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    let text = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      if (parsed.message) text = parsed.message;
    } catch {
      /* 原样 */
    }
    const m = /^需要确认权限: (.*)$/.exec(text);
    if (m) {
      permDialog.value = {
        open: true,
        packageName: r.item.name,
        permissions: m[1].split(", ").filter(Boolean),
        target: r,
      };
    } else {
      fail(e);
    }
  }
}

async function doInstall(r: TrpMergedItem, confirmed: boolean): Promise<void> {
  busy.value = true;
  try {
    const tool = await ipc.trpInstall(
      r.item.sourceId,
      r.item.publisherKeyId,
      r.item.toolId,
      confirmed,
    );
    note(t("sourceCenter.installedOk", { name: tool.name }));
  } finally {
    busy.value = false;
  }
}

async function confirmPermissions(): Promise<void> {
  const target = permDialog.value.target;
  permDialog.value.open = false;
  if (!target) return;
  try {
    await doInstall(target, true);
  } catch (e) {
    fail(e);
  }
}

function syncTimeText(s: TrpSourceInfo): string {
  if (!s.lastSyncAt) return t("sourceCenter.syncNever");
  return new Date(s.lastSyncAt * 1000).toLocaleString();
}
</script>

<template>
  <div class="useful-page">
    <div class="sc-head">
      <div>
        <h1 class="useful-page__title">{{ t("sourceCenter.title") }}</h1>
        <p class="sc-subtitle">{{ t("sourceCenter.subtitle") }}</p>
      </div>
      <button class="useful-btn" :disabled="busy" data-testid="sync-all" @click="syncAll">
        <AppIcon name="refresh" :size="14" />
        {{ t("sourceCenter.syncAll") }}
      </button>
    </div>

    <p v-if="message" class="sc-msg sc-msg--ok" role="status">{{ message }}</p>
    <p v-if="error" class="sc-msg sc-msg--err" role="alert">{{ error }}</p>

    <section class="useful-card sc-section" data-testid="legacy-source-section">
      <h2 class="sc-section__title">{{ t("sourceCenter.legacySection") }}</h2>
      <p class="sc-hint">{{ t("sourceCenter.legacyHint") }}</p>
      <div class="sc-add-row">
        <input v-model="legacyUrl" class="useful-input" :aria-label="t('sourceCenter.legacyUrlLabel')" :placeholder="t('sourceCenter.legacyUrlPlaceholder')" data-testid="legacy-url" />
        <input v-model="legacyPublicKey" class="useful-input useful-mono" :aria-label="t('sourceCenter.legacyKeyLabel')" :placeholder="t('sourceCenter.legacyKeyPlaceholder')" />
        <button class="useful-btn useful-btn--primary" :disabled="busy || !legacyUrl.trim()" data-testid="legacy-add" @click="addLegacySource">{{ t("sourceCenter.legacyAdd") }}</button>
      </div>
      <div v-if="legacySources.length" class="legacy-list">
        <article v-for="source in legacySources" :key="source.id" class="sc-source" data-testid="legacy-source-card">
          <div class="sc-source__main">
            <div class="sc-source__name"><span>{{ source.name }}</span><span class="useful-badge">{{ t("sourceCenter.legacyPackageCount", { count: source.packageCount }) }}</span><span v-if="!source.enabled" class="useful-badge">{{ t("common.disabled") }}</span></div>
            <div class="sc-source__meta useful-mono sc-break">{{ source.url }}</div>
            <div class="sc-source__meta useful-mono sc-break">{{ t("sourceCenter.legacyFingerprint", { fingerprint: source.fingerprint }) }}</div>
          </div>
          <div class="sc-source__actions">
            <button class="useful-btn" :disabled="busy" data-testid="legacy-refresh" @click="refreshLegacySource(source.id)">{{ t("common.refresh") }}</button>
            <button class="useful-btn" data-testid="legacy-toggle" @click="toggleLegacySource(source)">{{ t(source.enabled ? "sourceCenter.disable" : "sourceCenter.enable") }}</button>
            <button class="useful-btn useful-btn--danger" data-testid="legacy-remove" @click="removeLegacySource(source)">{{ t("common.delete") }}</button>
          </div>
        </article>
      </div>
      <p v-else class="sc-empty">{{ t("sourceCenter.noLegacySources") }}</p>
    </section>

    <!-- TRP discovery 源 -->
    <section class="useful-card sc-section">
      <h2 class="sc-section__title">{{ t("sourceCenter.addSection") }}</h2>
      <div class="sc-add-row">
        <input
          v-model="addUrl"
          class="useful-input"
          :placeholder="t('sourceCenter.addUrlPlaceholder')"
          data-testid="add-url"
          @keydown.enter="doPreview"
        />
        <button class="useful-btn useful-btn--primary" :disabled="busy" @click="doPreview">
          {{ t("sourceCenter.preview") }}
        </button>
      </div>

      <!-- 第二步：指纹确认 -->
      <div v-if="preview" class="sc-preview" data-testid="preview-panel">
        <h3 class="sc-preview__title">{{ t("sourceCenter.previewTitle") }}</h3>
        <dl class="sc-dl">
          <dt>{{ t("sourceCenter.fieldName") }}</dt>
          <dd>
            {{ preview.name }}
            <span v-if="officialBadgeVisible(preview)" class="useful-badge useful-badge--accent">
              {{ t("sourceCenter.officialBadge") }}
            </span>
            <span v-if="preview.local" class="useful-badge useful-badge--warning">
              {{ t("sourceCenter.localBadge") }}
            </span>
          </dd>
          <dt>{{ t("sourceCenter.fieldOperator") }}</dt>
          <dd>{{ preview.operator }}</dd>
          <dt>{{ t("sourceCenter.fieldUrl") }}</dt>
          <dd class="useful-mono sc-break">{{ preview.discoveryUrl }}</dd>
          <dt>{{ t("sourceCenter.fieldFingerprint") }}</dt>
          <dd class="useful-mono sc-break" data-testid="preview-fingerprint">
            {{ formatFingerprint(preview.rootKeyFingerprint) }}
          </dd>
          <dt>{{ t("sourceCenter.fieldRequiresAuth") }}</dt>
          <dd>{{ preview.requiresAuth ? t("common.yes") : t("common.no") }}</dd>
          <dt>{{ t("sourceCenter.fieldPaid") }}</dt>
          <dd>{{ preview.paidDownloads ? t("common.yes") : t("common.no") }}</dd>
          <dt>{{ t("sourceCenter.fieldNativeWorkers") }}</dt>
          <dd>{{ preview.nativeWorkers ? t("common.yes") : t("common.no") }}</dd>
        </dl>
        <p class="sc-hint">{{ t("sourceCenter.fingerprintHint") }}</p>
        <p v-if="!preview.isOfficial" class="sc-notice" data-testid="third-party-notice">
          {{ t("sourceCenter.thirdPartyNotice") }}
        </p>
        <div class="sc-preview__actions">
          <button
            class="useful-btn useful-btn--primary"
            :disabled="busy"
            data-testid="confirm-add"
            @click="confirmAdd"
          >
            {{ t("sourceCenter.confirmAdd") }}
          </button>
          <button class="useful-btn" @click="preview = null">{{ t("common.cancel") }}</button>
        </div>
      </div>
    </section>

    <!-- 已启用源 -->
    <section class="sc-section">
      <h2 class="sc-section__title">{{ t("sourceCenter.enabledSection") }}</h2>
      <StateBlock
        v-if="!grouped.enabled.length"
        variant="empty"
        :hint="t('sourceCenter.noSources')"
      />
      <div v-for="s in grouped.enabled" :key="s.id" class="useful-card sc-source" data-testid="source-card">
        <div class="sc-source__main">
          <div class="sc-source__name">
            <span>{{ s.displayName }}</span>
            <span v-if="officialBadgeVisible(s)" class="useful-badge useful-badge--accent">
              {{ t("sourceCenter.officialBadge") }}
            </span>
            <span v-if="s.local" class="useful-badge useful-badge--warning">
              {{ t("sourceCenter.localBadge") }}
            </span>
            <span v-if="s.kind === 'mirror'" class="useful-badge">{{ t("sourceCenter.mirrorBadge") }}</span>
            <span
              class="useful-badge"
              :class="{ 'useful-badge--warning': s.lastSyncStatus === 'failed' }"
            >
              {{ t(syncStatusKey(s.lastSyncStatus)) }}
            </span>
          </div>
          <div class="sc-source__meta useful-mono sc-break">{{ s.discoveryUrl }}</div>
          <div class="sc-source__meta">
            {{ s.operator }} · {{ t("sourceCenter.entryCount", { count: s.entryCount }) }} ·
            {{ t("sourceCenter.lastSync") }}: {{ syncTimeText(s) }}
            <template v-if="s.lastSyncDurationMs !== null">
              · {{ t("sourceCenter.syncDuration", { ms: s.lastSyncDurationMs }) }}
            </template>
          </div>
          <div class="sc-source__meta useful-mono sc-break">
            {{ t("sourceCenter.fieldFingerprint") }}: {{ formatFingerprint(s.rootKeyFingerprint) }}
          </div>
          <div v-if="capabilityLabels(s).length" class="sc-caps">
            <span v-for="cap in capabilityLabels(s)" :key="cap" class="useful-badge">{{ t(cap) }}</span>
          </div>
          <div v-if="s.lastSyncError" class="sc-source__error">{{ s.lastSyncError }}</div>
          <!-- 账户与订阅（仅需登录源） -->
          <div v-if="requiresAuth(s)" class="sc-account" data-testid="account-row">
            <span class="sc-source__meta">
              {{ t(loginStatusKey(accounts[s.id] ?? null), { account: accounts[s.id]?.displayName ?? '' }) }}
            </span>
          </div>
        </div>
        <div class="sc-source__actions">
          <label class="sc-priority">
            {{ t("sourceCenter.priority") }}
            <input
              class="useful-input sc-priority__input"
              type="number"
              min="0"
              max="1000"
              :value="s.priority"
              @change="setPriority(s, $event)"
            />
          </label>
          <button class="useful-btn" :disabled="busy" @click="syncOne(s.id)">
            {{ t("sourceCenter.syncNow") }}
          </button>
          <button
            v-if="requiresAuth(s) && !accounts[s.id]"
            class="useful-btn useful-btn--primary"
            :disabled="busy"
            data-testid="login-btn"
            @click="login(s)"
          >
            {{ t("sourceCenter.login") }}
          </button>
          <button
            v-if="requiresAuth(s) && accounts[s.id]"
            class="useful-btn"
            data-testid="logout-btn"
            @click="logout(s)"
          >
            {{ t("sourceCenter.logout") }}
          </button>
          <button class="useful-btn" @click="setEnabled(s, false)">
            {{ t("sourceCenter.disable") }}
          </button>
          <button class="useful-btn useful-btn--danger" @click="removeSource(s)">
            {{ t("sourceCenter.remove") }}
          </button>
        </div>
      </div>
    </section>

    <!-- 已禁用源 -->
    <section class="sc-section">
      <h2 class="sc-section__title">{{ t("sourceCenter.disabledSection") }}</h2>
      <p v-if="!grouped.disabled.length" class="sc-empty">{{ t("sourceCenter.noDisabled") }}</p>
      <div v-for="s in grouped.disabled" :key="s.id" class="useful-card sc-source sc-source--disabled">
        <div class="sc-source__main">
          <div class="sc-source__name">
            <span>{{ s.displayName }}</span>
            <span class="useful-badge">{{ t("common.disabled") }}</span>
          </div>
          <div class="sc-source__meta useful-mono sc-break">{{ s.discoveryUrl }}</div>
        </div>
        <div class="sc-source__actions">
          <button class="useful-btn" @click="setEnabled(s, true)">{{ t("sourceCenter.enable") }}</button>
          <button class="useful-btn useful-btn--danger" @click="removeSource(s)">
            {{ t("sourceCenter.remove") }}
          </button>
        </div>
      </div>
    </section>

    <!-- 多源本地搜索 -->
    <section class="sc-section">
      <h2 class="sc-section__title">{{ t("sourceCenter.searchSection") }}</h2>
      <p class="sc-hint">{{ t("sourceCenter.searchHint") }}</p>
      <div class="sc-add-row">
        <input
          v-model="keyword"
          class="useful-input"
          :placeholder="t('sourceCenter.searchPlaceholder')"
          data-testid="search-input"
          @keydown.enter="doSearch"
        />
        <button class="useful-btn" @click="doSearch">
          <AppIcon name="search" :size="14" />
          {{ t("common.search") }}
        </button>
      </div>

      <p v-if="conflicts > 0" class="sc-notice" data-testid="conflict-hint">
        {{ t("sourceCenter.conflictHint", { count: conflicts }) }}
      </p>

      <div v-if="results.length" class="sc-results">
        <div
          v-for="r in results"
          :key="`${r.item.sourceId}/${r.item.publisherKeyId}/${r.item.toolId}`"
          class="useful-card sc-result"
          data-testid="search-result"
        >
          <div class="sc-result__main">
            <div class="sc-source__name">
              <span>{{ r.item.name }}</span>
              <span v-if="r.item.latestStable" class="useful-badge">v{{ r.item.latestStable }}</span>
              <span class="useful-badge">{{ t(accessModeKey(r.item.accessMode)) }}</span>
              <span v-if="r.nameConflict" class="useful-badge useful-badge--warning" data-testid="conflict-badge">
                {{ t("sourceCenter.conflictBadge") }}
              </span>
              <span v-if="r.item.isNativeWorker" class="useful-badge useful-badge--warning">
                {{ t("sourceCenter.nativeWorkerBadge") }}
              </span>
              <!-- 各独立审核/签名状态（Phase 9）：不合并、不隐藏 -->
              <span
                v-for="b in reviewBadges(r.item)"
                :key="b.key"
                class="useful-badge"
                :class="b.ok ? 'useful-badge--ok' : 'useful-badge--muted'"
                :data-testid="b.ok ? 'review-badge-ok' : 'review-badge-pending'"
              >
                {{ t(b.key) }}{{ b.ok ? "" : t("sourceCenter.reviewNotPassedSuffix") }}
              </span>
            </div>
            <div
              v-if="advisoryBannerVisible(r.item)"
              class="sc-notice sc-notice--danger"
              data-testid="advisory-banner"
            >
              {{
                t("sourceCenter.advisoryBanner", {
                  count: r.item.advisoryCount,
                  severity: t(advisorySeverityKey(r.item.maxAdvisorySeverity)),
                })
              }}
            </div>
            <div class="sc-source__meta useful-mono">{{ r.item.toolId }}</div>
            <div class="sc-source__meta">
              {{ t("sourceCenter.publisherLabel") }}:
              <span class="useful-mono">{{ shortPublisherKey(r.item.publisherKeyId) }}</span>
              · {{ t("sourceCenter.sourceLabel") }}: {{ r.item.sourceId }}
              <template v-if="r.item.license">
                · {{ t("sourceCenter.licenseLabel") }}: {{ r.item.license }}
              </template>
            </div>
            <div v-if="r.mirrorSourceIds.length" class="sc-source__meta" data-testid="mirror-info">
              {{ t("sourceCenter.mirrorsLabel", { sources: r.mirrorSourceIds.join(", ") }) }}
            </div>
            <div v-if="r.item.summary" class="sc-source__meta">{{ r.item.summary }}</div>
          </div>
          <div class="sc-result__actions">
            <button
              v-if="r.item.accessMode === 'free' && !r.item.isNativeWorker && r.item.latestStable"
              class="useful-btn useful-btn--primary"
              :disabled="busy"
              data-testid="install-btn"
              @click="requestInstall(r)"
            >
              {{ t("sourceCenter.install") }}
            </button>
          </div>
        </div>
      </div>
      <p v-else-if="searched" class="sc-empty">{{ t("sourceCenter.searchEmpty") }}</p>
    </section>

    <PermissionDiffDialog
      :open="permDialog.open"
      mode="install"
      :package-name="permDialog.packageName"
      :permissions="permDialog.permissions"
      @confirm="confirmPermissions()"
      @cancel="permDialog.open = false"
    />
  </div>
</template>

<style scoped>
.sc-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--useful-space-3);
}
.sc-subtitle {
  color: var(--useful-text-tertiary);
  font-size: var(--useful-text-sm);
  margin-top: var(--useful-space-1);
}
.sc-msg {
  font-size: var(--useful-text-sm);
  margin: var(--useful-space-2) 0;
}
.sc-msg--ok {
  color: var(--useful-success, var(--useful-accent));
}
.sc-msg--err {
  color: var(--useful-danger);
}
.sc-section {
  margin-top: var(--useful-space-4);
}
.sc-section__title {
  font-size: var(--useful-text-md);
  font-weight: 600;
  margin-bottom: var(--useful-space-2);
}
.sc-add-row {
  display: flex;
  gap: var(--useful-space-2);
}
.sc-add-row .useful-input {
  flex: 1;
}
.sc-preview {
  margin-top: var(--useful-space-3);
  padding-top: var(--useful-space-3);
  border-top: 1px solid var(--useful-border);
}
.sc-preview__title {
  font-size: var(--useful-text-md);
  font-weight: 600;
  margin-bottom: var(--useful-space-2);
}
.sc-dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--useful-space-1) var(--useful-space-4);
  margin: 0;
}
.sc-dl dt {
  color: var(--useful-text-tertiary);
  font-size: var(--useful-text-sm);
}
.sc-dl dd {
  margin: 0;
  font-size: var(--useful-text-sm);
}
.sc-hint {
  color: var(--useful-text-tertiary);
  font-size: var(--useful-text-sm);
  margin: var(--useful-space-2) 0;
}
.sc-notice {
  background: var(--useful-bg-active);
  border-left: 3px solid var(--useful-accent);
  border-radius: var(--useful-radius-sm);
  padding: var(--useful-space-2) var(--useful-space-3);
  font-size: var(--useful-text-sm);
  margin: var(--useful-space-2) 0;
}
.sc-notice--danger {
  border-left-color: var(--useful-danger, #c0392b);
  background: rgba(192, 57, 43, 0.08);
}
.sc-preview__actions {
  display: flex;
  gap: var(--useful-space-2);
  margin-top: var(--useful-space-2);
}
.sc-source {
  display: flex;
  justify-content: space-between;
  gap: var(--useful-space-3);
  padding: var(--useful-space-3) var(--useful-space-4);
  margin-bottom: var(--useful-space-2);
}
.sc-source--disabled {
  opacity: 0.75;
}
.sc-source__main {
  flex: 1;
  min-width: 0;
}
.sc-source__name {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  font-weight: 600;
  flex-wrap: wrap;
}
.sc-source__meta {
  color: var(--useful-text-tertiary);
  font-size: var(--useful-text-sm);
  margin-top: var(--useful-space-1);
}
.sc-source__error {
  color: var(--useful-danger);
  font-size: var(--useful-text-sm);
  margin-top: var(--useful-space-1);
  word-break: break-all;
}
.sc-caps {
  display: flex;
  gap: var(--useful-space-1);
  flex-wrap: wrap;
  margin-top: var(--useful-space-2);
}
.sc-source__actions {
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-2);
  align-items: stretch;
  flex-shrink: 0;
}
.sc-priority {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  font-size: var(--useful-text-sm);
  color: var(--useful-text-tertiary);
}
.sc-priority__input {
  width: 72px;
}
.sc-break {
  word-break: break-all;
}
.sc-empty {
  color: var(--useful-text-tertiary);
  font-size: var(--useful-text-sm);
}
.sc-results {
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-2);
}
.sc-result {
  padding: var(--useful-space-3) var(--useful-space-4);
  display: flex;
  justify-content: space-between;
  gap: var(--useful-space-3);
}
.sc-result__main {
  flex: 1;
  min-width: 0;
}
.sc-result__actions {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
}
</style>
