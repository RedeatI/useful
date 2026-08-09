<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { unicodeEscape, unicodeUnescape } from "@/lib/tools/convert";
import { useClipboard } from "@/lib/tools/useClipboard";

const input = ref("");
const mode = ref<"escape" | "unescape">("escape");
const { copied, copy } = useClipboard();

const output = computed(() => {
  if (!input.value) return "";
  return mode.value === "escape"
    ? unicodeEscape(input.value)
    : unicodeUnescape(input.value);
});
</script>

<template>
  <ToolShell :title="t('util.unicode.name')" :description="t('util.unicode.desc')">
    <div class="tool-row">
      <div class="tool-seg">
        <button
          class="tool-seg__btn"
          :class="{ 'tool-seg__btn--active': mode === 'escape' }"
          @click="mode = 'escape'"
        >
          {{ t("util.unicode.escape") }}
        </button>
        <button
          class="tool-seg__btn"
          :class="{ 'tool-seg__btn--active': mode === 'unescape' }"
          @click="mode = 'unescape'"
        >
          {{ t("util.unicode.unescape") }}
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
        :placeholder="mode === 'escape' ? t('util.inputPlaceholder') : '\\u4f60\\u597d'"
        spellcheck="false"
      />
      <pre class="tool-pane tool-pane--out useful-mono">{{ output }}</pre>
    </div>
  </ToolShell>
</template>
