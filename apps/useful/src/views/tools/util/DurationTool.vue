<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { durationBetween, type Duration } from "@/lib/tools/convert";
import { toolErrorMessage } from "@/lib/tools/errors";

const from = ref(new Date(Date.now() - 86400000).toISOString().slice(0, 16));
const to = ref(new Date().toISOString().slice(0, 16));

const result = computed<{ value: Duration | null; error: string | null }>(() => {
  try {
    return { value: durationBetween(from.value, to.value), error: null };
  } catch (e) {
    return { value: null, error: toolErrorMessage(e) };
  }
});
const dur = computed(() => result.value.value);
const error = computed(() => result.value.error);
</script>

<template>
  <ToolShell
    :title="t('util.duration.name')"
    :description="t('util.duration.desc')"
    :error="error"
  >
    <div class="tool-row">
      <label class="tool-field"><span>{{ t("util.duration.from") }}</span>
        <input v-model="from" type="datetime-local" class="useful-input" /></label>
      <label class="tool-field"><span>{{ t("util.duration.to") }}</span>
        <input v-model="to" type="datetime-local" class="useful-input" /></label>
    </div>
    <div v-if="dur" class="stats">
      <div class="stat"><span class="stat__v">{{ dur.negative ? "-" : "" }}{{ dur.days }}</span><span class="stat__l">{{ t("util.duration.days") }}</span></div>
      <div class="stat"><span class="stat__v">{{ dur.hours }}</span><span class="stat__l">{{ t("util.duration.hours") }}</span></div>
      <div class="stat"><span class="stat__v">{{ dur.minutes }}</span><span class="stat__l">{{ t("util.duration.minutes") }}</span></div>
      <div class="stat"><span class="stat__v">{{ dur.seconds }}</span><span class="stat__l">{{ t("util.duration.seconds") }}</span></div>
      <div class="stat"><span class="stat__v">{{ dur.negative ? "-" : "" }}{{ dur.totalSeconds }}</span><span class="stat__l">{{ t("util.duration.totalSeconds") }}</span></div>
    </div>
  </ToolShell>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--useful-space-3);
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: var(--useful-space-3);
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-md);
}
.stat__v {
  font-size: var(--useful-text-xl);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat__l {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-secondary);
}
</style>
