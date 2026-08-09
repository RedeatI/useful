<script setup lang="ts">
import { computed, ref } from "vue";
import { runBrowserAction } from "@useful/action-runtime/browser";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";

type DiffOutput = { summary: { added: number; removed: number; unchanged: number; hunks: number }; text: string };

const before = ref("");
const after = ref("");
const context = ref(3);

const result = computed<{ output: DiffOutput | null; error: string | null }>(() => {
  if (!before.value && !after.value) return { output: null, error: null };
  try {
    return {
      output: runBrowserAction("builtin.utilities.text-diff", { before: before.value, after: after.value, context: context.value }) as DiffOutput,
      error: null,
    };
  } catch {
    return { output: null, error: t("util.textDiff.limit") };
  }
});

const output = computed(() => result.value.output?.text ?? "");
</script>

<template>
  <ToolShell
    :title="t('util.textDiff.name')"
    :description="t('util.textDiff.desc')"
    :error="result.error"
    :output="output"
    :capabilities="{ copy: true }"
  >
    <div class="tool-row">
      <label class="tool-opt">
        {{ t("util.textDiff.context") }}
        <input v-model.number="context" class="useful-input diff-context" type="number" min="0" max="10" />
      </label>
      <span v-if="result.output" class="diff-summary">
        <b class="diff-add">+{{ result.output.summary.added }}</b>
        <b class="diff-remove">−{{ result.output.summary.removed }}</b>
        {{ t("util.textDiff.unchanged", { count: result.output.summary.unchanged }) }}
      </span>
    </div>
    <div class="diff-inputs">
      <label><span>{{ t("util.textDiff.before") }}</span><textarea v-model="before" class="useful-input useful-mono" spellcheck="false" /></label>
      <label><span>{{ t("util.textDiff.after") }}</span><textarea v-model="after" class="useful-input useful-mono" spellcheck="false" /></label>
    </div>
    <pre class="diff-output useful-mono">{{ output || t("util.textDiff.identical") }}</pre>
  </ToolShell>
</template>

<style scoped>
.diff-context { width: 72px; }
.diff-summary { display: inline-flex; gap: 10px; color: var(--useful-text-secondary); }
.diff-add { color: var(--useful-success, #16a34a); }.diff-remove { color: var(--useful-danger); }
.diff-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: var(--useful-space-3); }
.diff-inputs label { display: grid; gap: 6px; color: var(--useful-text-secondary); font-size: var(--useful-text-sm); }
.diff-inputs textarea { min-height: 180px; resize: vertical; }
.diff-output { min-height: 140px; overflow: auto; white-space: pre; margin: 0; padding: 10px 12px; background: var(--useful-bg-layer); border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); }
@media (max-width: 760px) { .diff-inputs { grid-template-columns: 1fr; } }
</style>
