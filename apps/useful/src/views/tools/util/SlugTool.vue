<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { slugify } from "@/lib/tools/text";
import { useClipboard } from "@/lib/tools/useClipboard";

const input = ref("");
const { copied, copy } = useClipboard();
const output = computed(() => slugify(input.value));
</script>

<template>
  <ToolShell :title="t('util.slug.name')" :description="t('util.slug.desc')">
    <div class="tool-row">
      <input
        v-model="input"
        class="useful-input"
        style="flex: 1; min-width: 240px"
        :placeholder="t('util.slug.placeholder')"
      />
      <button class="useful-btn" :disabled="!output" @click="copy(output)">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
        {{ copied ? t("util.copied") : t("util.copy") }}
      </button>
    </div>
    <div class="tool-io tool-io--single">
      <pre class="tool-pane tool-pane--out useful-mono" style="min-height: 60px">{{ output }}</pre>
    </div>
  </ToolShell>
</template>
