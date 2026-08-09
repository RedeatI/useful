<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { humanizeBytes, byteBreakdown } from "@/lib/tools/text";
import { toolErrorMessage } from "@/lib/tools/errors";

const raw = ref("1536000");

const result = computed<{
  human: string;
  rows: { unit: string; value: string }[];
  error: string | null;
}>(() => {
  const n = Number(raw.value);
  if (raw.value.trim() === "" || Number.isNaN(n)) {
    return { human: "", rows: [], error: raw.value.trim() ? t("util.byteSize.invalid") : null };
  }
  try {
    return { human: humanizeBytes(n), rows: byteBreakdown(n), error: null };
  } catch (e) {
    return { human: "", rows: [], error: toolErrorMessage(e) };
  }
});
</script>

<template>
  <ToolShell
    :title="t('util.byteSize.name')"
    :description="t('util.byteSize.desc')"
    :error="result.error"
  >
    <div class="tool-row">
      <input
        v-model="raw"
        class="useful-input useful-mono"
        type="number"
        min="0"
        style="width: 220px"
        :placeholder="t('util.byteSize.placeholder')"
      />
      <span v-if="result.human" class="human">= {{ result.human }}</span>
    </div>
    <div class="grid">
      <div v-for="r in result.rows" :key="r.unit" class="tool-field">
        <span>{{ r.unit }}</span>
        <code class="v useful-mono">{{ r.value }}</code>
      </div>
    </div>
  </ToolShell>
</template>

<style scoped>
.human {
  font-size: var(--useful-text-lg);
  font-weight: 700;
  color: var(--useful-accent);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--useful-space-3);
}
.v {
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-sm);
  padding: 8px 10px;
  overflow-wrap: anywhere;
}
</style>
