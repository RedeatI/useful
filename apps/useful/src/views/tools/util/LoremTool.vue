<script setup lang="ts">
import { ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { loremIpsum } from "@/lib/tools/text";
import { useClipboard } from "@/lib/tools/useClipboard";

const paragraphs = ref(3);
const output = ref(loremIpsum(3));
const { copied, copy } = useClipboard();

function regenerate(): void {
  output.value = loremIpsum(paragraphs.value);
}
</script>

<template>
  <ToolShell :title="t('util.lorem.name')" :description="t('util.lorem.desc')">
    <div class="tool-row">
      <label class="tool-opt">
        {{ t("util.lorem.paragraphs") }}
        <input
          v-model.number="paragraphs"
          class="useful-input"
          type="number"
          min="1"
          max="50"
          style="width: 90px"
          @input="regenerate"
        />
      </label>
      <button class="useful-btn useful-btn--primary" @click="regenerate">
        <AppIcon name="refresh" :size="16" />{{ t("util.lorem.generate") }}
      </button>
      <button class="useful-btn" :disabled="!output" @click="copy(output)">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
        {{ copied ? t("util.copied") : t("util.copy") }}
      </button>
    </div>
    <div class="tool-io tool-io--single">
      <pre class="tool-pane tool-pane--out">{{ output }}</pre>
    </div>
  </ToolShell>
</template>
