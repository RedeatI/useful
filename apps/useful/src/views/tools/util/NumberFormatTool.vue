<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { formatNumber, toScientific } from "@/lib/tools/convert";
import { useClipboard } from "@/lib/tools/useClipboard";
import { toolErrorMessage } from "@/lib/tools/errors";

const input = ref("1234567.891");
const decimals = ref<number | "">(2);
const { copied, copy } = useClipboard();

const result = computed<{ grouped: string; sci: string; error: string | null }>(() => {
  if (!input.value.trim()) return { grouped: "", sci: "", error: null };
  try {
    const d = decimals.value === "" ? null : Number(decimals.value);
    return {
      grouped: formatNumber(input.value, d),
      sci: toScientific(input.value),
      error: null,
    };
  } catch (e) {
    return { grouped: "", sci: "", error: toolErrorMessage(e) };
  }
});
</script>

<template>
  <ToolShell
    :title="t('util.numberFormat.name')"
    :description="t('util.numberFormat.desc')"
    :error="result.error"
  >
    <div class="tool-row">
      <input
        v-model="input"
        class="useful-input useful-mono"
        style="flex: 1; min-width: 200px"
        :placeholder="t('util.numberFormat.placeholder')"
      />
      <label class="tool-opt">
        {{ t("util.numberFormat.decimals") }}
        <input v-model="decimals" class="useful-input" type="number" min="0" max="20" style="width: 80px" />
      </label>
    </div>
    <div class="grid">
      <div class="tool-field">
        <span>{{ t("util.numberFormat.grouped") }}</span>
        <div class="v-row">
          <code class="v useful-mono">{{ result.grouped || "—" }}</code>
          <button class="useful-btn useful-btn--ghost" :disabled="!result.grouped" @click="copy(result.grouped)">
            <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
          </button>
        </div>
      </div>
      <div class="tool-field">
        <span>{{ t("util.numberFormat.scientific") }}</span>
        <code class="v useful-mono">{{ result.sci || "—" }}</code>
      </div>
    </div>
  </ToolShell>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--useful-space-3);
}
.v-row {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
}
.v {
  flex: 1;
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-sm);
  padding: 8px 10px;
  overflow-wrap: anywhere;
}
</style>
