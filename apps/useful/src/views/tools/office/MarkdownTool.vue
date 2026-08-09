<script setup lang="ts">
import { ref, watch } from "vue";
import { t } from "@/i18n";
import OfficeWorkbench from "./OfficeWorkbench.vue";
import { runOfficeWorker } from "./officeWorkerClient";
import {
  assertOfficeTextInput,
  binaryOfficeOutput,
  downloadOfficeOutput,
  readOfficeTextFile,
  textOfficeOutput,
  useOfficeOperation,
} from "./officeRuntime";

type Operation = "preview" | "docx" | "pptx";
const operation = ref<Operation>("preview");
const title = ref("");
const input = ref("# \n");
const file = ref<File | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const state = useOfficeOperation();

watch(operation, state.clear);

function selectFile(event: Event): void {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

function execute(): void {
  const selectedOperation = operation.value;
  const selectedTitle = title.value;
  const selectedInput = input.value;
  const selectedFile = file.value;
  void state.run(async (signal) => {
    const markdown = selectedFile ? await readOfficeTextFile(selectedFile, selectedTitle) : selectedInput;
    assertOfficeTextInput(markdown, selectedTitle);
    if (selectedOperation === "preview") {
      const result = await runOfficeWorker({ operation: "markdown.parse", markdown }, { signal });
      return [textOfficeOutput("outline.json", "application/json;charset=utf-8", result.json)];
    }
    if (selectedOperation === "docx") {
      const result = await runOfficeWorker({ operation: "markdown.docx", markdown, title: selectedTitle }, { signal });
      return [binaryOfficeOutput("outline.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", result.bytes)];
    }
    const result = await runOfficeWorker({ operation: "markdown.pptx", markdown, title: selectedTitle }, { signal });
    return [binaryOfficeOutput("outline.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", result.bytes)];
  });
}

function clear(): void {
  title.value = "";
  input.value = "";
  file.value = null;
  if (fileInput.value) fileInput.value.value = "";
  state.clear();
}
</script>

<template>
  <OfficeWorkbench
    :title="t('office.tools.markdown.name')"
    :description="t('office.tools.markdown.description')"
    :running="state.running.value" :error="state.error.value" :cancelled="state.cancelled.value"
    :outputs="state.outputs.value" :preview="state.preview.value"
    @run="execute" @cancel="state.cancel" @clear="clear" @download="downloadOfficeOutput"
  >
    <label class="office-field">{{ t("office.fields.operation") }}
      <select v-model="operation" class="useful-input" data-testid="markdown-operation">
        <option value="preview">{{ t("office.operations.markdown.preview") }}</option>
        <option value="docx">{{ t("office.operations.markdown.docx") }}</option>
        <option value="pptx">{{ t("office.operations.markdown.pptx") }}</option>
      </select>
    </label>
    <label class="office-field">{{ t("office.fields.title") }}
      <input v-model="title" class="useful-input" type="text" data-testid="markdown-title" />
    </label>
    <label class="office-field">{{ t("office.fields.optionalMarkdown") }}
      <input ref="fileInput" class="useful-input" type="file" accept=".md,.markdown,text/markdown,text/plain" @change="selectFile" />
    </label>
    <label class="office-field">{{ t("office.fields.markdownFallback") }}
      <textarea v-model="input" class="useful-input office-textarea" data-testid="markdown-input" />
    </label>
  </OfficeWorkbench>
</template>

<style scoped>
.office-field { display: flex; flex-direction: column; gap: var(--useful-space-2); color: var(--useful-text-secondary); }
.office-textarea { min-height: 300px; resize: vertical; font-family: var(--useful-font-mono); }
</style>
