<script setup lang="ts">
// URL 编解码：使用 ToolShell 能力系统（copy/clear/swap/inputStats）。
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell, { type ToolShellCapabilities } from "@/components/ToolShell.vue";
import { urlEncode, urlDecode } from "@/lib/tools/transforms";
import { toolErrorMessage } from "@/lib/tools/errors";

const input = ref("");
const mode = ref<"encode" | "decode">("encode");

const result = computed<{ value: string; error: string | null }>(() => {
  if (!input.value) return { value: "", error: null };
  try {
    const value =
      mode.value === "encode" ? urlEncode(input.value) : urlDecode(input.value);
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
    :title="t('util.url.name')"
    :description="t('util.url.desc')"
    :error="error"
    :capabilities="capabilities"
    :input="input"
    :output="output"
    @clear="doClear"
    @swap="doSwap"
  >
    <div class="tool-row">
      <div class="tool-seg">
        <button
          class="tool-seg__btn"
          :class="{ 'tool-seg__btn--active': mode === 'encode' }"
          @click="mode = 'encode'"
        >
          {{ t("util.encode") }}
        </button>
        <button
          class="tool-seg__btn"
          :class="{ 'tool-seg__btn--active': mode === 'decode' }"
          @click="mode = 'decode'"
        >
          {{ t("util.decode") }}
        </button>
      </div>
    </div>
    <div class="tool-io">
      <textarea
        v-model="input"
        class="useful-input tool-pane useful-mono"
        :placeholder="t('util.inputPlaceholder')"
        spellcheck="false"
      />
      <pre class="tool-pane tool-pane--out useful-mono">{{ output }}</pre>
    </div>
    <p class="url-privacy">{{ t("util.localProcessing") }}</p>
  </ToolShell>
</template>

<style scoped>
.tool-seg {
  display: inline-flex;
  background: var(--useful-bg-active);
  border-radius: var(--useful-radius-md);
  padding: 2px;
}
.tool-seg__btn {
  border: none;
  background: transparent;
  color: var(--useful-text-secondary);
  padding: 5px 14px;
  border-radius: var(--useful-radius-sm);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--useful-text-sm);
}
.tool-seg__btn--active {
  background: var(--useful-bg-elevated);
  color: var(--useful-text);
  box-shadow: var(--useful-shadow-sm);
}
.url-privacy {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  margin: 0;
}
</style>
