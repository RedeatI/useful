<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "@/i18n";
import ToolShell, { type ToolShellCapabilities } from "@/components/ToolShell.vue";
import { jsonFormat, jsonMinify, jsonQuery } from "@/lib/tools/transforms";
import { toolErrorMessage } from "@/lib/tools/errors";
import {
  buildJsonTreeRows,
  visibleJsonTreeRows,
  type JsonValue,
} from "@/lib/tools/jsonExplorer";
import { useClipboard } from "@/lib/tools/useClipboard";

const input = ref("");
const indent = ref(2);
const view = ref<"formatted" | "tree">("formatted");
const treeSearch = ref("");
const pointer = ref("");
const queryRequested = ref(false);
const collapsed = ref<Set<string>>(new Set());
const { copied, copy } = useClipboard();

const formatted = computed<{ value: string; error: string | null }>(() => {
  if (!input.value.trim()) return { value: "", error: null };
  try {
    return { value: jsonFormat(input.value, indent.value), error: null };
  } catch (cause) {
    return { value: "", error: toolErrorMessage(cause) };
  }
});

const parsed = computed<JsonValue | null>(() => {
  if (formatted.value.error || !input.value.trim()) return null;
  return JSON.parse(input.value) as JsonValue;
});

const tree = computed(() => parsed.value === null ? null : buildJsonTreeRows(parsed.value));
const visibleRows = computed(() => tree.value
  ? visibleJsonTreeRows(tree.value.rows, collapsed.value, treeSearch.value)
  : []);

const query = computed<{ value: string; error: string | null }>(() => {
  if (!queryRequested.value) return { value: "", error: null };
  try {
    return { value: jsonQuery(input.value, pointer.value, indent.value), error: null };
  } catch (cause) {
    return { value: "", error: toolErrorMessage(cause) };
  }
});

const output = computed(() => queryRequested.value && !query.value.error
  ? query.value.value
  : formatted.value.value);
const error = computed(() => formatted.value.error);

const capabilities: ToolShellCapabilities = {
  clear: true,
  copy: true,
  inputStats: true,
};

watch([input, pointer, indent], () => {
  queryRequested.value = false;
});

function doClear(): void {
  input.value = "";
  treeSearch.value = "";
  pointer.value = "";
  queryRequested.value = false;
  collapsed.value = new Set();
}

function minify(): void {
  if (!input.value.trim()) return;
  try {
    input.value = jsonMinify(input.value);
  } catch {
    // The shared formatted error remains the single parse-error surface.
  }
}

function toggle(pointerValue: string): void {
  const next = new Set(collapsed.value);
  if (next.has(pointerValue)) next.delete(pointerValue);
  else next.add(pointerValue);
  collapsed.value = next;
}

function runPointerQuery(): void {
  queryRequested.value = true;
}
</script>

<template>
  <ToolShell
    :title="t('util.json.name')"
    :description="t('util.json.desc')"
    :error="error"
    :capabilities="capabilities"
    :input="input"
    :output="output"
    @clear="doClear"
  >
    <div class="json-toolbar">
      <label class="json-option">
        {{ t("util.json.indent") }}
        <select v-model.number="indent" class="useful-input">
          <option :value="2">2</option>
          <option :value="4">4</option>
          <option :value="0">0</option>
        </select>
      </label>
      <button class="useful-btn" @click="minify">{{ t("util.json.minify") }}</button>
      <div class="json-segments" role="group" :aria-label="t('util.json.viewMode')">
        <button
          class="json-segments__button"
          :class="{ 'json-segments__button--active': view === 'formatted' }"
          :aria-pressed="view === 'formatted'"
          @click="view = 'formatted'"
        >
          {{ t("util.json.formatted") }}
        </button>
        <button
          class="json-segments__button"
          :class="{ 'json-segments__button--active': view === 'tree' }"
          :aria-pressed="view === 'tree'"
          data-testid="json-tree-tab"
          @click="view = 'tree'"
        >
          {{ t("util.json.tree") }}
        </button>
      </div>
    </div>

    <div class="json-io">
      <label class="json-pane-wrap">
        <span class="json-pane-label">{{ t("util.inputText") }}</span>
        <textarea
          v-model="input"
          class="useful-input json-pane useful-mono"
          :placeholder="t('util.json.placeholder')"
          spellcheck="false"
          data-testid="json-input"
        />
      </label>

      <section v-if="view === 'formatted'" class="json-pane-wrap" :aria-label="t('util.json.formatted')">
        <span class="json-pane-label">{{ t("util.outputResult") }}</span>
        <pre class="json-pane json-pane--out useful-mono">{{ formatted.value }}</pre>
      </section>

      <section v-else class="json-explorer" :aria-label="t('util.json.tree')">
        <div class="json-explorer__controls">
          <label class="json-field">
            <span>{{ t("util.json.treeSearch") }}</span>
            <input
              v-model="treeSearch"
              class="useful-input"
              type="search"
              :placeholder="t('util.json.treeSearchPlaceholder')"
              data-testid="json-tree-search"
            />
          </label>
          <div class="json-query-row">
            <label class="json-field json-field--grow">
              <span>{{ t("util.json.pointer") }}</span>
              <input
                v-model="pointer"
                class="useful-input useful-mono"
                :placeholder="t('util.json.pointerPlaceholder')"
                data-testid="json-pointer"
              />
            </label>
            <button class="useful-btn json-query-button" data-testid="json-query" @click="runPointerQuery">
              {{ t("util.json.query") }}
            </button>
          </div>
        </div>

        <p v-if="copied" class="json-copy-status" role="status">{{ t("util.copied") }}</p>
        <p v-if="tree?.truncated" class="json-warning" role="status">{{ t("util.json.treeTruncated") }}</p>
        <p v-if="query.error" class="json-query-error" role="alert">{{ query.error }}</p>
        <div v-if="queryRequested && !query.error" class="json-query-result">
          <span class="json-pane-label">{{ t("util.json.queryResult") }}</span>
          <pre class="useful-mono" data-testid="json-query-result">{{ query.value }}</pre>
        </div>

        <div class="json-tree" role="tree" :aria-label="t('util.json.tree')">
          <div
            v-for="row in visibleRows"
            :key="row.pointer"
            class="json-tree__row"
            role="treeitem"
            :aria-level="row.depth + 1"
            :aria-expanded="row.hasChildren ? !collapsed.has(row.pointer) : undefined"
            :style="{ paddingInlineStart: `${row.depth * 16 + 6}px` }"
          >
            <button
              v-if="row.hasChildren"
              class="json-tree__toggle"
              :aria-label="collapsed.has(row.pointer) ? t('util.json.expand') : t('util.json.collapse')"
              @click="toggle(row.pointer)"
            >
              {{ collapsed.has(row.pointer) ? "▸" : "▾" }}
            </button>
            <span v-else class="json-tree__toggle" aria-hidden="true">·</span>
            <strong class="json-tree__key useful-mono">{{ row.key }}</strong>
            <span class="json-tree__kind">{{ row.kind }}</span>
            <code class="json-tree__preview useful-mono">{{ row.preview }}</code>
            <button
              v-if="row.pointer"
              class="json-tree__path useful-mono"
              :title="t('util.json.copyPointer')"
              :aria-label="t('util.json.copyPointer')"
              data-testid="json-copy-pointer"
              @click="copy(row.pointer)"
            >
              {{ row.pointer }}
            </button>
          </div>
        </div>
      </section>
    </div>
    <p class="json-privacy">{{ t("util.localProcessing") }}</p>
  </ToolShell>
