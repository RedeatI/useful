<script setup lang="ts">
import { ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { randomInts } from "@/lib/tools/convert";
import { useClipboard } from "@/lib/tools/useClipboard";
import { toolErrorMessage } from "@/lib/tools/errors";

const min = ref(1);
const max = ref(100);
const count = ref(1);
const output = ref<number[]>([]);
const error = ref<string | null>(null);
const { copied, copy } = useClipboard();

function generate(): void {
  error.value = null;
  try {
    output.value = randomInts(min.value, max.value, count.value);
  } catch (e) {
    error.value = toolErrorMessage(e);
    output.value = [];
  }
}
generate();
</script>

<template>
  <ToolShell
    :title="t('util.random.name')"
    :description="t('util.random.desc')"
    :error="error"
  >
    <div class="tool-row">
      <label class="tool-opt">{{ t("util.random.min") }}
        <input v-model.number="min" class="useful-input" type="number" style="width: 110px" /></label>
      <label class="tool-opt">{{ t("util.random.max") }}
        <input v-model.number="max" class="useful-input" type="number" style="width: 110px" /></label>
      <label class="tool-opt">{{ t("util.random.count") }}
        <input v-model.number="count" class="useful-input" type="number" min="1" max="1000" style="width: 90px" /></label>
      <button class="useful-btn useful-btn--primary" @click="generate">
        <AppIcon name="refresh" :size="16" />{{ t("util.random.generate") }}
      </button>
      <button class="useful-btn" :disabled="!output.length" @click="copy(output.join('\n'))">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
        {{ copied ? t("util.copied") : t("util.copyAll") }}
      </button>
    </div>
    <div class="tool-io tool-io--single">
      <pre class="tool-pane tool-pane--out useful-mono">{{ output.join("\n") }}</pre>
    </div>
  </ToolShell>
</template>
