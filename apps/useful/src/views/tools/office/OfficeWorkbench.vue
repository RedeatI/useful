<script setup lang="ts">
import AppIcon from "@/components/AppIcon.vue";
import { t } from "@/i18n";
import type { OfficeOutput } from "./officeRuntime";

defineProps<{
  title: string;
  description: string;
  running: boolean;
  error: string | null;
  cancelled: boolean;
  outputs: OfficeOutput[];
  preview: string;
}>();

defineEmits<{
  run: [];
  cancel: [];
  clear: [];
  download: [output: OfficeOutput];
}>();
</script>

<template>
  <section class="office-workbench">
    <header>
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
    </header>
    <div class="office-workbench__body">
      <div class="office-workbench__inputs">
        <slot />
      </div>
      <section class="office-workbench__preview" aria-live="polite">
        <h3>{{ t("office.workbench.resultsTitle") }}</h3>
        <p v-if="running" class="office-state"><AppIcon name="loader" :size="16" /> {{ t("office.workbench.running") }}</p>
        <p v-else-if="error" class="office-state office-state--error" role="alert">{{ error }}</p>
        <p v-else-if="cancelled" class="office-state">{{ t("office.workbench.cancelled") }}</p>
        <pre v-else-if="preview">{{ preview }}</pre>
        <p v-else class="office-state">{{ t("office.workbench.empty") }}</p>
        <div v-if="outputs.length" class="office-workbench__downloads">
          <button
            v-for="output in outputs"
            :key="output.name"
            class="useful-btn"
            type="button"
            @click="$emit('download', output)"
          >
            <AppIcon name="download" :size="15" /> {{ t("office.workbench.download", { name: output.name }) }}
          </button>
        </div>
      </section>
    </div>
    <footer class="office-workbench__actions">
      <button class="useful-btn useful-btn--primary" type="button" :disabled="running" @click="$emit('run')">
        {{ running ? t("office.workbench.processing") : t("office.workbench.run") }}
      </button>
      <button v-if="running" class="useful-btn" type="button" @click="$emit('cancel')">{{ t("common.cancel") }}</button>
      <button class="useful-btn useful-btn--ghost" type="button" @click="$emit('clear')">{{ t("office.workbench.clear") }}</button>
    </footer>
  </section>
</template>

<style scoped>
.office-workbench { display: flex; flex-direction: column; gap: var(--useful-space-4); }
.office-workbench header h2, .office-workbench h3 { margin: 0; }
.office-workbench header p { color: var(--useful-text-secondary); margin: var(--useful-space-1) 0 0; }
.office-workbench__body { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(320px, 1fr); gap: var(--useful-space-4); }
.office-workbench__inputs, .office-workbench__preview { display: flex; flex-direction: column; gap: var(--useful-space-3); min-width: 0; }
.office-workbench__preview { border: 1px solid var(--useful-border); border-radius: var(--useful-radius-lg); padding: var(--useful-space-4); background: var(--useful-bg-layer); }
.office-workbench__preview pre { max-height: 440px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: var(--useful-text-xs)/1.55 var(--useful-font-mono); }
.office-workbench__downloads, .office-workbench__actions { display: flex; flex-wrap: wrap; gap: var(--useful-space-2); }
.office-state { color: var(--useful-text-secondary); display: flex; align-items: center; gap: var(--useful-space-2); }
.office-state--error { color: var(--useful-danger); }
@media (max-width: 900px) { .office-workbench__body { grid-template-columns: 1fr; } }
</style>