</template>

<style scoped>
.json-toolbar { display: flex; align-items: center; gap: var(--useful-space-2); flex-wrap: wrap; }
.json-option, .json-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--useful-text-sm); color: var(--useful-text-secondary); }
.json-option { flex-direction: row; align-items: center; }
.json-segments { display: inline-flex; padding: 2px; border-radius: var(--useful-radius-md); background: var(--useful-bg-active); }
.json-segments__button { border: 0; border-radius: var(--useful-radius-sm); background: transparent; color: var(--useful-text-secondary); cursor: pointer; padding: 5px 12px; }
.json-segments__button--active { background: var(--useful-bg-elevated); color: var(--useful-text); box-shadow: var(--useful-shadow-sm); }
.json-io { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--useful-space-3); }
.json-pane-wrap { display: flex; min-height: 0; flex-direction: column; gap: var(--useful-space-2); }
.json-pane-label { font-size: var(--useful-text-sm); font-weight: 600; }
.json-pane { height: 100%; min-height: 280px; margin: 0; overflow: auto; resize: none; white-space: pre; }
.json-pane--out { padding: 10px 12px; border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); background: var(--useful-bg-layer); }
.json-explorer { display: flex; min-height: 0; flex-direction: column; gap: var(--useful-space-2); }
.json-explorer__controls { display: grid; gap: var(--useful-space-2); }
.json-query-row { display: flex; align-items: end; gap: var(--useful-space-2); }
.json-field--grow { flex: 1; min-width: 0; }
.json-query-button { flex: 0 0 auto; }
.json-tree { min-height: 180px; overflow: auto; border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); background: var(--useful-bg-layer); }
.json-tree__row { display: flex; min-height: 30px; align-items: center; gap: 7px; padding-block: 3px; padding-right: 6px; border-bottom: 1px solid var(--useful-border); }
.json-tree__row:last-child { border-bottom: 0; }
.json-tree__toggle { width: 22px; flex: 0 0 22px; padding: 0; border: 0; background: transparent; color: var(--useful-text-secondary); cursor: pointer; }
span.json-tree__toggle { text-align: center; cursor: default; }
.json-tree__key { color: var(--useful-text); }
.json-tree__kind { padding: 1px 5px; border-radius: 999px; background: var(--useful-bg-active); color: var(--useful-text-tertiary); font-size: 10px; }
.json-tree__preview { min-width: 0; overflow: hidden; color: var(--useful-text-secondary); text-overflow: ellipsis; white-space: nowrap; }
.json-tree__path { margin-left: auto; max-width: 44%; overflow: hidden; padding: 2px 5px; border: 0; background: transparent; color: var(--useful-accent); cursor: pointer; text-overflow: ellipsis; white-space: nowrap; }
.json-copy-status, .json-warning, .json-query-error { margin: 0; font-size: var(--useful-text-xs); }
.json-copy-status { color: var(--useful-success); }
.json-warning, .json-query-error { color: var(--useful-warning); }
.json-query-result { max-height: 150px; overflow: auto; padding: var(--useful-space-2); border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); background: var(--useful-bg-layer); }
.json-query-result pre { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.json-privacy { margin: 0; color: var(--useful-text-tertiary); font-size: var(--useful-text-xs); }
@media (max-width: 900px) {
  .json-io { grid-template-columns: 1fr; overflow: auto; }
  .json-pane { min-height: 220px; }
}
</style>
