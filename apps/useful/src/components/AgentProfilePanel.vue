<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  AgentProfileError,
  assertProfileDocument,
  canonicalProfileJson,
  createDefaultBuiltinProfile,
  validateProfileAgainstRegistry,
  type AgentPreset,
  type AgentProfileAction,
  type AgentProfileV1,
} from "@useful/agent-profile/browser";
import { BUILTIN_ACTION_DESCRIPTORS } from "@useful/action-runtime/browser";
import ipc from "@/lib/ipc";
import { t } from "@/i18n";
import { BUILTIN_GUI_ACTIONS } from "@/lib/actionCatalog";
import { useAppStore } from "@/stores/app";
import AppIcon from "./AppIcon.vue";

interface InputPropertySchema {
  type: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}
interface DescriptorView {
  actionId: string;
  contractVersion: "1.0";
  version: string;
  source: { kind: "builtin"; publisher: { id: string } };
  title: string;
  description: string;
  keywords: string[];
  aliases: string[];
  inputSchema: { properties: Record<string, InputPropertySchema> };
  sensitive: { input: string[] };
}

const appStore = useAppStore();
const route = useRoute();
const guiOrder = new Map(BUILTIN_GUI_ACTIONS.map((action) => [action.id, action.order]));
const descriptors = ([...BUILTIN_ACTION_DESCRIPTORS] as unknown as DescriptorView[])
  .sort((left, right) => (guiOrder.get(left.actionId) ?? Number.MAX_SAFE_INTEGER)
    - (guiOrder.get(right.actionId) ?? Number.MAX_SAFE_INTEGER));
const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.actionId, descriptor]));
const registry = {
  list: () => descriptors,
  resolve: (name: string) => {
    const descriptor = descriptorById.get(name);
    return descriptor ? { descriptor } : undefined;
  },
};

const profile = ref<AgentProfileV1>(createDefaultBuiltinProfile(descriptors));
const aliasText = ref<Record<string, string>>({});
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const status = ref("");
const exportedPath = ref("");
const catalogSearch = ref("");
const savedProfileSnapshot = ref<string | null>(null);

const exportPath = computed(() => exportedPath.value
  || appStore.agentProfile?.exportPath
  || (appStore.appInfo ? `${appStore.appInfo.dataDir}\\agent\\useful.agent-profile.v1.json` : "useful.agent-profile.v1.json"));
