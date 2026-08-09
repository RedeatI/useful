<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { processLines, type LineOps } from "@/lib/tools/text";
import { useClipboard } from "@/lib/tools/useClipboard";

const input = ref("");
const ops = ref<LineOps>({
  trim: true,
  dropEmpty: false,
  dedupe: false,
  sort: "none",
  reverse: false,
});
const { copied, copy } = useClipboard();

const output = computed(() => (input.value ? processLines(input.value, ops.value) : ""));
</script>

<template>
  <ToolShell :title="t('util.textLines.name')" :description="t('util.textLines.desc')">
    <div class="tool-row">
      <label class="tool-opt"><input v-model="ops.trim" type="checkbox" /> {{ t("util.textLines.trim") }}</label>
      <label class="tool-opt"><input v-model="ops.dropEmpty" type="checkbox" /> {{ t("util.textLines.dropEmpty") }}</label>
      <label class="tool-opt"><input v-model="ops.dedupe" type="checkbox" /> {{ t("util.textLines.dedupe") }}</label>
      <label class="tool-opt"><input v-model="ops.reverse" type="checkbox" /> {{ t("util.textLines.reverse") }}</label>
      <label class="tool-opt">
        {{ t("util.textLines.sort") }}
        <select v-model="ops.sort" class="useful-input">
          <option value="none">{{ t("util.textLines.sortNone") }}</option>
          <option value="asc">A→Z</option>
          <option value="desc">Z→A</option>
        </select>
      </label>
      <button class="useful-btn" :disabled="!output" @click="copy(output)">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
        {{ copied ? t("util.copied") : t("util.copy") }}
      </button>
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
  </ToolShell>
</template>
