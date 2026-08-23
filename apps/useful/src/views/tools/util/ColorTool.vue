<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { runColorAction, type ColorActionOutput } from "@useful/action-runtime/browser";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";

type CopyFormat = "hex" | "rgb" | "hsl" | "css";
type CopyState = { status: "idle" | "success" | "failure"; format: CopyFormat | null };

const formats = [
  ["hex", "HEX", "util.color.copyHex"],
  ["rgb", "RGB", "util.color.copyRgb"],
  ["hsl", "HSL", "util.color.copyHsl"],
  ["css", "", "util.color.copyCss"],
] as const;

const hex = ref("#3b82f6");
const actionResult = computed<{ output: ColorActionOutput | null; error: string | null }>(() => {
  if (!hex.value.trim()) return { output: null, error: null };
  try {
    return { output: runColorAction({ hex: hex.value }), error: null };
  } catch {
    return { output: null, error: t("util.color.invalid") };
  }
});
const output = computed(() => actionResult.value.output);
const error = computed(() => actionResult.value.error);
const values = computed<Record<CopyFormat, string>>(() => {
  const value = output.value;
  if (!value) return { hex: "", rgb: "", hsl: "", css: "" };
  const rgb = `rgb(${value.rgb.r} ${value.rgb.g} ${value.rgb.b})`;
  const hsl = `hsl(${value.hsl.h} ${value.hsl.s}% ${value.hsl.l}%)`;
  return {
    hex: value.hex,
    rgb,
    hsl,
    css: `--color-hex: ${value.hex};\n--color-rgb: ${rgb};\n--color-hsl: ${hsl};`,
  };
});

const copyState = ref<CopyState>({ status: "idle", format: null });
let copyAttempt = 0;

watch(hex, () => {
  copyAttempt += 1;
  copyState.value = { status: "idle", format: null };
});

const copyMessage = computed(() => {
  if (copyState.value.status === "failure") return t("util.color.copyFailed");
  if (copyState.value.status !== "success" || !copyState.value.format) return "";
  return t("util.color.copySucceeded", {
    format: t(`util.color.formats.${copyState.value.format}`),
  });
});

async function copyFormat(format: CopyFormat): Promise<void> {
  const value = values.value[format];
  if (!value) return;
  const attempt = ++copyAttempt;
  copyState.value = { status: "idle", format: null };
  try {
    await navigator.clipboard.writeText(value);
    if (attempt !== copyAttempt || !output.value) return;
    copyState.value = { status: "success", format };
  } catch {
    if (attempt !== copyAttempt) return;
    copyState.value = { status: "failure", format };
  }
}
</script>

<template>
  <ToolShell :title="t('util.color.name')" :description="t('util.color.desc')" :error="error">
    <div class="tool-row">
      <input
        v-model="hex"
        type="color"
        class="picker"
        :aria-label="t('util.color.pickerLabel')"
        data-testid="color-picker"
      />
      <input
        v-model="hex"
        type="text"
        class="useful-input useful-mono"
        style="width: 160px"
        placeholder="#3b82f6"
        :aria-label="t('util.color.inputLabel')"
        data-testid="color-input"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div
      v-if="output"
      class="preview"
      :style="{ background: output.hex }"
      data-testid="color-preview"
      aria-hidden="true"
    />
    <div class="grid">
      <div
        v-for="[format, label, copyKey] in formats"
        :key="format"
        class="tool-field"
        :class="{ 'color-css-field': format === 'css' }"
      >
        <span>{{ format === "css" ? t("util.color.cssVariables") : label }}</span>
        <component
          :is="format === 'css' ? 'pre' : 'code'"
          class="v useful-mono"
          :data-testid="`color-${format}-value`"
        >{{ values[format] }}</component>
        <button
          type="button"
          class="useful-btn useful-btn--ghost"
          :disabled="!output"
          :aria-label="t(copyKey)"
          :data-testid="`color-copy-${format}`"
          @click="copyFormat(format)"
        >{{ t(copyKey) }}</button>
      </div>
    </div>
    <p
      class="copy-status"
      :class="{ 'copy-status--error': copyState.status === 'failure' }"
      :role="copyState.status === 'failure' ? 'alert' : 'status'"
      aria-live="polite"
      aria-atomic="true"
      data-testid="color-copy-status"
    >{{ copyMessage }}</p>
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
.tool-field {
  align-items: stretch;
}
.v {
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-sm);
  padding: 8px 10px;
}
.color-css-field {
  grid-column: 1 / -1;
}
.color-css-field .v {
  margin: 0;
  white-space: pre-wrap;
}
.copy-status {
  min-height: 1.25em;
  margin: 0;
  color: var(--useful-success);
}
.copy-status--error {
  color: var(--useful-danger);
}
</style>
