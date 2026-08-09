<script setup lang="ts">
import { computed, ref } from "vue";
import { runBrowserAction } from "@useful/action-runtime/browser";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";

type DataFormatOutput = { text: string; format: "json" | "yaml" };

const operation = ref<"json-to-yaml" | "yaml-to-json">("json-to-yaml");
const input = ref("");
const indent = ref(2);

const result = computed<{ output: DataFormatOutput | null; error: string | null }>(() => {
  if (!input.value) return { output: null, error: null };
  try {
    return {
      output: runBrowserAction("builtin.utilities.data-format", {
        operation: operation.value,
        text: input.value,
        indent: indent.value,
      }) as DataFormatOutput,
      error: null,
    };
  } catch {
    return { output: null, error: t("util.dataFormat.invalid") };
  }
});

const output = computed(() => result.value.output?.text ?? "");

function swap(): void {
  if (output.value) input.value = output.value;
  operation.value = operation.value === "json-to-yaml" ? "yaml-to-json" : "json-to-yaml";
}
</script>

<template>
  <ToolShell
    :title="t('util.dataFormat.name')"
    :description="t('util.dataFormat.desc')"
    :error="result.error"
    :input="input"
    :output="output"
    :capabilities="{ clear: true, copy: true, inputStats: true }"
    @clear="input = ''"
  >
    <div class="tool-row">
      <select v-model="operation" class="useful-input">
        <option value="json-to-yaml">{{ t("util.dataFormat.jsonToYaml") }}</option>
        <option value="yaml-to-json">{{ t("util.dataFormat.yamlToJson") }}</option>
      </select>
      <label class="tool-opt">
        {{ t("util.json.indent") }}
        <select v-model.number="indent" class="useful-input">
          <option :value="2">2</option><option :value="4">4</option><option :value="8">8</option>
        </select>
      </label>
      <button class="useful-btn" :disabled="!input" @click="swap">{{ t("util.swap") }}</button>
    </div>
    <div class="format-io">
      <textarea v-model="input" class="useful-input format-pane useful-mono" :placeholder="t('util.dataFormat.placeholder')" spellcheck="false" />
      <pre class="format-pane format-pane--out useful-mono">{{ output }}</pre>
    </div>
  </ToolShell>
</template>

<style scoped>
.format-io { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: var(--useful-space-3); }
.format-pane { min-height: 300px; height: 100%; resize: none; overflow: auto; white-space: pre; margin: 0; }
.format-pane--out { background: var(--useful-bg-layer); border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); padding: 10px 12px; }
@media (max-width: 760px) { .format-io { grid-template-columns: 1fr; } }
</style>
