<script setup lang="ts">
import { ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { uuidBatch } from "@/lib/tools/transforms";
import { useClipboard } from "@/lib/tools/useClipboard";

const count = ref(5);
const list = ref<string[]>(uuidBatch(5));
const { copied, copy } = useClipboard();

function regenerate(): void {
  list.value = uuidBatch(count.value);
}
</script>

<template>
  <ToolShell :title="t('util.uuid.name')" :description="t('util.uuid.desc')">
    <div class="tool-row">
      <label class="tool-opt">
        {{ t("util.uuid.count") }}
        <input
          v-model.number="count"
          class="useful-input"
          type="number"
          min="1"
          max="1000"
          style="width: 90px"
        />
      </label>
      <button class="useful-btn useful-btn--primary" @click="regenerate">
        <AppIcon name="refresh" :size="16" />{{ t("util.uuid.generate") }}
      </button>
      <button class="useful-btn" :disabled="!list.length" @click="copy(list.join('\n'))">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
        {{ copied ? t("util.copied") : t("util.copyAll") }}
      </button>
    </div>
    <div class="tool-io tool-io--single">
      <pre class="tool-pane tool-pane--out useful-mono">{{ list.join("\n") }}</pre>
    </div>
  </ToolShell>
</template>
