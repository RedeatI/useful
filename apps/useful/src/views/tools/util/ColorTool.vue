<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { parseHex, rgbToHex, rgbToHsl, type Rgb } from "@/lib/tools/transforms";

const hex = ref("#3b82f6");

const rgbResult = computed<{ value: Rgb | null; error: string | null }>(() => {
  const parsed = parseHex(hex.value);
  if (!parsed) {
    return {
      value: null,
      error: hex.value.trim() ? t("util.color.invalid") : null,
    };
  }
  return { value: parsed, error: null };
});
const rgb = computed(() => rgbResult.value.value);
const error = computed(() => rgbResult.value.error);

const normalizedHex = computed(() => (rgb.value ? rgbToHex(rgb.value) : ""));
const hsl = computed(() => (rgb.value ? rgbToHsl(rgb.value) : null));
const rgbCss = computed(() =>
  rgb.value ? `rgb(${rgb.value.r}, ${rgb.value.g}, ${rgb.value.b})` : "",
);
const hslCss = computed(() =>
  hsl.value ? `hsl(${hsl.value.h}, ${hsl.value.s}%, ${hsl.value.l}%)` : "",
);
</script>

<template>
  <ToolShell :title="t('util.color.name')" :description="t('util.color.desc')" :error="error">
    <div class="tool-row">
      <input v-model="hex" type="color" class="picker" :aria-label="t('util.color.name')" />
      <input
        v-model="hex"
        class="useful-input useful-mono"
        style="width: 160px"
        placeholder="#3b82f6"
      />
    </div>
    <div v-if="rgb" class="preview" :style="{ background: normalizedHex }" />
    <div v-if="rgb" class="grid">
      <div class="tool-field"><span>HEX</span><code class="v useful-mono">{{ normalizedHex }}</code></div>
      <div class="tool-field"><span>RGB</span><code class="v useful-mono">{{ rgbCss }}</code></div>
      <div class="tool-field"><span>HSL</span><code class="v useful-mono">{{ hslCss }}</code></div>
    </div>
  </ToolShell>
</template>

<style scoped>
.picker {
  width: 48px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--useful-border-strong);
  border-radius: var(--useful-radius-md);
  background: transparent;
  cursor: pointer;
}
.preview {
  height: 72px;
  border-radius: var(--useful-radius-md);
  border: 1px solid var(--useful-border);
}
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
}
</style>
