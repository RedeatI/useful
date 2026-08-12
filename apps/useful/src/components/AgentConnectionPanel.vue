<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "@/i18n";
import {
  AGENT_CONNECTION_JSON_BUDGET,
  AGENT_CONNECTION_TARGETS,
  connectionOutputText,
  inspectAgentConnectionJson,
  normalizedVerificationSetJson,
  type AgentConnectionTarget,
  type VerificationSetView,
} from "@/lib/agentConnectionInspector";

type InspectorState = "idle" | "ready" | "valid" | "invalid" | "stale";

const sourceText = ref("");
const state = ref<InspectorState>("idle");
const result = ref<VerificationSetView | null>(null);
const validationError = ref("");
const copyMessage = ref("");
const inputRevision = ref(0);
const resultRevision = ref(-1);
const copyAttemptId = ref(0);

const overBudget = computed(() => new Blob([sourceText.value]).size > AGENT_CONNECTION_JSON_BUDGET);
const canCopy = computed(() => state.value === "valid"
  && result.value !== null
  && resultRevision.value === inputRevision.value);
const resultIsStale = computed(() => result.value !== null
  && resultRevision.value !== inputRevision.value);
const verificationByTarget = computed(() => new Map(
  (result.value?.verifications ?? []).map((verification) => [verification.connection.plan.target, verification]),
));

function onInput(): void {
  inputRevision.value += 1;
  copyAttemptId.value += 1;
  copyMessage.value = "";
  if (overBudget.value) state.value = "invalid";
  else if (result.value) state.value = "stale";
  else state.value = sourceText.value ? "ready" : "idle";
}

