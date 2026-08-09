<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { textToHex, hexToText } from "@/lib/tools/text";
import { useClipboard } from "@/lib/tools/useClipboard";
import { toolErrorMessage } from "@/lib/tools/errors";

const input = ref("");
const mode = ref<"encode" | "decode">("encode");
const { copied, copy } = useClipboard();

const result = computed<{ value: string; error: string | null }>(() => {
  if (!input.value) return { value: "", error: null };
  try {
    const value =
      mode.value === "encode" ? textToHex(input.value) : hexToText(input.value);
    return { value, error: null };
  } catch (e) {
    return { value: "", error: toolErrorMessage(e) };
  }
});
const output = computed(() => result.value.value);
const error = computed(() => result.value.error);
</script>

<template>
  <ToolShell :title="t('util.hexText.name')" :description="t('util.hexText.desc')" :error="error">
    <div class="tool-row">
      <div class="tool-seg">
        <button
          class="tool-seg__btn"
          :class="{ 'tool-seg__btn--active': mode === 'encode' }"
          @click="mode = 'encode'"
        >
          {{ t("util.hexText.toHex") }}
        </button>
        <button
          class="tool-seg__btn"
          :class="{ 'tool-seg__btn--active': mode === 'decode' }"
          @click="mode = 'decode'"
        >
          {{ t("util.hexText.fromHex") }}
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
        :placeholder="mode === 'encode' ? t('util.inputPlaceholder') : '48 65 6c 6c 6f'"
        spellcheck="false"
      />
      <pre class="tool-pane tool-pane--out useful-mono">{{ output }}</pre>
    </div>
  </ToolShell>
</template>
