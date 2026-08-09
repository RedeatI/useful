<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { convertUnit, UNIT_OPTIONS, type UnitKind } from "@/lib/tools/convert";
import { toolErrorMessage } from "@/lib/tools/errors";

const kind = ref<UnitKind>("length");
const value = ref("1");
const from = ref("m");
const to = ref("ft");

const units = computed(() => UNIT_OPTIONS[kind.value]);

function onKindChange(): void {
  from.value = units.value[0];
  to.value = units.value[1] ?? units.value[0];
}

const result = computed<{ value: string; error: string | null }>(() => {
  const n = Number(value.value);
  if (value.value.trim() === "" || Number.isNaN(n)) {
    return { value: "", error: value.value.trim() ? t("util.unit.invalid") : null };
  }
  try {
    const out = convertUnit(kind.value, n, from.value, to.value);
    return { value: String(Math.round(out * 1e6) / 1e6), error: null };
  } catch (e) {
    return { value: "", error: toolErrorMessage(e) };
  }
});
</script>

<template>
  <ToolShell :title="t('util.unit.name')" :description="t('util.unit.desc')" :error="result.error">
    <div class="tool-row">
      <div class="tool-seg">
        <button
          v-for="k in (['length', 'weight', 'temperature'] as UnitKind[])"
          :key="k"
          class="tool-seg__btn"
          :class="{ 'tool-seg__btn--active': kind === k }"
          @click="kind = k; onKindChange()"
        >
          {{ t(`util.unit.${k}`) }}
        </button>
      </div>
    </div>
    <div class="tool-row">
      <input v-model="value" class="useful-input useful-mono" type="number" style="width: 160px" />
      <select v-model="from" class="useful-input">
        <option v-for="u in units" :key="u" :value="u">{{ u }}</option>
      </select>
      <span>→</span>
      <select v-model="to" class="useful-input">
        <option v-for="u in units" :key="u" :value="u">{{ u }}</option>
      </select>
      <code class="result useful-mono">{{ result.value || "—" }}</code>
    </div>
  </ToolShell>
</template>

<style scoped>
.result {
  font-size: var(--useful-text-lg);
  font-weight: 700;
  color: var(--useful-accent);
  padding: 6px 10px;
}
</style>
