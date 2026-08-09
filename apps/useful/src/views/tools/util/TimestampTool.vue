<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { fromUnix, fromDateString, type TimeParts } from "@/lib/tools/transforms";
import { toolErrorMessage } from "@/lib/tools/errors";

const raw = ref(String(Math.floor(Date.now() / 1000)));

const result = computed<{ value: TimeParts | null; error: string | null }>(() => {
  const v = raw.value.trim();
  if (!v) return { value: null, error: null };
  try {
    return {
      value: /^\d+$/.test(v) ? fromUnix(Number(v)) : fromDateString(v),
      error: null,
    };
  } catch (e) {
    return { value: null, error: toolErrorMessage(e) };
  }
});
const parts = computed(() => result.value.value);
const error = computed(() => result.value.error);

function now(): void {
  raw.value = String(Math.floor(Date.now() / 1000));
}
</script>

<template>
  <ToolShell
    :title="t('util.timestamp.name')"
    :description="t('util.timestamp.desc')"
    :error="error"
  >
    <div class="tool-row">
      <input
        v-model="raw"
        class="useful-input"
        style="flex: 1; min-width: 220px"
        :placeholder="t('util.timestamp.placeholder')"
      />
      <button class="useful-btn useful-btn--primary" @click="now">
        {{ t("util.timestamp.now") }}
      </button>
    </div>
    <div v-if="parts" class="grid">
      <div class="tool-field"><span>Unix (s)</span><code class="v">{{ parts.unixSeconds }}</code></div>
      <div class="tool-field"><span>Unix (ms)</span><code class="v">{{ parts.unixMillis }}</code></div>
      <div class="tool-field"><span>ISO 8601</span><code class="v">{{ parts.iso }}</code></div>
      <div class="tool-field"><span>UTC</span><code class="v">{{ parts.utc }}</code></div>
      <div class="tool-field"><span>{{ t("util.timestamp.local") }}</span><code class="v">{{ parts.local }}</code></div>
    </div>
  </ToolShell>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--useful-space-3);
}
.v {
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-sm);
  padding: 8px 10px;
  font-family: var(--useful-font-mono);
  font-size: var(--useful-text-sm);
}
</style>
