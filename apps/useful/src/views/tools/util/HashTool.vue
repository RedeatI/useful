<script setup lang="ts">
// 哈希工具：文本哈希 + 文件哈希（流式，Worker 隔离）。
// 明确区分文本哈希和文件哈希。SHA-1 标注不适用于安全用途。
import { ref, watch, onUnmounted, shallowRef } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import AppIcon from "@/components/AppIcon.vue";
import { hashText, HASH_ALGOS, type HashAlgo } from "@/lib/tools/hash";
import { useClipboard } from "@/lib/tools/useClipboard";
import { toolErrorMessage } from "@/lib/tools/errors";

type Mode = "text" | "file";

const mode = ref<Mode>("text");
const input = ref("");
const results = ref<Record<string, string>>({});
const error = ref<string | null>(null);
const { copied, copy } = useClipboard();
const copiedAlgo = ref<string | null>(null);

// 文件哈希状态
const files = ref<File[]>([]);
const fileResults = ref<{ algo: string; hex: string; fileName: string }[]>([]);
const fileProgress = ref(0);
const fileHashing = ref(false);
const worker = shallowRef<Worker | null>(null);

async function recompute(): Promise<void> {
  error.value = null;
  if (!input.value) {
    results.value = {};
    return;
  }
  try {
    const entries = await Promise.all(
      HASH_ALGOS.map(async (a) => [a, await hashText(a, input.value)] as const),
    );
    results.value = Object.fromEntries(entries);
  } catch (e) {
    error.value = toolErrorMessage(e);
  }
}

watch(input, recompute, { immediate: true });

async function copyOne(algo: string, hex: string): Promise<void> {
  await copy(hex);
  copiedAlgo.value = algo;
  setTimeout(() => (copiedAlgo.value = null), 1200);
}

// ---------- 文件哈希 ----------

function onFileSelect(e: Event): void {
  const target = e.target as HTMLInputElement;
  if (target.files) {
    files.value = Array.from(target.files);
    void hashFiles();
  }
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  if (e.dataTransfer?.files) {
    files.value = Array.from(e.dataTransfer.files);
    void hashFiles();
  }
}

function onDragOver(e: DragEvent): void {
  e.preventDefault();
}

async function hashFiles(): Promise<void> {
  if (files.value.length === 0) return;
  if (worker.value) {
    worker.value.terminate();
    worker.value = null;
  }
  fileHashing.value = true;
  fileProgress.value = 0;
  fileResults.value = [];
  error.value = null;

  const w = new Worker(new URL("../../../lib/tools/fileHashWorker.ts", import.meta.url), { type: "module" });
  worker.value = w;
  let callId = 0;

  w.onmessage = (e: MessageEvent) => {
    const data = e.data;
    if (data.type === "progress") {
      fileProgress.value = data.total > 0 ? (data.received / data.total) * 100 : 0;
    } else if (data.type === "done") {
      if (data.callId === callId) {
        fileResults.value = data.results.map((r: { algo: string; hex: string }) => ({
          ...r,
          fileName: files.value[0]?.name ?? "",
        }));
        fileHashing.value = false;
      }
    } else if (data.type === "error") {
      error.value = toolErrorMessage(data.error);
      fileHashing.value = false;
    }
  };

  w.onerror = () => {
    error.value = t("util.hashWorkerError");
    fileHashing.value = false;
  };

  callId = Date.now();
  // 对每个文件分别计算（简化：只处理第一个文件的多算法）
  const algos = HASH_ALGOS;
  w.postMessage({
    file: files.value[0],
    algorithms: algos,
    callId,
  });
}

function cancelFileHash(): void {
  if (worker.value) {
    worker.value.terminate();
    worker.value = null;
  }
  fileHashing.value = false;
}

// 校验用户提供的摘要
const verifyInput = ref("");
const verifyAlgo = ref<HashAlgo>("SHA-256");
const verifyResult = ref<string | null>(null);

function verifyHash(): void {
  verifyResult.value = null;
  const expected = verifyInput.value.trim().toLowerCase();
  if (!expected) return;
  // 检查文件或文本结果中是否有匹配
  const checkResult = (hex: string): boolean => hex.toLowerCase() === expected;
  if (mode.value === "file") {
    const match = fileResults.value.find((r) => r.algo === verifyAlgo.value && checkResult(r.hex));
    verifyResult.value = match ? t("util.hash.verifyMatch") : t("util.hash.verifyMismatch");
  } else {
    const hex = results.value[verifyAlgo.value];
    if (hex) {
      verifyResult.value = checkResult(hex) ? t("util.hash.verifyMatch") : t("util.hash.verifyMismatch");
    }
  }
}

onUnmounted(() => {
  if (worker.value) {
    worker.value.terminate();
    worker.value = null;
  }
});
</script>

