<script setup lang="ts">
import { computed, ref } from "vue";
import { runBrowserAction } from "@useful/action-runtime/browser";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";

type InspectOutput = { network: string; broadcast: string; prefixLength: number; totalAddresses: number; isPrivate: boolean; isLoopback: boolean; isMulticast: boolean };
type ContainsOutput = { contains: boolean };

const operation = ref<"inspect" | "contains">("inspect");
const value = ref("192.168.1.42/24");
const cidr = ref("10.0.0.0/8");
const address = ref("10.2.3.4");

const result = computed<{ output: InspectOutput | ContainsOutput | null; error: string | null }>(() => {
  try {
    const input = operation.value === "inspect"
      ? { operation: "inspect", value: value.value }
      : { operation: "contains", cidr: cidr.value, address: address.value };
    return { output: runBrowserAction("builtin.utilities.ipv4", input) as InspectOutput | ContainsOutput, error: null };
  } catch {
    return { output: null, error: t("util.ipv4.invalid") };
  }
});
const inspectOutput = computed(() => operation.value === "inspect" ? result.value.output as InspectOutput | null : null);
const containsOutput = computed(() => operation.value === "contains" ? result.value.output as ContainsOutput | null : null);
</script>

<template>
  <ToolShell :title="t('util.ipv4.name')" :description="t('util.ipv4.desc')" :error="result.error">
    <div class="tool-row">
      <select v-model="operation" class="useful-input">
        <option value="inspect">{{ t("util.ipv4.inspect") }}</option>
        <option value="contains">{{ t("util.ipv4.contains") }}</option>
      </select>
      <input v-if="operation === 'inspect'" v-model="value" class="useful-input useful-mono ip-input" :placeholder="t('util.ipv4.valuePlaceholder')" spellcheck="false" />
      <template v-else>
        <input v-model="cidr" class="useful-input useful-mono ip-input" :placeholder="t('util.ipv4.cidrPlaceholder')" spellcheck="false" />
        <input v-model="address" class="useful-input useful-mono ip-input" :placeholder="t('util.ipv4.addressPlaceholder')" spellcheck="false" />
      </template>
    </div>
    <dl v-if="inspectOutput" class="ip-grid">
      <div><dt>{{ t("util.ipv4.network") }}</dt><dd>{{ inspectOutput.network }}/{{ inspectOutput.prefixLength }}</dd></div>
      <div><dt>{{ t("util.ipv4.broadcast") }}</dt><dd>{{ inspectOutput.broadcast }}</dd></div>
      <div><dt>{{ t("util.ipv4.total") }}</dt><dd>{{ inspectOutput.totalAddresses }}</dd></div>
      <div>
        <dt>{{ t("util.ipv4.classification") }}</dt><dd>
          {{ inspectOutput.isPrivate ? t("util.ipv4.private") : t("util.ipv4.public") }} ·
          {{ t("util.ipv4.loopback") }}: {{ inspectOutput.isLoopback ? t("common.yes") : t("common.no") }} ·
          {{ t("util.ipv4.multicast") }}: {{ inspectOutput.isMulticast ? t("common.yes") : t("common.no") }}
        </dd>
      </div>
    </dl>
    <p v-else-if="containsOutput" class="contains-result" :class="containsOutput.contains ? 'contains-result--yes' : ''">
      {{ containsOutput.contains ? t("util.ipv4.inside") : t("util.ipv4.outside") }}
    </p>
  </ToolShell>
</template>

<style scoped>
.ip-input { flex: 1; min-width: 220px; }
.ip-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--useful-space-3); margin: 0; }
.ip-grid div { padding: 12px; border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); background: var(--useful-bg-layer); }
.ip-grid dt { color: var(--useful-text-secondary); font-size: var(--useful-text-sm); }.ip-grid dd { margin: 6px 0 0; font-family: var(--useful-font-mono); }
.contains-result { padding: 14px; border: 1px solid var(--useful-danger); border-radius: var(--useful-radius-md); color: var(--useful-danger); }
.contains-result--yes { border-color: var(--useful-success, #16a34a); color: var(--useful-success, #16a34a); }
</style>
