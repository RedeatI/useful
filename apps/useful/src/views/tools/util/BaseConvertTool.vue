<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { convertBase } from "@/lib/tools/transforms";
import { toolErrorMessage } from "@/lib/tools/errors";

const value = ref("255");
const fromBase = ref(10);

const bases = [
  { base: 2, label: "BIN (2)" },
  { base: 8, label: "OCT (8)" },
  { base: 10, label: "DEC (10)" },
  { base: 16, label: "HEX (16)" },
];

const result = computed<{ values: Record<number, string>; error: string | null }>(
  () => {
    if (!value.value.trim()) return { values: {}, error: null };
    try {
      const values: Record<number, string> = {};
      for (const { base } of bases) {
        values[base] = convertBase(value.value, fromBase.value, base);
      }
      return { values, error: null };
    } catch (e) {
      return { values: {}, error: toolErrorMessage(e) };
    }
  },
);
const results = computed(() => result.value.values);
const error = computed(() => result.value.error);
</script>

<template>
  <ToolShell
    :title="t('util.baseConvert.name')"
    :description="t('util.baseConvert.desc')"
    :error="error"
  >
    <div class="tool-row">
      <label class="tool-opt">
        {{ t("util.baseConvert.from") }}
        <select v-model.number="fromBase" class="useful-input">
          <option v-for="b in bases" :key="b.base" :value="b.base">{{ b.label }}</option>
        </select>
      </label>
      <input
        v-model="value"
        class="useful-input useful-mono"
        style="flex: 1; min-width: 200px"
        :placeholder="t('util.baseConvert.placeholder')"
      />
    </div>
    <div class="grid">
      <div v-for="b in bases" :key="b.base" class="tool-field">
        <span>{{ b.label }}</span>
        <code class="v useful-mono">{{ results[b.base] ?? "—" }}</code>
      </div>
    </div>
  </ToolShell>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
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