<template>
  <ToolShell :title="t('util.hash.name')" :description="t('util.hash.desc')" :error="error">
    <!-- 模式切换 -->
    <div class="tool-row">
      <button
        class="useful-btn"
        :class="{ 'useful-btn--primary': mode === 'text' }"
        @click="mode = 'text'"
      >
        {{ t("util.hash.textMode") }}
      </button>
      <button
        class="useful-btn"
        :class="{ 'useful-btn--primary': mode === 'file' }"
        @click="mode = 'file'"
      >
        {{ t("util.hash.fileMode") }}
      </button>
    </div>

    <!-- 隐私提示 -->
    <p class="hash-privacy">
      <AppIcon name="shield" :size="14" /> {{ t("util.localProcessing") }}
    </p>

    <!-- 文本哈希模式 -->
    <template v-if="mode === 'text'">
      <div class="tool-io tool-io--single">
        <textarea
          v-model="input"
          class="useful-input tool-pane"
          :placeholder="t('util.inputPlaceholder')"
          spellcheck="false"
          style="min-height: 120px"
        />
      </div>
      <div class="hash-list">
        <div v-for="algo in HASH_ALGOS" :key="algo" class="hash-row">
          <span class="hash-algo">
            {{ algo }}
            <span v-if="algo === 'SHA-1'" class="hash-warn-tag">{{ t("util.hash.sha1Warn") }}</span>
          </span>
          <code class="hash-val useful-mono">{{ results[algo] || "—" }}</code>
          <button
            class="useful-btn useful-btn--ghost"
            :disabled="!results[algo]"
            @click="copyOne(algo, results[algo])"
          >
            <AppIcon :name="copied && copiedAlgo === algo ? 'check' : 'copy'" :size="16" />
          </button>
        </div>
      </div>
    </template>

    <!-- 文件哈希模式 -->
    <template v-else>
      <div
        class="hash-dropzone"
        @drop="onDrop"
        @dragover="onDragOver"
      >
        <AppIcon name="file" :size="32" />
        <p>{{ t("util.hash.dropHere") }}</p>
        <input type="file" multiple @change="onFileSelect" style="display: none" id="hash-file-input" />
        <label for="hash-file-input" class="useful-btn useful-btn--primary">
          {{ t("util.hash.selectFile") }}
        </label>
        <span v-if="files.length" class="hash-file-name">
          {{ files[0].name }} ({{ (files[0].size / 1024).toFixed(1) }} KB)
        </span>
      </div>

      <!-- 进度 -->
      <div v-if="fileHashing" class="hash-progress">
        <div class="hash-progress-bar">
          <div class="hash-progress-fill" :style="{ width: fileProgress + '%' }" />
        </div>
        <span>{{ fileProgress.toFixed(1) }}%</span>
        <button class="useful-btn useful-btn--ghost" @click="cancelFileHash">
          <AppIcon name="x" :size="14" /> {{ t("common.cancel") }}
        </button>
      </div>

      <!-- 文件哈希结果 -->
      <div v-if="fileResults.length" class="hash-list">
        <div v-for="r in fileResults" :key="r.algo" class="hash-row">
          <span class="hash-algo">
            {{ r.algo }}
            <span v-if="r.algo === 'SHA-1'" class="hash-warn-tag">{{ t("util.hash.sha1Warn") }}</span>
          </span>
          <code class="hash-val useful-mono">{{ r.hex }}</code>
          <button class="useful-btn useful-btn--ghost" @click="copyOne(r.algo, r.hex)">
            <AppIcon :name="copied && copiedAlgo === r.algo ? 'check' : 'copy'" :size="16" />
          </button>
        </div>
      </div>

      <!-- 摘要校验 -->
      <div v-if="fileResults.length || results['SHA-256']" class="hash-verify">
        <span class="hash-verify-label">{{ t("util.hash.verify") }}</span>
        <select v-model="verifyAlgo" class="useful-input" style="width: 120px">
          <option v-for="a in HASH_ALGOS" :key="a" :value="a">{{ a }}</option>
        </select>
        <input
          v-model="verifyInput"
          class="useful-input useful-mono"
          style="flex: 1"
          :placeholder="t('util.hash.verifyPlaceholder')"
          @input="verifyResult = null"
        />
        <button class="useful-btn" @click="verifyHash">
          <AppIcon name="check" :size="16" /> {{ t("util.hash.verifyBtn") }}
        </button>
        <span v-if="verifyResult" class="hash-verify-result">{{ verifyResult }}</span>
      </div>
    </template>
  </ToolShell>
</template>

<style scoped>
.hash-privacy {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  margin: 0;
}
.hash-list {
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-2);
}
.hash-row {
  display: grid;
  grid-template-columns: 90px 1fr auto;
  align-items: center;
  gap: var(--useful-space-2);
}
.hash-algo {
  font-weight: 600;
  font-size: var(--useful-text-sm);
  color: var(--useful-text-secondary);
}
.hash-warn-tag {
  font-size: 9px;
  color: var(--useful-danger);
  background: var(--useful-bg-layer);
  padding: 1px 4px;
  border-radius: 3px;
  margin-left: 4px;
}
.hash-val {
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-sm);
  padding: 6px 10px;
  overflow-wrap: anywhere;
}
.hash-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--useful-space-2);
  padding: var(--useful-space-6);
  border: 2px dashed var(--useful-border-strong);
  border-radius: var(--useful-radius-lg);
  text-align: center;
  color: var(--useful-text-tertiary);
}
.hash-file-name {
  font-size: var(--useful-text-sm);
  color: var(--useful-text-secondary);
}
.hash-progress {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
}
.hash-progress-bar {
  flex: 1;
  height: 8px;
  background: var(--useful-bg-layer);
  border-radius: 4px;
  overflow: hidden;
}
.hash-progress-fill {
  height: 100%;
  background: var(--useful-accent);
  transition: width 0.2s;
}
.hash-verify {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  flex-wrap: wrap;
}
.hash-verify-label {
  font-size: var(--useful-text-sm);
  color: var(--useful-text-secondary);
}
.hash-verify-result {
  font-size: var(--useful-text-sm);
  font-weight: 600;
}
</style>
