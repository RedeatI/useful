<script setup lang="ts">
// 实用工具通用外壳：标题 + 描述 + 错误条 + 能力工具栏 + 内容插槽。
// 工具通过 capabilities 声明决定显示哪些操作（copy/clear/swap/file IO/stats 等）。
// 不把所有逻辑写入一个巨大组件，工具核心逻辑保持纯函数或独立 Worker。
import { computed, ref } from "vue";
import { t } from "@/i18n";
import AppIcon from "@/components/AppIcon.vue";

export interface ToolShellCapabilities {
  clear?: boolean;
  copy?: boolean;
  swap?: boolean;
  loadFile?: boolean;
  saveFile?: boolean;
  examples?: boolean;
  inputStats?: boolean;
  processingTime?: boolean;
}

const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    error?: string | null;
    capabilities?: ToolShellCapabilities;
    /** 输出文本（用于 copy/save） */
    output?: string;
    /** 输入文本（用于 stats/clear/swap） */
    input?: string;
    /** 处理耗时 ms */
    processingMs?: number;
  }>(),
  {
    description: "",
    error: null,
    capabilities: () => ({}) as ToolShellCapabilities,
    output: "",
    input: "",
    processingMs: 0,
  },
);

const emit = defineEmits<{
  clear: [];
  copy: [text: string];
  swap: [];
  loadFile: [content: string, fileName: string];
  saveFile: [text: string];
  loadExample: [];
}>();

const copied = ref(false);

// 统一复制
async function doCopy(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1200);
    emit("copy", text);
  } catch {
    // 剪贴板不可用
  }
}

// 统一清空
function doClear(): void {
  emit("clear");
}

// 交换输入输出
function doSwap(): void {
  emit("swap");
}

// 从文件载入
function onFileLoad(e: Event): void {
  const target = e.target as HTMLInputElement;
  if (!target.files?.[0]) return;
  const file = target.files[0];
  const reader = new FileReader();
  reader.onload = () => {
    const content = reader.result as string;
    emit("loadFile", content, file.name);
  };
  reader.readAsText(file);
}

// 保存到文件
function doSave(): void {
  emit("saveFile", props.output);
}

// 输入统计
const inputStats = computed(() => {
  const text = props.input ?? "";
  return {
    chars: text.length,
    bytes: new TextEncoder().encode(text).length,
    lines: text ? text.split("\n").length : 0,
  };
});

// 示例按钮
function loadExample(): void {
  emit("loadExample");
}
</script>

<template>
  <div class="tool-shell">
    <header class="tool-shell__head">
      <div class="tool-shell__titles">
        <h2 class="tool-shell__title">{{ title }}</h2>
        <p v-if="description" class="tool-shell__desc">{{ description }}</p>
      </div>
      <!-- 能力工具栏 -->
      <div v-if="capabilities" class="tool-shell__actions">
        <button
          v-if="capabilities.clear"
          class="useful-icon-btn"
          :title="t('util.clear')"
          :aria-label="t('util.clear')"
          @click="doClear"
        >
          <AppIcon name="trash" :size="16" />
        </button>
        <button
          v-if="capabilities.copy && output"
          class="useful-icon-btn"
          :title="t('util.copy')"
          :aria-label="copied ? t('util.copied') : t('util.copy')"
          @click="doCopy(output)"
        >
          <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
        </button>
        <button
          v-if="capabilities.swap"
          class="useful-icon-btn"
          :title="t('util.swap')"
          :aria-label="t('util.swap')"
          @click="doSwap"
        >
          <AppIcon name="swap" :size="16" />
        </button>
        <label v-if="capabilities.loadFile" class="useful-icon-btn tool-shell__file" :title="t('util.loadFile')">
          <AppIcon name="upload" :size="16" aria-hidden="true" />
          <span class="tool-shell__sr">{{ t("util.loadFile") }}</span>
          <input class="tool-shell__file-input" type="file" :aria-label="t('util.loadFile')" @change="onFileLoad" />
        </label>
        <button
          v-if="capabilities.saveFile && output"
          class="useful-icon-btn"
          :title="t('util.saveFile')"
          :aria-label="t('util.saveFile')"
          @click="doSave"
        >
          <AppIcon name="save" :size="16" />
        </button>
        <button
          v-if="capabilities.examples"
          class="useful-icon-btn"
          :title="t('util.examples')"
          :aria-label="t('util.examples')"
          @click="loadExample"
        >
          <AppIcon name="file" :size="16" />
        </button>
      </div>
    </header>

    <!-- 输入统计 -->
    <div
      v-if="capabilities.inputStats && input"
      class="tool-shell__stats"
    >
      <span>{{ t("util.charCount", { count: inputStats.chars }) }}</span>
      <span>{{ t("util.byteCount", { count: inputStats.bytes }) }}</span>
      <span>{{ t("util.lineCount", { count: inputStats.lines }) }}</span>
    </div>

    <!-- 处理耗时 -->
    <div
      v-if="capabilities.processingTime && processingMs > 0"
      class="tool-shell__time"
    >
      {{ t("util.processingTime", { ms: processingMs.toFixed(0) }) }}
    </div>

    <p v-if="error" class="tool-shell__error" role="alert">
      {{ t("tools.errorPrefix") }}{{ error }}
    </p>
    <div class="tool-shell__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.tool-shell {
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-3);
  height: 100%;
  min-height: 0;
}
.tool-shell__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--useful-space-3);
}
.tool-shell__titles {
  flex: 1;
  min-width: 0;
}
.tool-shell__title {
  font-size: var(--useful-text-lg);
  font-weight: 700;
  margin: 0;
}
.tool-shell__desc {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
  margin: 4px 0 0;
}
.tool-shell__actions {
  display: flex;
  gap: var(--useful-space-1);
  flex-shrink: 0;
}
.tool-shell__file { position: relative; overflow: hidden; }
.tool-shell__file:focus-within { outline: 2px solid var(--useful-accent); outline-offset: 2px; }
.tool-shell__file-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.tool-shell__sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.tool-shell__stats {
  display: flex;
  gap: var(--useful-space-3);
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  font-family: var(--useful-font-mono);
}
.tool-shell__time {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
}
.tool-shell__error {
  color: var(--useful-danger);
  font-size: var(--useful-text-sm);
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-danger);
  border-radius: var(--useful-radius-md);
  padding: 8px 12px;
  margin: 0;
}
.tool-shell__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-3);
}
</style>