function inspectJson(): void {
  copyAttemptId.value += 1;
  copyMessage.value = "";
  validationError.value = "";
  if (overBudget.value) {
    state.value = "invalid";
    validationError.value = t("agentConnections.budgetError");
    return;
  }
  try {
    result.value = inspectAgentConnectionJson(sourceText.value);
    resultRevision.value = inputRevision.value;
    state.value = "valid";
  } catch (cause) {
    state.value = "invalid";
    validationError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function copyText(text: string, label: string): Promise<void> {
  if (!canCopy.value) return;
  const attemptId = ++copyAttemptId.value;
  copyMessage.value = "";
  try {
    await navigator.clipboard.writeText(text);
    if (attemptId !== copyAttemptId.value || !canCopy.value) return;
    copyMessage.value = t("agentConnections.copySucceeded", { label });
  } catch {
    if (attemptId !== copyAttemptId.value || !canCopy.value) return;
    copyMessage.value = t("agentConnections.copyFailed");
  }
}

function targetLabel(target: AgentConnectionTarget): string {
  return t(`agentConnections.targets.${target}`);
}
</script>

<template>
  <div class="connection-panel" data-testid="agent-connection-panel">
    <h2 class="connection-panel__title">{{ t("agentConnections.title") }}</h2>
    <p class="connection-panel__hint">{{ t("agentConnections.intro") }}</p>
    <label class="connection-panel__label" for="agent-connections-json">{{ t("agentConnections.inputLabel") }}</label>
    <textarea
      id="agent-connections-json"
      v-model="sourceText"
      class="connection-panel__input useful-mono"
      rows="9"
      spellcheck="false"
      :aria-describedby="overBudget ? 'agent-connections-budget' : 'agent-connections-input-hint'"
      data-testid="agent-connections-input"
      @input="onInput"
    />
    <p id="agent-connections-input-hint" class="connection-panel__hint">{{ t("agentConnections.inputHint") }}</p>
    <p
      v-if="overBudget"
      id="agent-connections-budget"
      class="connection-panel__error"
      role="alert"
      data-testid="agent-connections-budget"
    >
      {{ t("agentConnections.budgetError") }}
    </p>
    <div class="connection-panel__actions">
      <button
        class="useful-btn useful-btn--primary"
        type="button"
        :disabled="!sourceText || overBudget"
        data-testid="agent-connections-inspect"
        @click="inspectJson"
      >
        {{ t("agentConnections.inspect") }}
      </button>
      <span class="useful-badge" data-testid="agent-connections-state">{{ t(`agentConnections.states.${state}`) }}</span>
    </div>

    <p v-if="state === 'invalid' && !overBudget" class="connection-panel__error" role="alert" data-testid="agent-connections-error">
      {{ t("agentConnections.invalid", { err: validationError }) }}
    </p>
    <p v-if="resultIsStale" class="connection-panel__warning" role="status" data-testid="agent-connections-stale">
      {{ t("agentConnections.staleWarning") }}
    </p>

    <div v-if="result" class="connection-panel__result" data-testid="agent-connections-result">
      <div
        class="connection-panel__boundary"
        :role="state === 'valid' ? 'status' : undefined"
        :aria-live="state === 'valid' ? 'polite' : undefined"
        data-testid="agent-connections-boundary"
      >
        <strong>{{ result.status }}</strong>
        <span>{{ t("agentConnections.selfReported") }}</span>
        <span>documentAuthenticated: {{ result.claims.documentAuthenticated }}</span>
        <span>externalAgentInstalledAttested: {{ result.claims.externalAgentInstalledAttested }}</span>
        <span>externalAgentConfiguredAttested: {{ result.claims.externalAgentConfiguredAttested }}</span>
        <span>externalAgentConnectedAttested: {{ result.claims.externalAgentConnectedAttested }}</span>
      </div>
      <p class="connection-panel__warning">{{ t("agentConnections.localPathWarning") }}</p>
      <p class="connection-panel__warning">{{ t("agentConnections.clipboardWarning") }}</p>

      <div class="connection-panel__actions">
        <button
          class="useful-btn"
          type="button"
          :disabled="!canCopy"
          data-testid="copy-verification-set"
          @click="copyText(normalizedVerificationSetJson(result), t('agentConnections.wholeSet'))"
        >
          {{ t("agentConnections.copyWholeSet") }}
        </button>
      </div>

      <div class="connection-grid" data-testid="agent-connections-targets">
        <article
          v-for="target in AGENT_CONNECTION_TARGETS"
          :key="target"
          class="connection-card"
          :data-testid="`agent-connection-${target}`"
        >
          <h3>{{ targetLabel(target) }}</h3>
          <template v-if="verificationByTarget.get(target)">
            <dl>
              <dt>{{ t("agentConnections.scope") }}</dt><dd>user</dd>
              <dt>{{ t("agentConnections.environment") }}</dt><dd>{}</dd>
              <dt>{{ t("agentConnections.nodePath") }}</dt><dd class="useful-mono">{{ verificationByTarget.get(target)!.connection.plan.server.nodePath }}</dd>
              <dt>{{ t("agentConnections.launcherPath") }}</dt><dd class="useful-mono">{{ verificationByTarget.get(target)!.connection.plan.server.launcherPath }}</dd>
            </dl>
            <pre class="connection-card__output" :aria-label="t('agentConnections.outputLabel', { target: targetLabel(target) })">{{ connectionOutputText(verificationByTarget.get(target)!.connection.output) }}</pre>
            <button
              class="useful-btn"
              type="button"
              :disabled="!canCopy"
              :aria-label="t('agentConnections.copyOutputFor', { target: targetLabel(target) })"
              :data-testid="`copy-output-${target}`"
              @click="copyText(connectionOutputText(verificationByTarget.get(target)!.connection.output), targetLabel(target))"
            >
              {{ t("agentConnections.copyOutput") }}
            </button>
          </template>
        </article>
      </div>
    </div>
    <p class="connection-panel__live" aria-live="polite" aria-atomic="true" data-testid="agent-connections-copy-status">{{ copyMessage }}</p>
  </div>
</template>

<style scoped>
.connection-panel { display: flex; flex-direction: column; gap: var(--useful-space-2); }
.connection-panel__title { font-size: var(--useful-text-lg); margin: 0; }
.connection-panel__hint { color: var(--useful-text-secondary); font-size: var(--useful-text-sm); margin: 0; }
.connection-panel__label { font-weight: 500; }
.connection-panel__input { box-sizing: border-box; min-height: 10rem; resize: vertical; width: 100%; }
.connection-panel__actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--useful-space-2); }
.connection-panel__error { color: var(--useful-danger); margin: 0; overflow-wrap: anywhere; }
.connection-panel__warning { background: rgba(157, 93, 0, 0.1); border-left: 3px solid var(--useful-warning); margin: 0; padding: var(--useful-space-2); }
.connection-panel__result { display: flex; flex-direction: column; gap: var(--useful-space-2); }
.connection-panel__boundary { display: flex; flex-direction: column; gap: var(--useful-space-1); border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); padding: var(--useful-space-3); }
.connection-grid { display: grid; gap: var(--useful-space-3); grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.connection-card { border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); min-width: 0; padding: var(--useful-space-3); }
.connection-card h3 { margin: 0 0 var(--useful-space-2); }
.connection-card dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--useful-space-1) var(--useful-space-2); margin: 0 0 var(--useful-space-2); }
.connection-card dt { color: var(--useful-text-secondary); }
.connection-card dd { margin: 0; overflow-wrap: anywhere; }
.connection-card__output { max-height: 14rem; overflow: auto; padding: var(--useful-space-2); white-space: pre-wrap; word-break: break-word; }
.connection-panel__live { min-height: 1.25rem; margin: 0; }
</style>
