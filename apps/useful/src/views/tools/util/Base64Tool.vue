<script setup lang="ts">
// Base64 编解码：使用 ToolShell 能力系统（copy/clear/swap/inputStats）。
// 核心逻辑保持纯函数（transforms.ts），UI 只负责交互。
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell, { type ToolShellCapabilities } from "@/components/ToolShell.vue";
import { base64Encode, base64Decode } from "@/lib/tools/transforms";
import { toolErrorMessage } from "@/lib/tools/errors";

const input = ref("");
const mode = ref<"encode" | "decode">("encode");

const result = computed<{ value: string; error: string | null }>(() => {
  if (!input.value) return { value: "", error: null };
  try {
    const value =
      mode.value === "encode"
        ? base64Encode(input.value)
        : base64Decode(input.value);
    return { value, error: null };
  } catch (e) {
    return { value: "", error: toolErrorMessage(e) };
  }
});
const output = computed(() => result.value.value);
const error = computed(() => result.value.error);

const capabilities: ToolShellCapabilities = {
  clear: true,
  copy: true,
  swap: true,
  inputStats: true,
};

function doClear(): void {
  input.value = "";
}

function doSwap(): void {
  if (!output.value) return;
  input.value = output.value;
  mode.value = mode.value === "encode" ? "decode" : "encode";
}
</script>

<template>
  <ToolShell
    :title="t('util.base64.name')"
    :description="t('util.base64.desc')"
    :error="error"
    :capabilities="capabilities"
    :input="input"
    :output="output"
    @clear="doClear"
    @swap="doSwap"
  >
    <div class="tool-row">
      <div class="seg" role="group" :aria-label="t('util.base64Operations')">
        <button
          class="seg__btn"
          :class="{ 'seg__btn--active': mode === 'encode' }"
          :aria-pressed="mode === 'encode'"
          @click="mode = 'encode'"
        >
          {{ t("util.encode") }}
        </button>
        <button
          class="seg__btn"
          :class="{ 'seg__btn--active': mode === 'decode' }"
          :aria-pressed="mode === 'decode'"
          @click="mode = 'decode'"
        >
          {{ t("util.decode") }}
        </button>
      </div>
    </div>
    <div class="tool-io">
      <div class="tool-pane-output">
        <label class="tool-pane-label" for="base64-input">{{ t("util.inputText") }}</label>
        <textarea
          id="base64-input"
          v-model="input"
          class="useful-input tool-pane useful-mono"
          :placeholder="t('util.inputPlaceholder')"
          spellcheck="false"
        />
      </div>
      <div class="tool-pane-output">
        <span id="base64-output-label" class="tool-pane-label">{{ t("util.outputResult") }}</span>
        <pre class="tool-pane tool-pane--out useful-mono" role="region" aria-labelledby="base64-output-label">{{ output }}</pre>
      </div>
    </div>
    <!-- 隐私提示 -->
    <p class="b64-privacy">
      {{ t("util.localProcessing") }}
    </p>
  </ToolShell>
</template>

<style scoped>
.seg {
  display: inline-flex;
  background: var(--useful-bg-active);
  border-radius: var(--useful-radius-md);
  padding: 2px;
}
.seg__btn {
  border: none;
  background: transparent;
  color: var(--useful-text-secondary);
  padding: 5px 14px;
  border-radius: var(--useful-radius-sm);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--useful-text-sm);
}
.seg__btn--active {
  background: var(--useful-bg-elevated);
  color: var(--useful-text);
  box-shadow: var(--useful-shadow-sm);
}
.b64-privacy {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  margin: 0;
}
.tool-pane-label { font-size: var(--useful-text-sm); font-weight: 600; }
.tool-pane-output { display: flex; flex-direction: column; min-height: 0; gap: var(--useful-space-2); }
</style>
