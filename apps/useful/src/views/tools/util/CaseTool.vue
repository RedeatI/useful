<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { convertCase, type CaseStyle } from "@/lib/tools/transforms";
import { useClipboard } from "@/lib/tools/useClipboard";

const input = ref("hello world example");
const { copied, copy } = useClipboard();
const copiedStyle = ref<CaseStyle | null>(null);

const styles: { style: CaseStyle; label: string }[] = [
  { style: "camel", label: "camelCase" },
  { style: "pascal", label: "PascalCase" },
  { style: "snake", label: "snake_case" },
  { style: "kebab", label: "kebab-case" },
  { style: "constant", label: "CONSTANT_CASE" },
  { style: "title", label: "Title Case" },
];

const results = computed(() =>
  styles.map((s) => ({ ...s, value: convertCase(input.value, s.style) })),
);

async function copyOne(style: CaseStyle, value: string): Promise<void> {
  await copy(value);
  copiedStyle.value = style;
  setTimeout(() => (copiedStyle.value = null), 1200);
}
</script>

<template>
  <ToolShell :title="t('util.case.name')" :description="t('util.case.desc')">
    <div class="tool-io tool-io--single">
      <textarea
        v-model="input"
        class="useful-input tool-pane"
        style="min-height: 100px"
        :placeholder="t('util.inputPlaceholder')"
        spellcheck="false"
      />
    </div>
    <div class="list">
      <div v-for="r in results" :key="r.style" class="row">
        <span class="label">{{ r.label }}</span>
        <code class="v useful-mono">{{ r.value || "—" }}</code>
        <button
          class="useful-btn useful-btn--ghost"
          :disabled="!r.value"
          @click="copyOne(r.style, r.value)"
        >
          <AppIcon
            :name="copied && copiedStyle === r.style ? 'check' : 'copy'"
            :size="16"
          />
        </button>
      </div>
    </div>
  </ToolShell>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-2);
}
.row {
  display: grid;
  grid-template-columns: 140px 1fr auto;
  align-items: center;
  gap: var(--useful-space-2);
}
.label {
  font-size: var(--useful-text-sm);
  color: var(--useful-text-secondary);
}
.v {
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-sm);
  padding: 6px 10px;
  overflow-wrap: anywhere;
}
</style>
