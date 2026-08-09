<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { contrastRatio, type ContrastResult } from "@/lib/tools/convert";
import { toolErrorMessage } from "@/lib/tools/errors";

const fg = ref("#333333");
const bg = ref("#ffffff");

const result = computed<{ value: ContrastResult | null; error: string | null }>(() => {
  try {
    return { value: contrastRatio(fg.value, bg.value), error: null };
  } catch (e) {
    return { value: null, error: toolErrorMessage(e) };
  }
});
const r = computed(() => result.value.value);
const error = computed(() => result.value.error);
</script>

<template>
  <ToolShell
    :title="t('util.contrast.name')"
    :description="t('util.contrast.desc')"
    :error="error"
  >
    <div class="tool-row">
      <label class="tool-opt">{{ t("util.contrast.fg") }}
        <input v-model="fg" type="color" class="pick" /><input v-model="fg" class="useful-input useful-mono" style="width: 110px" /></label>
      <label class="tool-opt">{{ t("util.contrast.bg") }}
        <input v-model="bg" type="color" class="pick" /><input v-model="bg" class="useful-input useful-mono" style="width: 110px" /></label>
    </div>
    <div v-if="r" class="sample" :style="{ color: fg, background: bg }">
      {{ t("util.contrast.sample") }}
      <span class="ratio">{{ r.ratio }} : 1</span>
    </div>
    <div v-if="r" class="grid">
      <div class="badge" :class="r.aaNormal ? 'pass' : 'fail'">AA {{ t("util.bodyText") }} {{ r.aaNormal ? "✓" : "✗" }}</div>
      <div class="badge" :class="r.aaLarge ? 'pass' : 'fail'">AA {{ t("util.largeText") }} {{ r.aaLarge ? "✓" : "✗" }}</div>
      <div class="badge" :class="r.aaaNormal ? 'pass' : 'fail'">AAA {{ t("util.bodyText") }} {{ r.aaaNormal ? "✓" : "✗" }}</div>
      <div class="badge" :class="r.aaaLarge ? 'pass' : 'fail'">AAA {{ t("util.largeText") }} {{ r.aaaLarge ? "✓" : "✗" }}</div>
    </div>
  </ToolShell>
</template>

<style scoped>
.pick {
  width: 40px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--useful-border-strong);
  border-radius: var(--useful-radius-sm);
  background: transparent;
  cursor: pointer;
  vertical-align: middle;
}
.sample {
  padding: var(--useful-space-4);
  border-radius: var(--useful-radius-md);
  border: 1px solid var(--useful-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--useful-text-lg);
}
.ratio {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--useful-space-2);
}
.badge {
  padding: 8px 12px;
  border-radius: var(--useful-radius-md);
  font-size: var(--useful-text-sm);
  font-weight: 600;
  text-align: center;
}
.pass {
  color: var(--useful-success, #16a34a);
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-success, #16a34a);
}
.fail {
  color: var(--useful-text-tertiary);
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
}
</style>
