<script setup lang="ts">
// 空/加载/错误统一状态占位组件。
import { t } from "@/i18n";
import AppIcon from "./AppIcon.vue";

withDefaults(
  defineProps<{
    variant: "empty" | "loading" | "error";
    title?: string;
    hint?: string;
    retryable?: boolean;
  }>(),
  { title: "", hint: "", retryable: false },
);

defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="state-block" role="status" :aria-busy="variant === 'loading'">
    <div v-if="variant === 'loading'" class="spinner" aria-hidden="true" />
    <AppIcon
      v-else
      :name="variant === 'error' ? 'alert' : 'folder'"
      :size="40"
      class="state-icon"
    />
    <p class="state-title">
      {{ title || t(`state.${variant}Title`) }}
    </p>
    <p class="state-hint">{{ hint || t(`state.${variant}Hint`) }}</p>
    <button v-if="retryable" class="useful-btn" @click="$emit('retry')">
      {{ t("common.retry") }}
    </button>
    <slot />
  </div>
</template>

<style scoped>
.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--useful-space-2);
  padding: var(--useful-space-6);
  text-align: center;
  color: var(--useful-text-secondary);
  min-height: 200px;
}
.state-icon {
  color: var(--useful-text-tertiary);
}
.state-title {
  font-size: var(--useful-text-lg);
  font-weight: 600;
  color: var(--useful-text);
  margin: var(--useful-space-2) 0 0;
}
.state-hint {
  margin: 0;
  max-width: 360px;
}
.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--useful-border-strong);
  border-top-color: var(--useful-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
