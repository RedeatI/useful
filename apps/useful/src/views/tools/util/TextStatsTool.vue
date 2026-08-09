<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { textStats } from "@/lib/tools/text";

const input = ref("");
const s = computed(() => textStats(input.value));
const items = computed(() => [
  { label: t("util.textStats.chars"), value: s.value.chars },
  { label: t("util.textStats.charsNoSpaces"), value: s.value.charsNoSpaces },
  { label: t("util.textStats.words"), value: s.value.words },
  { label: t("util.textStats.lines"), value: s.value.lines },
  { label: t("util.textStats.bytes"), value: s.value.bytes },
]);
</script>

<template>
  <ToolShell :title="t('util.textStats.name')" :description="t('util.textStats.desc')">
    <div class="tool-io tool-io--single">
      <textarea
        v-model="input"
        class="useful-input tool-pane"
        style="min-height: 160px"
        :placeholder="t('util.inputPlaceholder')"
        spellcheck="false"
      />
    </div>
    <div class="stats">
      <div v-for="it in items" :key="it.label" class="stat">
        <span class="stat__v">{{ it.value }}</span>
        <span class="stat__l">{{ it.label }}</span>
      </div>
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
