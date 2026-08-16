<script setup lang="ts">
import { ref } from "vue";
import { t } from "@/i18n";
import {
  INSTALLED_ORIGIN_FIELDS,
  SOURCE_CAPABILITY_FIELDS,
  type DirectoryDeclaredFacts,
} from "@/lib/sourceCenter";
import type { AvailabilityView, TrpCapabilities } from "@/lib/types";

const props = defineProps<{
  sourceId: string;
  sourceCapabilities: Partial<TrpCapabilities>;
  availability?: AvailabilityView;
  directory: DirectoryDeclaredFacts | null;
  verified?: boolean;
}>();
const copyState = ref(0);
const availabilityFields = ["status", "checkedAt", "source"];

function pick(value: object, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const candidate = (value as Record<string, unknown>)[field];
    if (candidate !== undefined) result[field] = candidate;
  }
  return result;
}

function facts() {
  const directory = props.directory;
  let installed: Record<string, unknown> | undefined;
  if (props.verified && directory) {
    installed = {};
    for (const [target, source] of INSTALLED_ORIGIN_FIELDS) installed[target] = directory[source];
  }
  return {
    sourceReported: {
      sourceId: props.sourceId,
      capabilities: pick(props.sourceCapabilities, SOURCE_CAPABILITY_FIELDS),
      availability: props.availability ? pick(props.availability, availabilityFields) : null,
    },
    directoryDeclared: directory,
    ...(installed ? { clientVerifiedInstalled: installed } : {}),
  };
}

const layerMeta: Record<string, [string, string]> = {
  sourceReported: ["source-reported-facts", "sourceCenter.trustFactsSourceReported"],
  directoryDeclared: ["directory-declared-facts", "sourceCenter.trustFactsDirectoryDeclared"],
  clientVerifiedInstalled: ["client-verified-facts", "sourceCenter.trustFactsClientVerified"],
};

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function copyFacts(): Promise<void> {
  if (!props.directory) return;
  const payload = {
    schemaVersion: "useful.trust-facts.v1",
    ...facts(),
  };
  copyState.value = 0;
  try {
    await navigator.clipboard.writeText(json(payload));
    copyState.value = 1;
  } catch {
    copyState.value = -1;
  }
}
</script>

<template>
  <section v-if="directory" class="trust-fact-card" data-testid="trust-fact-card">
    <h3>{{ t("sourceCenter.trustFactsTitle") }}</h3>
    <section v-for="(value, key) in facts()" :key="key" :data-testid="layerMeta[key][0]">
      <h4>{{ t(layerMeta[key][1]) }}</h4>
      <p v-if="key === 'directoryDeclared'">{{ t("sourceCenter.trustFactsPackagePermissions") }}</p>
      <pre :data-testid="key === 'directoryDeclared' ? 'package-permissions' : undefined">{{ json(value) }}</pre>
    </section>
    <button class="useful-btn" type="button" data-testid="copy-trust-facts" @click="copyFacts">
      {{ t("sourceCenter.trustFactsCopyJson") }}
    </button>
    <p v-if="copyState === 1" role="status">{{ t("sourceCenter.trustFactsCopyOk") }}</p>
    <p v-else-if="copyState === -1" role="alert">{{ t("sourceCenter.trustFactsCopyFailed") }}</p>
  </section>
</template>
