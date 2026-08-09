<script setup lang="ts">
// 权限确认对话框：安装时展示全部声明权限；更新时展示新增权限差异。
// 敏感权限（进程启动、网络访问）高亮提示。
import { computed } from "vue";
import { t } from "@/i18n";
import AppIcon from "@/components/AppIcon.vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** install: 全量权限确认；diff: 更新新增权限确认 */
    mode?: "install" | "diff";
    packageName: string;
    permissions: string[];
  }>(),
  { mode: "install" },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const title = computed(() =>
  props.mode === "diff" ? t("shop.permDiffTitle") : t("shop.permInstallTitle"),
);
const hint = computed(() =>
  props.mode === "diff" ? t("shop.permDiffHint") : t("shop.permInstallHint"),
);

function isSensitive(perm: string): boolean {
  return perm === "process.launch.declared" || perm.startsWith("network.fetch:");
}
</script>

<template>
  <div v-if="open" class="perm-dialog__backdrop" role="presentation" @click.self="emit('cancel')">
    <div
      class="perm-dialog useful-card"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      data-testid="perm-dialog"
    >
      <div class="perm-dialog__head">
        <h2 class="perm-dialog__title">{{ title }}</h2>
        <button
          class="useful-btn useful-btn--ghost"
          :aria-label="t('common.close')"
          @click="emit('cancel')"
        >
          <AppIcon name="close" :size="16" />
        </button>
      </div>

      <p class="perm-dialog__pkg useful-mono">{{ packageName }}</p>
      <p class="perm-dialog__hint">{{ hint }}</p>

      <ul v-if="permissions.length" class="perm-dialog__list">
        <li
          v-for="perm in permissions"
          :key="perm"
          class="perm-dialog__item"
          :class="{ 'perm-dialog__item--sensitive': isSensitive(perm) }"
          data-testid="perm-item"
        >
          <AppIcon :name="isSensitive(perm) ? 'alert' : 'puzzle'" :size="16" />
          <span class="useful-mono">{{ perm }}</span>
          <span v-if="isSensitive(perm)" class="useful-badge perm-dialog__sensitive-badge">
            {{ t("shop.permSensitive") }}
          </span>
        </li>
      </ul>
      <p v-else class="perm-dialog__hint">{{ t("shop.noPermissions") }}</p>

      <div class="perm-dialog__actions">
        <button class="useful-btn" data-testid="perm-cancel" @click="emit('cancel')">
          {{ t("common.cancel") }}
        </button>
        <button
          class="useful-btn useful-btn--primary"
          data-testid="perm-confirm"
          @click="emit('confirm')"
        >
          {{ t("shop.permConfirm") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.perm-dialog__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.perm-dialog {
  width: min(480px, 90vw);
  max-height: 80vh;
  overflow: auto;
  padding: var(--useful-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-2);
}
.perm-dialog__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.perm-dialog__title {
  font-size: var(--useful-text-lg);
  font-weight: 600;
}
.perm-dialog__pkg {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
}
.perm-dialog__hint {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
}
.perm-dialog__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-1);
}
.perm-dialog__item {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  padding: var(--useful-space-2);
  border-radius: var(--useful-radius-md);
  background: var(--useful-bg-hover);
  font-size: var(--useful-text-sm);
}
.perm-dialog__item--sensitive {
  background: rgba(196, 43, 28, 0.1);
  color: var(--useful-danger);
}
.perm-dialog__sensitive-badge {
  margin-left: auto;
  color: var(--useful-danger);
}
.perm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--useful-space-2);
  margin-top: var(--useful-space-2);
}
</style>