const editableActions = computed(() => profile.value.actions.filter((action) => descriptorById.has(action.actionId)));
const unresolvedActions = computed(() => profile.value.actions.filter((action) => !descriptorById.has(action.actionId)));
const availableDescriptors = computed(() => {
  const configured = new Set(profile.value.actions.map((action) => action.actionId));
  const tokens = catalogSearch.value.normalize("NFKC").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return descriptors.filter((descriptor) => {
    if (configured.has(descriptor.actionId)) return false;
    if (!tokens.length) return true;
    const haystack = [
      descriptor.actionId,
      descriptor.title,
      descriptor.description,
      ...descriptor.keywords,
      ...descriptor.aliases,
    ].join(" ").normalize("NFKC").toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
});
const isDirty = computed(() => {
  if (savedProfileSnapshot.value === null) return true;
  try {
    return canonicalProfileJson(profile.value) !== savedProfileSnapshot.value;
  } catch {
    return true;
  }
});
const commandCopyBlocked = computed(() => loading.value || busy.value || Boolean(error.value) || isDirty.value);

function addAction(actionId: string): void {
  if (profile.value.actions.some((action) => action.actionId === actionId)) return;
  const descriptor = descriptorById.get(actionId);
  if (!descriptor) return;
  profile.value.actions.push(createDefaultBuiltinProfile([descriptor]).actions[0]);
  aliasText.value[actionId] = "";
  validateNow();
}

function addAllAvailable(): void {
  for (const descriptor of availableDescriptors.value) addAction(descriptor.actionId);
}

function removeAction(actionId: string): void {
  profile.value.actions = profile.value.actions.filter((action) => action.actionId !== actionId);
  delete aliasText.value[actionId];
  validateNow();
}

function moveAction(actionId: string, delta: -1 | 1): void {
  const index = profile.value.actions.findIndex((action) => action.actionId === actionId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= profile.value.actions.length) return;
  const [action] = profile.value.actions.splice(index, 1);
  profile.value.actions.splice(target, 0, action);
  validateNow();
}

function setAllSurface(surface: "cli" | "mcp", enabled: boolean): void {
  for (const action of editableActions.value) action.enabled[surface] = enabled;
  validateNow();
}

function syncAliasText(): void {
  aliasText.value = Object.fromEntries(profile.value.actions.map((action) => [action.actionId, action.aliases.join(", ")]));
}

function safeFields(actionId: string): Array<{ name: string; schema: InputPropertySchema }> {
  const descriptor = descriptorById.get(actionId);
  if (!descriptor) return [];
  return Object.entries(descriptor.inputSchema.properties)
    .filter(([name, schema]) =>
      typeof schema.type === "string"
      && ["string", "integer", "number", "boolean"].includes(schema.type)
      && !descriptor.sensitive.input.some((pointer) => pointer === `/${name}` || pointer.startsWith(`/${name}/`)))
    .map(([name, schema]) => ({ name, schema }));
}

function fieldLabel(name: string): string {
  const key = ({
    operation: "agentProfile.fieldOperation",
    algorithm: "agentProfile.fieldAlgorithm",
    indent: "agentProfile.fieldIndent",
  } as Record<string, string>)[name];
  return key ? t(key) : name;
}

function hasDefault(preset: AgentPreset, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(preset.defaults, name);
}

function defaultValue(schema: InputPropertySchema): unknown {
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  return "";
}

function addPreset(action: AgentProfileAction): void {
  let index = action.presets.length + 1;
  let presetId = `preset-${index}`;
  while (action.presets.some((preset) => preset.presetId === presetId)) presetId = `preset-${++index}`;
  const first = safeFields(action.actionId)[0];
  action.presets.push({
    presetId,
    name: t("agentProfile.newPresetName", { index }),
    defaults: first ? { [first.name]: defaultValue(first.schema) } : {},
  });
}

function copyPreset(action: AgentProfileAction, preset: AgentPreset): void {
  let index = 2;
  let presetId = `${preset.presetId}-copy`;
  while (action.presets.some((item) => item.presetId === presetId)) presetId = `${preset.presetId}-copy-${index++}`;
  action.presets.push({
    presetId,
    name: t("agentProfile.presetCopyName", { name: preset.name }),
    defaults: JSON.parse(JSON.stringify(preset.defaults)) as Record<string, unknown>,
  });
}

function updateDefault(preset: AgentPreset, name: string, value: unknown, schema: InputPropertySchema): void {
  if (schema.enum?.length) {
    const selected = schema.enum.find((option) => String(option) === String(value));
    if (selected === undefined) delete preset.defaults[name];
    else preset.defaults[name] = selected;
  } else if (schema.type === "integer" || schema.type === "number") {
    if (value === "") delete preset.defaults[name];
    else preset.defaults[name] = Number(value);
  } else if (schema.type === "boolean") {
    preset.defaults[name] = value === true || value === "true";
  } else {
    preset.defaults[name] = String(value);
  }
}

function toggleDefault(preset: AgentPreset, name: string, schema: InputPropertySchema, enabled: boolean): void {
  if (enabled) preset.defaults[name] = defaultValue(schema);
  else delete preset.defaults[name];
  validateNow();
}

function onDefaultToggle(preset: AgentPreset, name: string, schema: InputPropertySchema, event: Event): void {
  toggleDefault(preset, name, schema, (event.target as HTMLInputElement).checked);
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function commandFor(action: AgentProfileAction, preset?: AgentPreset): string {
  const presetArg = preset ? ` --preset ${preset.presetId}` : "";
  return `useful-runtime --agent-profile ${shellQuote(exportPath.value)} actions run ${action.actionId}${presetArg} --input @request.json --output json`;
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  status.value = t("agentProfile.commandCopied");
}

async function copyCommand(value: string): Promise<void> {
  if (commandCopyBlocked.value) {
    status.value = t("agentProfile.saveBeforeCopy");
    return;
  }
  await copyText(value);
}

function applyAliases(): void {
  for (const action of profile.value.actions) {
    action.aliases = (aliasText.value[action.actionId] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
}

function validateNow(): boolean {
  error.value = "";
  try {
    applyAliases();
    // Full document: shared exact-key/count/depth/danger/expression semantics.
    assertProfileDocument(profile.value);
    // Descriptor-authoritative checks are possible locally for every bundled action.
    // Unresolved plugin entries are preserved and remain subject to runtime's signed registry.
    const plainProfile = JSON.parse(JSON.stringify(profile.value)) as AgentProfileV1;
    const builtinOnly: AgentProfileV1 = {
      ...plainProfile,
      actions: plainProfile.actions.filter((action) => descriptorById.has(action.actionId)),
    };
    validateProfileAgainstRegistry(builtinOnly, registry);
    return true;
  } catch (cause) {
    if (cause instanceof AgentProfileError) {
      const issue = cause.issues[0];
      error.value = `${cause.code}${issue ? ` · ${issue.path || "/"} · ${issue.code}` : ""}`;
    } else {
      error.value = "AGENT_PROFILE_INVALID";
    }
    return false;
  }
}

async function saveProfile(): Promise<void> {
  status.value = "";
  if (!validateNow()) return;
  busy.value = true;
  try {
    const view = await ipc.agentProfileSave(canonicalProfileJson(profile.value));
    appStore.setAgentProfile(view);
    exportedPath.value = view.exportPath;
    profile.value = JSON.parse(view.profileJson) as AgentProfileV1;
    syncAliasText();
    savedProfileSnapshot.value = canonicalProfileJson(profile.value);
    status.value = t("agentProfile.saved");
  } catch (cause) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}

async function exportProfile(): Promise<void> {
  if (!validateNow()) return;
  busy.value = true;
  try {
    await saveProfile();
    if (error.value) return;
    exportedPath.value = await ipc.agentProfileExport();
    status.value = t("agentProfile.exported", { path: exportedPath.value });
  } catch (cause) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}

async function ensureRequestedAction(actionId: unknown): Promise<void> {
  const requested = typeof actionId === "string" ? actionId : "";
  if (!requested) return;
  if (!profile.value.actions.some((action) => action.actionId === requested)) {
    const descriptor = descriptorById.get(requested);
    if (descriptor) {
      profile.value.actions.push(createDefaultBuiltinProfile([descriptor]).actions[0]);
      syncAliasText();
      validateNow();
    }
  }
  await nextTick();
  // actionId 已经由 profile 的稳定 ID 语义校验；不用依赖浏览器特有的 CSS.escape。
  document.querySelectorAll<HTMLElement>("[data-action-id]")
    .forEach((element) => { if (element.dataset.actionId === requested) element.focus(); });
}

onMounted(async () => {
  try {
    const stored = appStore.agentProfile ?? await ipc.agentProfileGet();
    if (stored) {
      profile.value = JSON.parse(stored.profileJson) as AgentProfileV1;
      exportedPath.value = stored.exportPath;
    }
    syncAliasText();
    if (validateNow() && stored) savedProfileSnapshot.value = canonicalProfileJson(profile.value);
  } catch (cause) {
    error.value = String(cause);
  } finally {
    loading.value = false;
  }
  await ensureRequestedAction(route.query.action);
});

watch(() => route.query.action, (actionId) => { void ensureRequestedAction(actionId); });
</script>

<template>
  <section class="agent-panel" data-testid="agent-profile-panel" aria-labelledby="agent-profile-heading">
    <header class="agent-panel__head">
      <div>
        <h2 id="agent-profile-heading">{{ t("agentProfile.title") }}</h2>
        <p>{{ t("agentProfile.subtitle") }}</p>
      </div>
      <span class="useful-badge">useful.agent-profile.v1</span>
    </header>
    <div class="agent-panel__notice">
      {{ t("agentProfile.trustNotice") }}
    </div>
    <p v-if="loading">{{ t("agentProfile.loading") }}</p>
    <template v-else>
      <div class="agent-panel__meta">
        <label>{{ t("agentProfile.profileName") }} <input v-model="profile.name" class="useful-input" maxlength="120" @input="validateNow" /></label>
        <label>Profile ID <input v-model="profile.profileId" class="useful-input useful-mono" maxlength="64" @input="validateNow" /></label>
      </div>

      <section class="agent-catalog" aria-labelledby="agent-catalog-heading">
        <div class="agent-catalog__head">
          <div>
            <h3 id="agent-catalog-heading">{{ t("agentProfile.catalogTitle") }}</h3>
            <p>{{ t("agentProfile.catalogHint", { configured: editableActions.length, total: descriptors.length }) }}</p>
          </div>
          <div class="agent-panel__actions">
            <button class="useful-btn" @click="setAllSurface('cli', true)">{{ t("agentProfile.enableAllCli") }}</button>
            <button class="useful-btn" @click="setAllSurface('mcp', true)">{{ t("agentProfile.enableAllMcp") }}</button>
            <button class="useful-btn" @click="setAllSurface('cli', false); setAllSurface('mcp', false)">{{ t("agentProfile.disableAll") }}</button>
          </div>
        </div>
        <label>{{ t("agentProfile.catalogSearch") }}
          <input v-model="catalogSearch" class="useful-input" type="search" :placeholder="t('agentProfile.catalogSearchPlaceholder')" />
        </label>
        <div v-if="availableDescriptors.length" class="agent-catalog__available">
          <button
            v-for="descriptor in availableDescriptors"
            :key="descriptor.actionId"
            class="useful-btn agent-catalog__add"
            :title="descriptor.description"
            @click="addAction(descriptor.actionId)"
          >
            <AppIcon name="plus" :size="14" />
            <span>{{ descriptor.title }}</span>
            <code class="useful-mono">{{ descriptor.actionId }}</code>
          </button>
          <button class="useful-btn useful-btn--primary" @click="addAllAvailable">{{ t("agentProfile.addAllVisible") }}</button>
        </div>
        <p v-else class="agent-panel__empty">{{ t("agentProfile.noAvailableActions") }}</p>
      </section>

      <article v-for="action in editableActions" :key="action.actionId" class="agent-action" :data-action-id="action.actionId" tabindex="-1">
        <div class="agent-action__head">
          <div><h3>{{ descriptorById.get(action.actionId)?.title }}</h3><code class="useful-mono">{{ action.actionId }}</code></div>
          <div class="agent-action__surfaces" role="group" :aria-label="t('agentProfile.exposureScope', { action: action.actionId })">
            <button class="useful-btn" :aria-pressed="action.enabled.cli" @click="action.enabled.cli = !action.enabled.cli; validateNow()">CLI {{ t(action.enabled.cli ? "common.enabled" : "common.disabled") }}</button>
            <button class="useful-btn" :aria-pressed="action.enabled.mcp" @click="action.enabled.mcp = !action.enabled.mcp; validateNow()">MCP {{ t(action.enabled.mcp ? "common.enabled" : "common.disabled") }}</button>
            <button class="useful-btn" :aria-label="t('agentProfile.moveUp', { action: action.actionId })" @click="moveAction(action.actionId, -1)"><AppIcon name="chevronUp" :size="14" /></button>
            <button class="useful-btn" :aria-label="t('agentProfile.moveDown', { action: action.actionId })" @click="moveAction(action.actionId, 1)"><AppIcon name="chevronDown" :size="14" /></button>
            <button class="useful-btn" :aria-label="t('agentProfile.removeAction', { action: action.actionId })" @click="removeAction(action.actionId)">{{ t("common.delete") }}</button>
          </div>
        </div>
        <label class="agent-action__alias">{{ t("agentProfile.aliasLabel") }}
          <input v-model="aliasText[action.actionId]" class="useful-input useful-mono" :placeholder="t('agentProfile.aliasExample')" @input="validateNow" />
        </label>
        <p class="agent-action__sensitive"><AppIcon name="shield" :size="15" /> {{ t("agentProfile.sensitiveInput") }}</p>

        <div class="preset-head"><h4>{{ t("agentProfile.presetsTitle") }}</h4><button class="useful-btn" @click="addPreset(action); validateNow()"><AppIcon name="plus" :size="14" /> {{ t("agentProfile.newPreset") }}</button></div>
        <div v-if="action.presets.length" class="preset-list">
          <fieldset v-for="preset in action.presets" :key="preset.presetId" class="preset-card">
            <legend>{{ preset.name }}</legend>
            <div class="preset-card__fields">
              <label>{{ t("agentProfile.presetId") }} <input v-model="preset.presetId" class="useful-input useful-mono" @input="validateNow" /></label>
              <label>{{ t("agentProfile.name") }} <input v-model="preset.name" class="useful-input" @input="validateNow" /></label>
              <div v-for="field in safeFields(action.actionId)" :key="field.name" class="preset-field">
                <label class="preset-field__toggle"><input type="checkbox" :checked="hasDefault(preset, field.name)" @change="onDefaultToggle(preset, field.name, field.schema, $event)" /> {{ t("agentProfile.saveDefault", { field: fieldLabel(field.name) }) }}</label>
                <label v-if="hasDefault(preset, field.name)">{{ fieldLabel(field.name) }}
                <select v-if="field.schema.enum" class="useful-select" :value="preset.defaults[field.name]" @change="updateDefault(preset, field.name, ($event.target as HTMLSelectElement).value, field.schema); validateNow()">
                  <option v-for="option in field.schema.enum" :key="String(option)" :value="option">{{ option }}</option>
                </select>
                <input v-else-if="field.schema.type === 'integer' || field.schema.type === 'number'" type="number" class="useful-input" :step="field.schema.type === 'integer' ? 1 : 'any'" :min="field.schema.minimum" :max="field.schema.maximum" :value="preset.defaults[field.name]" @input="updateDefault(preset, field.name, ($event.target as HTMLInputElement).value, field.schema); validateNow()" />
                <select v-else-if="field.schema.type === 'boolean'" class="useful-select" :value="String(preset.defaults[field.name])" @change="updateDefault(preset, field.name, ($event.target as HTMLSelectElement).value, field.schema); validateNow()">
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
                <input v-else type="text" class="useful-input" :value="preset.defaults[field.name]" @input="updateDefault(preset, field.name, ($event.target as HTMLInputElement).value, field.schema); validateNow()" />
                </label>
              </div>
            </div>
            <code class="preset-card__command useful-mono">{{ commandFor(action, preset) }}</code>
            <div class="preset-card__actions">
              <button class="useful-btn" :disabled="commandCopyBlocked" aria-describedby="agent-profile-copy-guard" @click="copyCommand(commandFor(action, preset))"><AppIcon name="copy" :size="14" /> {{ t("agentProfile.copyCli") }}</button>
              <button class="useful-btn" @click="copyPreset(action, preset); validateNow()">{{ t("agentProfile.copyPreset") }}</button>
              <button class="useful-btn" @click="action.presets = action.presets.filter((item) => item !== preset); validateNow()">{{ t("common.delete") }}</button>
            </div>
          </fieldset>
        </div>
        <p v-else class="agent-panel__empty">{{ t("agentProfile.noPresets") }}</p>
      </article>

      <article v-for="action in unresolvedActions" :key="action.actionId" class="agent-action agent-action--readonly">
        <h3>{{ t("agentProfile.runtimeVerification") }}</h3><code class="useful-mono">{{ action.actionId }}</code>
        <p>{{ t("agentProfile.runtimeVerificationHint") }}</p>
      </article>

      <p v-if="error" id="agent-profile-error" class="agent-panel__error" role="alert">{{ error }}</p>
      <p v-if="status" class="agent-panel__status" role="status">{{ status }}</p>
      <p v-if="commandCopyBlocked" id="agent-profile-copy-guard" class="agent-panel__status" role="status">
        <span v-if="isDirty">{{ t("agentProfile.unsaved") }} · </span>{{ t("agentProfile.saveBeforeCopy") }}
      </p>
      <div class="agent-panel__export">
        <div><span>{{ t("agentProfile.exportPath") }}</span><code class="useful-mono">{{ exportPath }}</code></div>
        <div class="agent-panel__actions">
          <button class="useful-btn useful-btn--primary" :disabled="busy || Boolean(error)" aria-describedby="agent-profile-error" @click="saveProfile">{{ t("common.save") }}</button>
          <button class="useful-btn" :disabled="busy || Boolean(error)" @click="exportProfile">{{ t("agentProfile.exportProfile") }}</button>
          <button class="useful-btn" @click="ipc.agentProfileOpenDirectory()">{{ t("agentProfile.openDirectory") }}</button>
          <button class="useful-btn" :disabled="commandCopyBlocked" aria-describedby="agent-profile-copy-guard" @click="copyCommand(`useful-mcp --agent-profile ${shellQuote(exportPath)}`)">{{ t("agentProfile.copyMcpCommand") }}</button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.agent-panel { display: flex; flex-direction: column; gap: var(--useful-space-3); }
.agent-panel__head, .agent-action__head, .preset-head, .agent-panel__export, .agent-catalog__head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--useful-space-3); }
.agent-panel__head h2, .agent-action h3, .preset-head h4 { margin: 0; }
.agent-panel__head p { margin: 4px 0 0; color: var(--useful-text-secondary); }
.agent-panel__notice { padding: var(--useful-space-3); border-left: 3px solid var(--useful-accent); background: var(--useful-bg-selected); border-radius: var(--useful-radius-sm); }
.agent-catalog { display: flex; flex-direction: column; gap: var(--useful-space-3); padding: var(--useful-space-3); border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); }
.agent-catalog h3, .agent-catalog p { margin: 0; }
.agent-catalog__available { display: flex; flex-wrap: wrap; gap: var(--useful-space-2); max-height: 240px; overflow: auto; }
.agent-catalog__add { display: inline-flex; align-items: center; gap: var(--useful-space-2); max-width: 100%; }
.agent-catalog__add code { color: var(--useful-text-tertiary); overflow-wrap: anywhere; }
.agent-panel__meta, .preset-card__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--useful-space-3); }
.agent-panel label, .preset-card label { display: flex; flex-direction: column; gap: var(--useful-space-1); font-size: var(--useful-text-sm); }
.agent-action { border-top: 1px solid var(--useful-border); padding-top: var(--useful-space-4); display: flex; flex-direction: column; gap: var(--useful-space-3); }
.agent-action__surfaces, .agent-panel__actions, .preset-card__actions { display: flex; flex-wrap: wrap; gap: var(--useful-space-2); }
.agent-action__surfaces .useful-btn[aria-pressed="true"] { color: var(--useful-accent); background: var(--useful-bg-selected); border-color: var(--useful-accent); }
.agent-action__sensitive { display: flex; align-items: center; gap: var(--useful-space-2); color: var(--useful-text-secondary); margin: 0; font-size: var(--useful-text-sm); }
.preset-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--useful-space-3); }
.preset-card { border: 1px solid var(--useful-border); border-radius: var(--useful-radius-md); padding: var(--useful-space-3); min-width: 0; }
.preset-card legend { font-weight: 600; padding: 0 var(--useful-space-1); }
.preset-card__command { display: block; margin: var(--useful-space-3) 0; padding: var(--useful-space-2); background: var(--useful-bg); border-radius: var(--useful-radius-sm); overflow-wrap: anywhere; white-space: normal; }
.agent-panel__empty { color: var(--useful-text-tertiary); }
.agent-action--readonly { color: var(--useful-text-secondary); }
.agent-panel__error { color: var(--useful-danger); }
.agent-panel__status { color: var(--useful-success); overflow-wrap: anywhere; }
.agent-panel__export > div:first-child { display: flex; flex-direction: column; gap: var(--useful-space-1); min-width: 0; }
.agent-panel__export code { overflow-wrap: anywhere; }
.agent-panel button, .agent-panel input:not([type="checkbox"]), .agent-panel select { min-height: 44px; }
.preset-field__toggle { min-height: 44px; flex-direction: row !important; align-items: center; }
.preset-field__toggle input { width: 18px; height: 18px; flex: 0 0 auto; }
@media (max-width: 1050px) {
  .agent-panel__meta, .preset-card__fields { grid-template-columns: 1fr; }
  .agent-action__head, .agent-panel__export, .agent-catalog__head { flex-direction: column; }
}
</style>
