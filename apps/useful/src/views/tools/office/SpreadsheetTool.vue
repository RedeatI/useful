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
  readOfficeTextFile,
  textOfficeOutput,
  useOfficeOperation,
} from "./officeRuntime";

type Operation = "compose-xlsx" | "extract-xlsx" | "parse-csv" | "create-csv" | "inspect-xlsx" | "inspect-csv" | "to-markdown" | "from-markdown";
type TableFormat = "xlsx" | "csv";
const operation = ref<Operation>("compose-xlsx");
const tableFormat = ref<TableFormat>("xlsx");
const input = ref(JSON.stringify({
  sheets: [{ name: "Sheet1", rows: [] }],
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

function execute(): void {
  const selectedOperation = operation.value;
  const selectedInput = input.value;
  const selectedFormat = tableFormat.value;
  const selectedFiles = [...files.value];
  void state.run(async (signal) => {
    if (selectedOperation === "compose-xlsx") {
      assertOfficeTextInput(selectedInput);
      const result = await runOfficeWorker({ operation: "spreadsheet.compose", json: selectedInput }, { signal });
      return [binaryOfficeOutput("workbook.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", result.bytes)];
    }
    if (selectedOperation === "extract-xlsx") {
      if (selectedFiles.length !== 1) throw officePublicError("office.errors.selectOneXlsx");
      const [bytes] = await readOfficeFiles(selectedFiles);
      const result = await runOfficeWorker({ operation: "spreadsheet.extract", input: bytes }, { signal });
      return [textOfficeOutput("workbook-extracted.json", "application/json;charset=utf-8", result.json)];
    }
    if (selectedOperation === "inspect-xlsx") {
      if (selectedFiles.length !== 1) throw officePublicError("office.errors.selectOneXlsx");
      const [bytes] = await readOfficeFiles(selectedFiles);
      const result = await runOfficeWorker({ operation: "spreadsheet.inspectXlsx", input: bytes }, { signal });
      return [textOfficeOutput("workbook-inspection.json", "application/json;charset=utf-8", result.json)];
    }
    if (selectedOperation === "parse-csv" || selectedOperation === "inspect-csv") {
      const csv = selectedFiles.length ? await readOfficeTextFile(selectedFiles[0]) : selectedInput;
      assertOfficeTextInput(csv);
      const result = await runOfficeWorker({ operation: selectedOperation === "parse-csv" ? "spreadsheet.parseCsv" : "spreadsheet.inspectCsv", text: csv }, { signal });
      return [textOfficeOutput(selectedOperation === "parse-csv" ? "csv-parsed.json" : "csv-inspection.json", "application/json;charset=utf-8", result.json)];
    }
    if (selectedOperation === "to-markdown") {
      if (selectedFormat === "xlsx") {
        if (selectedFiles.length !== 1) throw officePublicError("office.errors.selectOneXlsx");
        const [bytes] = await readOfficeFiles(selectedFiles);
        const result = await runOfficeWorker({ operation: "spreadsheet.xlsxToMarkdown", input: bytes }, { signal });
        return [textOfficeOutput("table.md", "text/markdown;charset=utf-8", result.markdown), jsonOfficeOutput("table-warnings.json", result.warnings)];
      }
      const csv = selectedFiles.length ? await readOfficeTextFile(selectedFiles[0]) : selectedInput;
      assertOfficeTextInput(csv);
      const result = await runOfficeWorker({ operation: "spreadsheet.csvToMarkdown", text: csv }, { signal });
      return [textOfficeOutput("table.md", "text/markdown;charset=utf-8", result.markdown), jsonOfficeOutput("table-warnings.json", result.warnings)];
    }
    if (selectedOperation === "from-markdown") {
      const markdown = selectedFiles.length ? await readOfficeTextFile(selectedFiles[0]) : selectedInput;
      assertOfficeTextInput(markdown);
      if (selectedFormat === "xlsx") {
        const result = await runOfficeWorker({ operation: "spreadsheet.markdownToXlsx", markdown, sheetName: "Sheet1" }, { signal });
        return [binaryOfficeOutput("table.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", result.bytes)];
      }
      const result = await runOfficeWorker({ operation: "spreadsheet.markdownToCsv", markdown }, { signal });
      return [textOfficeOutput("table.csv", "text/csv;charset=utf-8", result.text)];
    }
    assertOfficeTextInput(selectedInput);
    const result = await runOfficeWorker({ operation: "spreadsheet.stringifyCsv", json: selectedInput }, { signal });
    return [textOfficeOutput("table.csv", "text/csv;charset=utf-8", result.text)];
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
    :title="t('office.tools.spreadsheet.name')"
    :description="t('office.tools.spreadsheet.description')"
    :running="state.running.value" :error="state.error.value" :cancelled="state.cancelled.value"
    :outputs="state.outputs.value" :preview="state.preview.value"
    @run="execute" @cancel="state.cancel" @clear="clear" @download="downloadOfficeOutput"
  >
    <label class="office-field">{{ t("office.fields.operation") }}
      <select v-model="operation" class="useful-input" data-testid="spreadsheet-operation">
        <option value="compose-xlsx">{{ t("office.operations.spreadsheet.composeXlsx") }}</option>
        <option value="extract-xlsx">{{ t("office.operations.spreadsheet.extractXlsx") }}</option>
        <option value="parse-csv">{{ t("office.operations.spreadsheet.parseCsv") }}</option>
        <option value="create-csv">{{ t("office.operations.spreadsheet.createCsv") }}</option>
        <option value="inspect-xlsx">{{ t("office.operations.spreadsheet.inspectXlsx") }}</option>
        <option value="inspect-csv">{{ t("office.operations.spreadsheet.inspectCsv") }}</option>
        <option value="to-markdown">{{ t("office.operations.spreadsheet.toMarkdown") }}</option>
        <option value="from-markdown">{{ t("office.operations.spreadsheet.fromMarkdown") }}</option>
      </select>
    </label>
    <label v-if="operation === 'to-markdown' || operation === 'from-markdown'" class="office-field">{{ t(operation === "to-markdown" ? "office.fields.sourceFormat" : "office.fields.outputFormat") }}
      <select v-model="tableFormat" class="useful-input" data-testid="spreadsheet-format">
        <option value="xlsx">XLSX</option>
        <option value="csv">CSV</option>
      </select>
    </label>
    <label v-if="['extract-xlsx', 'inspect-xlsx'].includes(operation) || (operation === 'to-markdown' && tableFormat === 'xlsx')" class="office-field">{{ t("office.fields.localXlsx") }}
      <input ref="fileInput" class="useful-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="selectFiles" />
    </label>
    <template v-else>
      <label v-if="['parse-csv', 'inspect-csv'].includes(operation) || (operation === 'to-markdown' && tableFormat === 'csv')" class="office-field">{{ t("office.fields.optionalCsv") }}
        <input ref="fileInput" class="useful-input" type="file" accept=".csv,text/csv,text/plain" @change="selectFiles" />
      </label>
      <label v-if="operation === 'from-markdown'" class="office-field">{{ t("office.fields.optionalMarkdown") }}
        <input ref="fileInput" class="useful-input" type="file" accept=".md,.markdown,text/markdown,text/plain" @change="selectFiles" />
      </label>
      <label class="office-field">{{ t(operation === "from-markdown" ? "office.fields.markdownFallback" : (['parse-csv', 'inspect-csv', 'to-markdown'].includes(operation) ? "office.fields.csvFallback" : "office.fields.structuredJson")) }}
        <textarea v-model="input" class="useful-input office-textarea" spellcheck="false" data-testid="spreadsheet-input" />
      </label>
    </template>
  </OfficeWorkbench>
</template>

<style scoped>
.office-field { display: flex; flex-direction: column; gap: var(--useful-space-2); color: var(--useful-text-secondary); }
.office-textarea { min-height: 320px; resize: vertical; font-family: var(--useful-font-mono); }
</style>
