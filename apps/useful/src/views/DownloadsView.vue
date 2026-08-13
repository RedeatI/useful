<script setup lang="ts">
// 下载与更新：下载队列、实时进度（download-progress/download-done 事件）、取消、清除。
import { onMounted, onUnmounted, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import { formatBytes } from "@/lib/format";
import {
  applyDownloadDone,
  applyDownloadProgress,
  downloadErrorKey,
  downloadPercent,
  downloadStatusKey,
  isActiveDownload,
} from "@/lib/shop";
import type { DownloadDoneEvent, DownloadProgressEvent, DownloadRecord } from "@/lib/types";
import StateBlock from "@/components/StateBlock.vue";
import AppIcon from "@/components/AppIcon.vue";

const downloads = ref<DownloadRecord[]>([]);
const error = ref<string | null>(null);
let unlisteners: UnlistenFn[] = [];

async function reload(): Promise<void> {
  try {
    downloads.value = await ipc.downloadsList();
  } catch (e) {
    error.value = String(e);
  }
}

onMounted(async () => {
  await reload();
  try {
    unlisteners = [
      await listen<DownloadProgressEvent>("download-progress", (ev) => {
        downloads.value = applyDownloadProgress(downloads.value, ev.payload);
      }),
      await listen<DownloadDoneEvent>("download-done", (ev) => {
        downloads.value = applyDownloadDone(downloads.value, ev.payload);
      }),
    ];
  } catch {
    // 纯前端测试环境无 Tauri 事件系统
  }
});

onUnmounted(() => {
  for (const un of unlisteners) un();
});

async function cancelDownload(id: string): Promise<void> {
  try {
    await ipc.downloadCancel(id);
  } catch (e) {
    error.value = String(e);
  }
}

async function clearFinished(): Promise<void> {
  try {
    await ipc.downloadsClearFinished();
    await reload();
  } catch (e) {
    error.value = String(e);
  }
}

function progressText(d: DownloadRecord): string {
  const pct = downloadPercent(d.receivedBytes, d.totalBytes);
  const total = d.totalBytes ? formatBytes(d.totalBytes) : t("downloads.unknownSize");
  return pct === null
    ? `${formatBytes(d.receivedBytes)} / ${total}`
    : `${formatBytes(d.receivedBytes)} / ${total} (${pct}%)`;
}

function errorText(d: DownloadRecord): string {
  const key = downloadErrorKey(d.errorCode);
  if (!key) return d.error ?? "";
  const summary = t(key);
  return d.error ? `${summary} ${d.error}` : summary;
}
</script>

<template>
  <div class="useful-page">
    <div class="dl-head">
      <h1 class="useful-page__title">{{ t("nav.downloads") }}</h1>
      <button class="useful-btn" @click="clearFinished">
        <AppIcon name="trash" :size="14" />
        {{ t("downloads.clearFinished") }}
      </button>
    </div>

    <p v-if="error" class="dl-error" role="alert">{{ error }}</p>

    <div v-if="downloads.length" class="dl-list">
      <div v-for="d in downloads" :key="d.id" class="useful-card dl-item" data-testid="download-item">
        <div class="dl-item__main">
          <div class="dl-item__name">
            <span class="useful-mono">{{ d.packageId ?? d.url }}</span>
            <span v-if="d.version" class="useful-badge">v{{ d.version }}</span>
            <span
              class="useful-badge"
              :class="{
                'useful-badge--accent': isActiveDownload(d.status),
                'useful-badge--warning': d.status === 'failed',
              }"
            >
              {{ t(downloadStatusKey(d.status)) }}
            </span>
          </div>
          <div class="dl-item__progress-row">
            <div
              class="dl-item__bar"
              role="progressbar"
              :aria-valuenow="downloadPercent(d.receivedBytes, d.totalBytes) ?? undefined"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div
                class="dl-item__bar-fill"
                :style="{ width: `${downloadPercent(d.receivedBytes, d.totalBytes) ?? 0}%` }"
              />
            </div>
            <span class="dl-item__progress-text">{{ progressText(d) }}</span>
          </div>
          <div v-if="d.digest" class="dl-item__digest" data-testid="download-digest">
            {{ t("downloads.digest") }}:
            <span class="useful-mono">{{ d.digest }}</span>
          </div>
          <div v-if="d.error || d.errorCode" class="dl-item__error">{{ errorText(d) }}</div>
        </div>
        <div class="dl-item__actions">
          <button
            v-if="isActiveDownload(d.status)"
            class="useful-btn"
            data-testid="download-cancel"
            @click="cancelDownload(d.id)"
          >
            {{ t("downloads.cancel") }}
          </button>
        </div>
      </div>
    </div>
    <StateBlock v-else variant="empty" :hint="t('downloads.empty')" />
  </div>
</template>

<style scoped>
.dl-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.dl-error {
  color: var(--useful-danger);
  font-size: var(--useful-text-sm);
}
.dl-list {
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-2);
}
.dl-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--useful-space-3);
  padding: var(--useful-space-3) var(--useful-space-4);
}
.dl-item__main {
  flex: 1;
  min-width: 0;
}
.dl-item__name {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  font-weight: 600;
  flex-wrap: wrap;
}
.dl-item__progress-row {
  display: flex;
  align-items: center;
  gap: var(--useful-space-3);
  margin-top: var(--useful-space-2);
}
.dl-item__bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--useful-bg-active);
  overflow: hidden;
}
.dl-item__bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--useful-accent);
  transition: width 0.2s ease;
}
.dl-item__progress-text {
  color: var(--useful-text-tertiary);
  font-size: var(--useful-text-sm);
  white-space: nowrap;
}
.dl-item__error {
  color: var(--useful-danger);
  font-size: var(--useful-text-sm);
  margin-top: var(--useful-space-1);
  word-break: break-all;
}
.dl-item__digest {
  color: var(--useful-text-tertiary);
  font-size: var(--useful-text-sm);
  margin-top: var(--useful-space-1);
  overflow-wrap: anywhere;
}
.dl-item__actions {
  display: flex;
  gap: var(--useful-space-2);
}
</style>
