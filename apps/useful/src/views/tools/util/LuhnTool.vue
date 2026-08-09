<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { luhnValidate, luhnCheckDigit } from "@/lib/tools/convert";

const input = ref("");

const valid = computed(() => (input.value.trim() ? luhnValidate(input.value) : null));
const checkDigit = computed(() => {
  const digits = input.value.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || digits.length < 1) return null;
  try {
    return luhnCheckDigit(digits);
  } catch {
    return null;
  }
});
</script>

<template>
  <ToolShell :title="t('util.luhn.name')" :description="t('util.luhn.desc')">
    <div class="tool-row">
      <input
        v-model="input"
        class="useful-input useful-mono"
        style="flex: 1; min-width: 240px"
        :placeholder="t('util.luhn.placeholder')"
        inputmode="numeric"
      />
    </div>
    <div v-if="valid !== null" class="verdict" :class="valid ? 'ok' : 'bad'">
      <AppIcon :name="valid ? 'check' : 'close'" :size="18" />
      {{ valid ? t("util.luhn.valid") : t("util.luhn.invalid") }}
    </div>
    <p v-if="checkDigit !== null" class="hint">
      {{ t("util.luhn.checkDigit", { d: checkDigit }) }}
    </p>
  </ToolShell>
</template>

<style scoped>
.verdict {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--useful-text-lg);
  font-weight: 700;
  padding: 10px 16px;
  border-radius: var(--useful-radius-md);
  width: fit-content;
}
.ok {
  color: var(--useful-success, #16a34a);
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-success, #16a34a);
}
.bad {
  color: var(--useful-danger);
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-danger);
}
.hint {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
  margin: 0;
}
</style>
