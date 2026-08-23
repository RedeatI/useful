<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { runColorAction, type ColorActionOutput } from "@useful/action-runtime/browser";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";

type CopyFormat = "hex" | "rgb" | "hsl" | "css";
type CopyState = { status: "idle" | "success" | "failure"; format: CopyFormat | null };

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
const rgbCss = computed(() => output.value
  ? `rgb(${output.value.rgb.r} ${output.value.rgb.g} ${output.value.rgb.b})`
  : "");
const hslCss = computed(() => output.value
  ? `hsl(${output.value.hsl.h} ${output.value.hsl.s}% ${output.value.hsl.l}%)`
  : "");
const cssVariables = computed(() => output.value
  ? `--color-hex: ${output.value.hex};\n--color-rgb: ${rgbCss.value};\n--color-hsl: ${hslCss.value};`
  : "");

const copyState = ref<CopyState>({ status: "idle", format: null });
let copyAttempt = 0;

watch(hex, () => {
  copyAttempt += 1;
  copyState.value = { status: "idle", format: null };
});

function copyValue(format: CopyFormat): string {
  if (!output.value) return "";
  if (format === "hex") return output.value.hex;
  if (format === "rgb") return rgbCss.value;
  if (format === "hsl") return hslCss.value;
  return cssVariables.value;
}

const copyMessage = computed(() => {
  if (copyState.value.status === "failure") return t("util.color.copyFailed");
  if (copyState.value.status !== "success" || !copyState.value.format) return "";
  return t("util.color.copySucceeded", {
    format: t(`util.color.formats.${copyState.value.format}`),
  });
});

async function copyFormat(format: CopyFormat): Promise<void> {
  const value = copyValue(format);
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
      <div class="tool-field">
        <span>HEX</span>
        <code class="v useful-mono" data-testid="color-hex-value">{{ output?.hex ?? "" }}</code>
        <button
          type="button"
          class="useful-btn useful-btn--ghost"
          :disabled="!output"
          :aria-label="t('util.color.copyHex')"
          data-testid="color-copy-hex"
          @click="copyFormat('hex')"
        >{{ t("util.color.copyHex") }}</button>
      </div>
      <div class="tool-field">
        <span>RGB</span>
        <code class="v useful-mono" data-testid="color-rgb-value">{{ rgbCss }}</code>
        <button
          type="button"
          class="useful-btn useful-btn--ghost"
          :disabled="!output"
          :aria-label="t('util.color.copyRgb')"
          data-testid="color-copy-rgb"
          @click="copyFormat('rgb')"
        >{{ t("util.color.copyRgb") }}</button>
      </div>
      <div class="tool-field">
        <span>HSL</span>
        <code class="v useful-mono" data-testid="color-hsl-value">{{ hslCss }}</code>
        <button
          type="button"
          class="useful-btn useful-btn--ghost"
          :disabled="!output"
          :aria-label="t('util.color.copyHsl')"
          data-testid="color-copy-hsl"
          @click="copyFormat('hsl')"
        >{{ t("util.color.copyHsl") }}</button>
      </div>
      <div class="tool-field color-css-field">
        <span>{{ t("util.color.cssVariables") }}</span>
        <pre class="v useful-mono" data-testid="color-css-value">{{ cssVariables }}</pre>
        <button
          type="button"
          class="useful-btn useful-btn--ghost"
          :disabled="!output"
          :aria-label="t('util.color.copyCss')"
          data-testid="color-copy-css"
          @click="copyFormat('css')"
        >{{ t("util.color.copyCss") }}</button>
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
