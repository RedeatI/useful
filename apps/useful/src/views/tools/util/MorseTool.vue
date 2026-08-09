<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { toMorse, fromMorse } from "@/lib/tools/text";
import { useClipboard } from "@/lib/tools/useClipboard";

const input = ref("");
const mode = ref<"encode" | "decode">("encode");
const { copied, copy } = useClipboard();

const output = computed(() => {
  if (!input.value) return "";
  return mode.value === "encode" ? toMorse(input.value) : fromMorse(input.value);
});
</script>

<template>
  <ToolShell :title="t('util.morse.name')" :description="t('util.morse.desc')">
    <div class="tool-row">
      <div class="tool-seg">
        <button
          class="tool-seg__btn"
          :class="{ 'tool-seg__btn--active': mode === 'encode' }"
          @click="mode = 'encode'"
        >
          {{ t("util.morse.toMorse") }}
        </button>
        <button
          class="tool-seg__btn"
          :class="{ 'tool-seg__btn--active': mode === 'decode' }"
          @click="mode = 'decode'"
        >
          {{ t("util.morse.fromMorse") }}
        </button>
      </div>
      <button class="useful-btn" :disabled="!output" @click="copy(output)">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
        {{ copied ? t("util.copied") : t("util.copy") }}
      </button>
    </div>
    <div class="tool-io">
      <textarea
        v-model="input"
        class="useful-input tool-pane useful-mono"
        :placeholder="mode === 'encode' ? t('util.inputPlaceholder') : '... --- ...'"
        spellcheck="false"
      />
      <pre class="tool-pane tool-pane--out useful-mono">{{ output }}</pre>
    </div>
  </ToolShell>
</template>
