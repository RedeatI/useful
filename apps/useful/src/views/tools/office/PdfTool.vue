<script setup lang="ts">
import { ref, watch } from "vue";
import { t } from "@/i18n";
import OfficeWorkbench from "./OfficeWorkbench.vue";
import { runOfficeWorker } from "./officeWorkerClient";
import {
  binaryOfficeOutput,
  downloadOfficeOutput,
  officePublicError,
  readOfficeFiles,
  textOfficeOutput,
  useOfficeOperation,
} from "./officeRuntime";

type Operation = "merge" | "split" | "reorder" | "rotate" | "sanitize" | "inspect" | "extract-pages" | "delete-pages";
function defaultOptions(operation: Operation): string {
  if (operation === "split") return JSON.stringify({ pageGroups: [[0], [1]] }, null, 2);
  if (operation === "reorder") return JSON.stringify({ order: [0] }, null, 2);
  if (operation === "rotate") return JSON.stringify({ rotations: [{ page: 0, angle: 90 }] }, null, 2);
  if (operation === "extract-pages" || operation === "delete-pages") return JSON.stringify({ pages: [0] }, null, 2);
  return "";
}

const operation = ref<Operation>("merge");
const options = ref(defaultOptions(operation.value));
const files = ref<File[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const state = useOfficeOperation();

watch(operation, (next) => {
  options.value = defaultOptions(next);
  files.value = [];
  if (fileInput.value) fileInput.value.value = "";
  state.clear();
});

function selectFiles(event: Event): void {
  files.value = Array.from((event.target as HTMLInputElement).files ?? []);
}

function execute(): void {
  const selectedOperation = operation.value;
  const selectedOptions = options.value;
  const selectedFiles = [...files.value];
  void state.run(async (signal) => {
    const usesOptions = !["merge", "sanitize", "inspect"].includes(selectedOperation);
    const bytes = await readOfficeFiles(selectedFiles, usesOptions ? selectedOptions : "");
    if (selectedOperation === "merge") {
      if (bytes.length < 2) throw officePublicError("office.errors.mergeNeedsTwoPdfs");
      const result = await runOfficeWorker({ operation: "pdf.merge", inputs: bytes }, { signal });
      return [binaryOfficeOutput("merged.pdf", "application/pdf", result.bytes)];
    }
    if (bytes.length !== 1) throw officePublicError("office.errors.selectOnePdf");
    if (selectedOperation === "sanitize") {
      const result = await runOfficeWorker({ operation: "pdf.sanitize", input: bytes[0] }, { signal });
      return [binaryOfficeOutput("sanitized.pdf", "application/pdf", result.bytes)];
    }
    if (selectedOperation === "inspect") {
      const result = await runOfficeWorker({ operation: "pdf.inspect", input: bytes[0] }, { signal });
      return [textOfficeOutput("pdf-inspection.json", "application/json;charset=utf-8", result.json)];
    }
    if (selectedOperation === "split") {
      const result = await runOfficeWorker({ operation: "pdf.split", input: bytes[0], optionsJson: selectedOptions }, { signal });
      return result.files.map((output, index) => binaryOfficeOutput(`split-${index + 1}.pdf`, "application/pdf", output));
    }
    if (selectedOperation === "reorder") {
      const result = await runOfficeWorker({ operation: "pdf.reorder", input: bytes[0], optionsJson: selectedOptions }, { signal });
      return [binaryOfficeOutput("reordered.pdf", "application/pdf", result.bytes)];
    }
    if (selectedOperation === "extract-pages") {
      const result = await runOfficeWorker({ operation: "pdf.extractPages", input: bytes[0], optionsJson: selectedOptions }, { signal });
      return [binaryOfficeOutput("extracted-pages.pdf", "application/pdf", result.bytes)];
    }
    if (selectedOperation === "delete-pages") {
      const result = await runOfficeWorker({ operation: "pdf.deletePages", input: bytes[0], optionsJson: selectedOptions }, { signal });
      return [binaryOfficeOutput("pages-deleted.pdf", "application/pdf", result.bytes)];
    }
    const result = await runOfficeWorker({ operation: "pdf.rotate", input: bytes[0], optionsJson: selectedOptions }, { signal });
    return [binaryOfficeOutput("rotated.pdf", "application/pdf", result.bytes)];
  });
}

function clear(): void {
  options.value = "";
  files.value = [];
  if (fileInput.value) fileInput.value.value = "";
  state.clear();
}
</script>

<template>
  <OfficeWorkbench
    :title="t('office.tools.pdf.name')"
    :description="t('office.tools.pdf.description')"
    :running="state.running.value" :error="state.error.value" :cancelled="state.cancelled.value"
    :outputs="state.outputs.value" :preview="state.preview.value"
    @run="execute" @cancel="state.cancel" @clear="clear" @download="downloadOfficeOutput"
  >
    <label class="office-field">{{ t("office.fields.operation") }}
      <select v-model="operation" class="useful-input" data-testid="pdf-operation">
        <option value="merge">{{ t("office.operations.pdf.merge") }}</option>
        <option value="split">{{ t("office.operations.pdf.split") }}</option>
        <option value="reorder">{{ t("office.operations.pdf.reorder") }}</option>
        <option value="rotate">{{ t("office.operations.pdf.rotate") }}</option>
        <option value="sanitize">{{ t("office.operations.pdf.sanitize") }}</option>
        <option value="inspect">{{ t("office.operations.pdf.inspect") }}</option>
        <option value="extract-pages">{{ t("office.operations.pdf.extractPages") }}</option>
        <option value="delete-pages">{{ t("office.operations.pdf.deletePages") }}</option>
      </select>
    </label>
    <label class="office-field">{{ t("office.fields.localPdf") }}
      <input ref="fileInput" class="useful-input" type="file" accept=".pdf,application/pdf" :multiple="operation === 'merge'" @change="selectFiles" />
    </label>
    <label v-if="!['merge', 'sanitize', 'inspect'].includes(operation)" class="office-field">{{ t("office.fields.pdfOptions") }}
      <textarea v-model="options" class="useful-input office-textarea" spellcheck="false" data-testid="pdf-options" />
    </label>
  </OfficeWorkbench>
</template>

<style scoped>
.office-field { display: flex; flex-direction: column; gap: var(--useful-space-2); color: var(--useful-text-secondary); }
.office-textarea { min-height: 220px; resize: vertical; font-family: var(--useful-font-mono); }
</style>
