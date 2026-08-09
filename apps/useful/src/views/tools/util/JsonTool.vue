<script setup lang="ts">
// JSON 格式化：使用 ToolShell 能力系统（copy/clear/inputStats）。
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell, { type ToolShellCapabilities } from "@/components/ToolShell.vue";
import { jsonFormat, jsonMinify } from "@/lib/tools/transforms";
import { toolErrorMessage } from "@/lib/tools/errors";

const input = ref("");
const indent = ref(2);

const result = computed<{ value: string; error: string | null }>(() => {
  if (!input.value.trim()) return { value: "", error: null };
  try {
    return { value: jsonFormat(input.value, indent.value), error: null };
  } catch (e) {
    return { value: "", error: toolErrorMessage(e) };
  }
});
const output = computed(() => result.value.value);
const error = computed(() => result.value.error);

const capabilities: ToolShellCapabilities = {
  clear: true,
  copy: true,
  inputStats: true,
};

function doClear(): void {
  input.value = "";
}

function minify(): void {
  try {
    input.value = jsonMinify(input.value);
  } catch {
    /* 错误已由 output 计算展示 */
  }
}
</script>

<template>
  <ToolShell
    :title="t('util.json.name')"
    :description="t('util.json.desc')"
    :error="error"
    :capabilities="capabilities"
    :input="input"
    :output="output"
    @clear="doClear"
  >
    <div class="row">
      <label class="opt">
        {{ t("util.json.indent") }}
        <select v-model.number="indent" class="useful-input">
          <option :value="2">2</option>
          <option :value="4">4</option>
          <option :value="0">Tab/0</option>
        </select>
      </label>
      <button class="useful-btn" @click="minify">{{ t("util.json.minify") }}</button>
    </div>
    <div class="io">
      <textarea
        v-model="input"
        class="useful-input pane useful-mono"
        :placeholder="t('util.json.placeholder')"
        spellcheck="false"
      />
      <pre class="pane pane--out useful-mono">{{ output }}</pre>
    </div>
    <!-- 隐私提示 -->
    <p class="json-privacy">{{ t("util.localProcessing") }}</p>
  </ToolShell>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  flex-wrap: wrap;
}
.opt {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--useful-text-sm);
  color: var(--useful-text-secondary);
}
.io {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--useful-space-3);
}
.pane {
  height: 100%;
  min-height: 260px;
  resize: none;
  overflow: auto;
  white-space: pre;
  margin: 0;
}
.pane--out {
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-md);
  padding: 10px 12px;
}
.json-privacy {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  margin: 0;
}
</style>
