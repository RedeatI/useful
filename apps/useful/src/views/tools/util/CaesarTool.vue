<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { caesar } from "@/lib/tools/convert";
import { useClipboard } from "@/lib/tools/useClipboard";

const input = ref("");
const shift = ref(13);
const { copied, copy } = useClipboard();

const output = computed(() => caesar(input.value, shift.value));
</script>

<template>
  <ToolShell :title="t('util.caesar.name')" :description="t('util.caesar.desc')">
    <div class="tool-row">
      <label class="tool-opt">
        {{ t("util.caesar.shift") }}
        <input v-model.number="shift" class="useful-input" type="number" min="-25" max="25" style="width: 90px" />
      </label>
      <button class="useful-btn" @click="shift = 13">ROT13</button>
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
