<script setup lang="ts">
// 正则测试器：通过 Web Worker 执行，防止灾难性回溯冻结 UI。
import { ref, watch, onUnmounted } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { useRegexWorker } from "@/lib/tools/useRegexWorker";
import { toolErrorMessage } from "@/lib/tools/errors";

const pattern = ref("\\b(\\w+)@(\\w+)\\.(\\w+)\\b");
const flags = ref("gi");
const text = ref(t("util.regexSampleText"));
const timeoutMs = ref(3000);

const matches = ref<{ index: number; match: string; groups: string[] }[]>([]);
const error = ref<string | null>(null);
const timedOut = ref(false);

const { execute, cancel, running } = useRegexWorker();

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function run(): Promise<void> {
  cancel();
  if (!pattern.value.trim()) {
    matches.value = [];
    error.value = null;
    return;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const resp = await execute(
      pattern.value,
      flags.value,
      text.value,
      "test",
      undefined,
      timeoutMs.value,
    );
    if (resp.ok) {
      matches.value = resp.matches ?? [];
      error.value = null;
      timedOut.value = false;
    } else {
      matches.value = [];
      error.value = resp.error ? toolErrorMessage(resp.error) : t("util.regexUnknownError");
      timedOut.value = resp.timedOut ?? false;
    }
  }, 200);
}

watch([pattern, flags, text, timeoutMs], run, { immediate: true });

function handleCancel(): void {
  cancel();
  matches.value = [];
  error.value = t("util.regexCancelled");
  running.value = false;
}

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  cancel();
});
</script>

<template>
  <ToolShell :title="t('util.regex.name')" :description="t('util.regex.desc')" :error="error">
    <div class="tool-row">
      <span class="slash">/</span>
      <input
        v-model="pattern"
        class="useful-input useful-mono"
        style="flex: 1; min-width: 200px"
        :placeholder="t('util.regex.pattern')"
        spellcheck="false"
      />
      <span class="slash">/</span>
      <input
        v-model="flags"
        class="useful-input useful-mono"
        style="width: 80px"
        placeholder="gim"
        spellcheck="false"
      />
    </div>
    <div class="tool-io tool-io--single">
      <textarea
        v-model="text"
        class="useful-input tool-pane"
        style="min-height: 140px"
        :placeholder="t('util.regex.testText')"
        spellcheck="false"
      />
    </div>
    <div class="tool-row tool-row--info">
      <span class="count">
        {{ t("util.regex.matchCount", { count: matches.length }) }}
      </span>
      <label class="tool-opt tool-opt--inline">
        {{ t("util.regex.timeout") }}
        <input
          v-model.number="timeoutMs"
          class="useful-input useful-mono"
          type="number"
          min="500"
          max="30000"
          step="500"
          style="width: 90px"
        />
        ms
      </label>
      <button v-if="running" class="useful-btn useful-btn--ghost" @click="handleCancel">
        <AppIcon name="x" :size="16" /> {{ t("util.regex.cancel") }}
      </button>
      <span v-if="running" class="running-badge">
        <AppIcon name="loader" :size="14" /> {{ t("util.regex.running") }}
      </span>
    </div>
    <p v-if="timedOut" class="warn">
      <AppIcon name="alert" :size="14" /> {{ t("util.regex.redosWarn") }}
    </p>
    <div class="list">
      <div v-for="(m, i) in matches" :key="i" class="row">
        <span class="idx">@{{ m.index }}</span>
        <code class="v useful-mono">{{ m.match }}</code>
        <span v-if="m.groups.length" class="groups">
          {{ t("util.regex.groups") }}: {{ m.groups.join(" · ") }}
        </span>
      </div>
    </div>
  </ToolShell>
</template>

<style scoped>
.slash {
  color: var(--useful-text-tertiary);
  font-family: var(--useful-font-mono);
}
.count {
  font-size: var(--useful-text-sm);
  color: var(--useful-text-secondary);
}
.tool-row--info {
  align-items: center;
  gap: var(--useful-space-3);
  flex-wrap: wrap;
}
.tool-opt--inline {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--useful-text-sm);
  color: var(--useful-text-secondary);
}
.running-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--useful-text-sm);
  color: var(--useful-accent);
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.warn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--useful-text-xs);
  color: var(--useful-warning, var(--useful-text-tertiary));
  margin: 0;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  flex-wrap: wrap;
}
.idx {
  color: var(--useful-text-tertiary);
  font-family: var(--useful-font-mono);
  font-size: var(--useful-text-xs);
  min-width: 48px;
}
.v {
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-sm);
  padding: 4px 8px;
}
.groups {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-secondary);
}
</style>
