<script setup lang="ts">
// 开发者性能面板：展示后端采样耗时、进程数、ETW/GPU 状态、mpv/ffmpeg/插件占位。
import { onMounted, onUnmounted, ref } from "vue";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import type { ProcmonStats } from "@/lib/types";

const stats = ref<ProcmonStats | null>(null);
const webviewMemory = ref<number | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  try {
    stats.value = await ipc.procmonStats();
  } catch {
    stats.value = null;
  }
  // WebView 内存（Chromium performance.memory，非标准，可能不存在）
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  webviewMemory.value = mem ? mem.usedJSHeapSize : null;
}

function fmtBytes(n: number | null): string {
  if (n === null) return t("common.unavailable");
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

onMounted(() => {
  void poll();
  timer = setInterval(poll, 1000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="useful-card perf">
    <h2 class="perf__title">{{ t("perf.title") }}</h2>
    <div class="perf__grid">
      <div class="perf__item">
        <span class="perf__label">{{ t("perf.webviewMemory") }}</span>
        <span class="perf__value useful-mono">{{ fmtBytes(webviewMemory) }}</span>
      </div>
      <div class="perf__item">
        <span class="perf__label">{{ t("perf.backendSampling") }}</span>
        <span class="perf__value useful-mono">
          {{ stats ? stats.backendSamplingMs.toFixed(1) + " ms" : t("common.unavailable") }}
        </span>
      </div>
      <div class="perf__item">
        <span class="perf__label">{{ t("perf.processCount") }}</span>
        <span class="perf__value useful-mono">{{ stats ? stats.processCount : "—" }}</span>
      </div>
      <div class="perf__item">
        <span class="perf__label">{{ t("perf.etwStatus") }}</span>
        <span class="perf__value">
          <span class="useful-badge" :class="stats?.netAvailable ? 'useful-badge--accent' : ''">
            {{ stats?.netAvailable ? t("common.enabled") : t("common.unavailable") }}
          </span>
        </span>
      </div>
      <div class="perf__item">
        <span class="perf__label">GPU</span>
        <span class="perf__value">
          <span class="useful-badge" :class="stats?.gpuAvailable ? 'useful-badge--accent' : ''">
            {{ stats?.gpuAvailable ? t("common.enabled") : t("common.unavailable") }}
          </span>
        </span>
      </div>
      <div class="perf__item">
        <span class="perf__label">{{ t("perf.mpvStatus") }}</span>
        <span class="perf__value useful-mono">—</span>
      </div>
      <div class="perf__item">
        <span class="perf__label">{{ t("perf.ffmpegTasks") }}</span>
        <span class="perf__value useful-mono">0</span>
      </div>
      <div class="perf__item">
        <span class="perf__label">{{ t("perf.pluginMessages") }}</span>
        <span class="perf__value useful-mono">0</span>
      </div>
      <div class="perf__item">
        <span class="perf__label">{{ t("perf.pluginRejections") }}</span>
        <span class="perf__value useful-mono">0</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.perf {
  margin-bottom: var(--useful-space-4);
  max-width: 760px;
}
.perf__title {
  font-size: var(--useful-text-lg);
  font-weight: 600;
  margin: 0 0 var(--useful-space-3);
}
.perf__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--useful-space-2);
}
.perf__item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--useful-space-2) var(--useful-space-3);
  background: var(--useful-bg);
  border-radius: var(--useful-radius-md);
}
.perf__label {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
}
</style>
