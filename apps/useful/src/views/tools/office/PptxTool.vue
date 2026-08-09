<script setup lang="ts">
import { ref, watch } from "vue";
import { t } from "@/i18n";
import OfficeWorkbench from "./OfficeWorkbench.vue";
import { runOfficeWorker } from "./officeWorkerClient";
import {
  assertOfficeTextInput,
  binaryOfficeOutput,
  downloadOfficeOutput,
  jsonOfficeOutput,
  officePublicError,
  readOfficeFiles,
  textOfficeOutput,
  useOfficeOperation,
} from "./officeRuntime";

type Operation = "compose" | "extract" | "inspect" | "markdown";
const operation = ref<Operation>("compose");
const input = ref(JSON.stringify({
  title: "",
  slides: [],
}, null, 2));
const files = ref<File[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const state = useOfficeOperation();

watch(operation, () => {
  files.value = [];
  if (fileInput.value) fileInput.value.value = "";
  state.clear();
});

function selectFiles(event: Event): void {
  files.value = Array.from((event.target as HTMLInputElement).files ?? []);
}

async function selectedBytes(selectedFiles: readonly File[]): Promise<Uint8Array> {
  if (selectedFiles.length !== 1) throw officePublicError("office.errors.selectOnePptx");
  return (await readOfficeFiles(selectedFiles))[0];
}

function execute(): void {
  const selectedOperation = operation.value;
  const selectedInput = input.value;
  const selectedFiles = [...files.value];
  void state.run(async (signal) => {
    if (selectedOperation === "compose") {
      assertOfficeTextInput(selectedInput);
      const result = await runOfficeWorker({ operation: "pptx.compose", json: selectedInput }, { signal });
      return [binaryOfficeOutput("presentation.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", result.bytes)];
    }
    const bytes = await selectedBytes(selectedFiles);
    if (selectedOperation === "extract") {
      const result = await runOfficeWorker({ operation: "pptx.extract", input: bytes }, { signal });
      return [textOfficeOutput("presentation-extracted.json", "application/json;charset=utf-8", result.json)];
    }
    if (selectedOperation === "inspect") {
      const result = await runOfficeWorker({ operation: "pptx.inspect", input: bytes }, { signal });
      return [textOfficeOutput("presentation-inspection.json", "application/json;charset=utf-8", result.json)];
    }
    const result = await runOfficeWorker({ operation: "pptx.markdown", input: bytes }, { signal });
    return [textOfficeOutput("presentation.md", "text/markdown;charset=utf-8", result.markdown), jsonOfficeOutput("presentation-warnings.json", result.warnings)];
  });
}

function clear(): void {
  input.value = "";
  files.value = [];
  if (fileInput.value) fileInput.value.value = "";
  state.clear();
}
</script>

<template>
  <OfficeWorkbench
    :title="t('office.tools.pptx.name')"
    :description="t('office.tools.pptx.description')"
    :running="state.running.value" :error="state.error.value" :cancelled="state.cancelled.value"
    :outputs="state.outputs.value" :preview="state.preview.value"
    @run="execute" @cancel="state.cancel" @clear="clear" @download="downloadOfficeOutput"
  >
    <label class="office-field">{{ t("office.fields.operation") }}
      <select v-model="operation" class="useful-input" data-testid="pptx-operation">
        <option value="compose">{{ t("office.operations.pptx.compose") }}</option>
        <option value="extract">{{ t("office.operations.pptx.extract") }}</option>
        <option value="inspect">{{ t("office.operations.pptx.inspect") }}</option>
        <option value="markdown">{{ t("office.operations.pptx.markdown") }}</option>
      </select>
    </label>
    <label v-if="operation === 'compose'" class="office-field">{{ t("office.fields.structuredJson") }}
      <textarea v-model="input" class="useful-input office-textarea" spellcheck="false" data-testid="pptx-json" />
    </label>
    <label v-else class="office-field">{{ t("office.fields.localPptx") }}
      <input ref="fileInput" class="useful-input" type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" @change="selectFiles" />
    </label>
  </OfficeWorkbench>
</template>

<style scoped>
.office-field { display: flex; flex-direction: column; gap: var(--useful-space-2); color: var(--useful-text-secondary); }
.office-textarea { min-height: 320px; resize: vertical; font-family: var(--useful-font-mono); }
</style>
