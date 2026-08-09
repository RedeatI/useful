<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import AppIcon from "@/components/AppIcon.vue";
import StateBlock from "@/components/StateBlock.vue";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import { formatBytes } from "@/lib/format";
import type {
  MediaPackCatalogView,
  MediaPackDoneEvent,
  MediaPackPhase,
  MediaPackProgressEvent,
  Sidecars,
} from "@/lib/types";

type PackId = "preview" | "transcode";
type PackState = "detected" | "partial" | "missing" | "damaged";

const route = useRoute();
const router = useRouter();
const sidecars = ref<Sidecars | null>(null);
const catalog = ref<MediaPackCatalogView | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const catalogError = ref(false);

interface PackOperation {
  taskId: string | null;
  phase: MediaPackPhase | null;
  receivedBytes: number;
  totalBytes: number;
  status: "idle" | "running" | "done" | "failed" | "cancelled";
}

const operations = reactive<Record<PackId, PackOperation>>({
  preview: { taskId: null, phase: null, receivedBytes: 0, totalBytes: 0, status: "idle" },
  transcode: { taskId: null, phase: null, receivedBytes: 0, totalBytes: 0, status: "idle" },
});
let unlistenProgress: UnlistenFn | null = null;
let unlistenDone: UnlistenFn | null = null;

const requiredPack = computed<PackId | null>(() => {
  const value = Array.isArray(route.query.required) ? route.query.required[0] : route.query.required;
  return value === "preview" || value === "transcode" ? value : null;
});
const returnTo = computed(() => {
  const value = Array.isArray(route.query.returnTo) ? route.query.returnTo[0] : route.query.returnTo;
  return value === "/tools/video-trim" ? value : "/tools/video-trim";
});

const packDefinitions = [
  {
    id: "preview" as const,
    icon: "video",
    bytes: 45_356_407,
    components: ["mpv"] as const,
  },
  {
    id: "transcode" as const,
    icon: "wand",
    bytes: 183_797_099,
    components: ["ffmpeg", "ffprobe"] as const,
  },
];

const packs = computed(() => packDefinitions.map((definition) => {
  const detected = definition.components.filter((component) => sidecars.value?.[component].available).length;
  const trusted = catalog.value?.packs.find((item) => item.id === definition.id);
  const damaged = trusted?.damaged || definition.components.some(
    (component) => sidecars.value?.[component].reason === "media-pack-damaged",
  );
  const state: PackState = detected === definition.components.length
    ? "detected"
    : damaged
      ? "damaged"
      : detected > 0
        ? "partial"
        : "missing";
  return {
    ...definition,
    bytes: trusted?.downloadBytes ?? definition.bytes,
    state,
    trusted,
    operation: operations[definition.id],
  };
}));
const allDetected = computed(() => packs.value.every((pack) => pack.state === "detected"));
const trustReady = computed(() => catalog.value?.trustState === "ready");

function stateLabel(state: PackState): string {
  return t(`mediaRuntime.state.${state}`);
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  catalogError.value = false;
  const [sidecarResult, catalogResult] = await Promise.allSettled([
    ipc.mediaSidecars(),
    ipc.mediaPackCatalog(),
  ]);
  if (sidecarResult.status === "fulfilled") {
    sidecars.value = sidecarResult.value;
  } else {
    sidecars.value = null;
    error.value = t("mediaRuntime.detectFailed");
  }
  if (catalogResult.status === "fulfilled") {
    catalog.value = catalogResult.value;
    catalogError.value = catalogResult.value.trustState === "unavailable";
  } else {
    catalog.value = { trustState: "unavailable", reason: "catalog-unavailable", publicKeyFingerprint: null, packs: [] };
    catalogError.value = true;
  }
  loading.value = false;
}

function progressPercent(operation: PackOperation): number {
  if (operation.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((operation.receivedBytes / operation.totalBytes) * 100));
}

function phaseLabel(phase: MediaPackPhase | null): string {
  return phase ? t(`mediaRuntime.phase.${phase}`) : "";
}

async function install(packId: PackId, bytes: number, repair: boolean): Promise<void> {
  if (!trustReady.value || operations[packId].status === "running") return;
  if (!window.confirm(t(repair ? "mediaRuntime.repairConfirm" : "mediaRuntime.installConfirm", {
    pack: t(`mediaRuntime.pack.${packId}.title`),
    size: formatBytes(bytes),
  }))) return;
  const operation = operations[packId];
  operation.status = "running";
  operation.phase = "downloading";
  operation.receivedBytes = 0;
  operation.totalBytes = bytes;
  try {
    const taskId = await ipc.mediaPackInstall(packId);
    if (operation.status === "running") operation.taskId ??= taskId;
  } catch {
    operation.status = "failed";
    operation.phase = null;
  }
}

async function cancel(packId: PackId): Promise<void> {
  const taskId = operations[packId].taskId;
  if (!taskId) return;
  await ipc.mediaPackCancel(taskId).catch(() => {});
}

async function rollback(packId: PackId): Promise<void> {
  if (!window.confirm(t("mediaRuntime.rollbackConfirm"))) return;
  try {
    await ipc.mediaPackRollback(packId);
    await refresh();
  } catch {
    operations[packId].status = "failed";
  }
}

async function subscribeInstallEvents(): Promise<void> {
  try {
    unlistenProgress = await listen<MediaPackProgressEvent>("media-pack-progress", ({ payload }) => {
      const operation = operations[payload.packId];
      if (!operation || operation.status !== "running" || (operation.taskId && operation.taskId !== payload.taskId)) return;
      operation.taskId ??= payload.taskId;
      operation.phase = payload.phase;
      operation.receivedBytes = payload.receivedBytes;
      operation.totalBytes = payload.totalBytes;
    });
    unlistenDone = await listen<MediaPackDoneEvent>("media-pack-done", ({ payload }) => {
      const operation = operations[payload.packId];
      if (!operation || operation.status !== "running" || (operation.taskId && operation.taskId !== payload.taskId)) return;
      operation.taskId ??= payload.taskId;
      operation.status = payload.status;
      operation.phase = null;
      operation.taskId = null;
      if (payload.status === "done") void refresh();
    });
  } catch {
    // Browser-only preview has no Tauri event bridge; commands remain fail closed.
  }
}

async function returnToTool(): Promise<void> {
  await router.push(returnTo.value);
}

onMounted(async () => {
  await subscribeInstallEvents();
  await refresh();
});
onUnmounted(() => {
  unlistenProgress?.();
  unlistenDone?.();
});
</script>

<template>
  <main class="runtime-page">
    <header class="runtime-hero">
      <div>
        <p class="runtime-hero__eyebrow">{{ t("mediaRuntime.eyebrow") }}</p>
        <h1>{{ t("mediaRuntime.title") }}</h1>
        <p>{{ t("mediaRuntime.subtitle") }}</p>
      </div>
      <button class="useful-btn" :disabled="loading" data-testid="refresh-media-runtime" @click="refresh">
        <AppIcon name="refresh" :size="16" />{{ t("mediaRuntime.refresh") }}
      </button>
    </header>

    <div class="runtime-trust" :class="{ 'runtime-trust--ready': trustReady }" role="status">
      <AppIcon name="shield" :size="20" />
      <div>
        <strong>{{ trustReady ? t("mediaRuntime.sourceReadyTitle") : t("mediaRuntime.candidateTitle") }}</strong>
        <p>{{ trustReady ? t("mediaRuntime.sourceReadyHint") : catalogError ? t("mediaRuntime.catalogUnavailable") : t("mediaRuntime.candidateHint") }}</p>
      </div>
    </div>

    <StateBlock v-if="loading" variant="loading" :title="t('mediaRuntime.detecting')" />
    <p v-if="!loading && error" class="runtime-error" role="alert">{{ error }}</p>

    <section v-if="!loading" class="runtime-grid" :aria-label="t('mediaRuntime.packList')">
      <article
        v-for="pack in packs"
        :key="pack.id"
        class="runtime-card useful-card"
        :class="{ 'runtime-card--required': requiredPack === pack.id }"
        :data-testid="`media-pack-${pack.id}`"
      >
        <div class="runtime-card__head">
          <span class="runtime-card__icon"><AppIcon :name="pack.icon" :size="24" /></span>
          <div>
            <h2>{{ t(`mediaRuntime.pack.${pack.id}.title`) }}</h2>
            <p>{{ t(`mediaRuntime.pack.${pack.id}.purpose`) }}</p>
          </div>
          <span
            class="useful-badge"
            :class="{
              'useful-badge--ok': pack.state === 'detected',
              'useful-badge--warning': pack.state !== 'detected',
            }"
          >
            {{ stateLabel(pack.state) }}
          </span>
        </div>

        <dl class="runtime-facts">
          <div>
            <dt>{{ t("mediaRuntime.components") }}</dt>
            <dd class="useful-mono">{{ pack.components.join(" + ") }}</dd>
          </div>
          <div>
            <dt>{{ t("mediaRuntime.downloadSize") }}</dt>
            <dd>{{ formatBytes(pack.bytes) }}</dd>
          </div>
        </dl>

        <p v-if="requiredPack === pack.id && pack.state !== 'detected'" class="runtime-required">
          {{ t("mediaRuntime.requiredForImport") }}
        </p>
        <p v-if="pack.state === 'damaged'" class="runtime-error" role="alert">
          {{ t("mediaRuntime.damagedHint") }}
        </p>
        <div v-if="pack.operation.status === 'running'" class="runtime-progress" role="status">
          <div class="runtime-progress__row">
            <span>{{ phaseLabel(pack.operation.phase) }}</span>
            <span>{{ progressPercent(pack.operation) }}%</span>
          </div>
          <progress :value="progressPercent(pack.operation)" max="100" />
          <button class="useful-btn" :data-testid="`cancel-${pack.id}`" @click="cancel(pack.id)">
            {{ t("mediaRuntime.cancel") }}
          </button>
        </div>
        <button
          v-else-if="pack.state !== 'detected' && trustReady"
          class="useful-btn useful-btn--primary"
          :data-testid="`install-${pack.id}`"
          @click="install(pack.id, pack.bytes, pack.state === 'damaged')"
        >
          <AppIcon name="download" :size="16" />{{ t(pack.state === "damaged" ? "mediaRuntime.repair" : "mediaRuntime.install") }}
        </button>
        <button
          v-else-if="pack.state !== 'detected'"
          class="useful-btn useful-btn--primary"
          disabled
          :title="t('mediaRuntime.installBlockedHint')"
          :data-testid="`install-${pack.id}`"
        >
          <AppIcon name="download" :size="16" />{{ t("mediaRuntime.installBlocked") }}
        </button>
        <p v-else class="runtime-ready">
          <AppIcon name="check" :size="16" />{{ t("mediaRuntime.detectedHint") }}
        </p>
        <button
          v-if="pack.trusted?.previousAvailable && pack.operation.status !== 'running'"
          class="useful-btn runtime-rollback"
          :data-testid="`rollback-${pack.id}`"
          @click="rollback(pack.id)"
        >
          {{ t("mediaRuntime.rollback") }}
        </button>
        <p v-if="pack.operation.status === 'done'" class="runtime-ready">{{ t("mediaRuntime.installDone") }}</p>
        <p v-if="pack.operation.status === 'failed'" class="runtime-error" role="alert">{{ t("mediaRuntime.installFailed") }}</p>
        <p v-if="pack.operation.status === 'cancelled'" class="runtime-note">{{ t("mediaRuntime.installCancelled") }}</p>
      </article>
    </section>

    <footer class="runtime-footer">
      <p>{{ allDetected ? t("mediaRuntime.allReady") : t("mediaRuntime.noSilentInstall") }}</p>
      <button class="useful-btn useful-btn--primary" data-testid="return-video-trim" @click="returnToTool">
        <AppIcon name="chevronLeft" :size="16" />{{ t("mediaRuntime.returnToTool") }}
      </button>
    </footer>
  </main>
</template>

<style scoped>
.runtime-page { padding: var(--useful-space-5); height: 100%; overflow: auto; }
.runtime-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--useful-space-4); }
.runtime-hero h1 { margin: 0; font-size: var(--useful-text-xl); }
.runtime-hero p { margin: var(--useful-space-1) 0 0; color: var(--useful-text-secondary); }
.runtime-hero__eyebrow { color: var(--useful-accent) !important; font-size: var(--useful-text-xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.runtime-trust { display: flex; gap: var(--useful-space-3); margin: var(--useful-space-4) 0; padding: var(--useful-space-3); border: 1px solid color-mix(in srgb, var(--useful-warning) 38%, var(--useful-border)); border-radius: var(--useful-radius-md); background: color-mix(in srgb, var(--useful-warning) 9%, transparent); }
.runtime-trust strong { color: var(--useful-warning); }
.runtime-trust--ready { border-color: color-mix(in srgb, var(--useful-success) 38%, var(--useful-border)); background: color-mix(in srgb, var(--useful-success) 8%, transparent); }
.runtime-trust--ready strong { color: var(--useful-success); }
.runtime-trust p { margin: 3px 0 0; color: var(--useful-text-secondary); font-size: var(--useful-text-sm); }
.runtime-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--useful-space-4); }
.runtime-card { padding: var(--useful-space-4); }
.runtime-card--required { border-color: var(--useful-accent); box-shadow: 0 0 0 1px var(--useful-accent); }
.runtime-card__head { display: grid; grid-template-columns: auto 1fr auto; gap: var(--useful-space-3); align-items: start; }
.runtime-card__head h2 { margin: 0; font-size: var(--useful-text-lg); }
.runtime-card__head p { margin: 4px 0 0; color: var(--useful-text-secondary); font-size: var(--useful-text-sm); }
.runtime-card__icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: var(--useful-radius-md); color: var(--useful-accent); background: var(--useful-bg-selected); }
.runtime-facts { display: grid; grid-template-columns: 1fr 1fr; gap: var(--useful-space-3); margin: var(--useful-space-4) 0; }
.runtime-facts div { padding: var(--useful-space-3); border-radius: var(--useful-radius-md); background: var(--useful-bg-layer); }
.runtime-facts dt { color: var(--useful-text-tertiary); font-size: var(--useful-text-xs); }
.runtime-facts dd { margin: 5px 0 0; }
.runtime-required { color: var(--useful-warning); font-size: var(--useful-text-sm); }
.runtime-ready { display: flex; align-items: center; gap: var(--useful-space-2); color: var(--useful-success); font-size: var(--useful-text-sm); }
.runtime-note { color: var(--useful-text-secondary); font-size: var(--useful-text-sm); }
.runtime-progress { display: grid; gap: var(--useful-space-2); }
.runtime-progress__row { display: flex; justify-content: space-between; color: var(--useful-text-secondary); font-size: var(--useful-text-sm); }
.runtime-progress progress { width: 100%; accent-color: var(--useful-accent); }
.runtime-progress .useful-btn { justify-self: start; }
.runtime-rollback { margin-top: var(--useful-space-2); }
.runtime-error { margin: 0 0 var(--useful-space-4); padding: var(--useful-space-3); border: 1px solid color-mix(in srgb, var(--useful-danger) 38%, var(--useful-border)); border-radius: var(--useful-radius-md); color: var(--useful-danger); background: color-mix(in srgb, var(--useful-danger) 7%, transparent); }
.runtime-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--useful-space-4); margin-top: var(--useful-space-4); color: var(--useful-text-secondary); font-size: var(--useful-text-sm); }
@media (max-width: 820px) {
  .runtime-grid { grid-template-columns: 1fr; }
  .runtime-hero, .runtime-footer { align-items: stretch; flex-direction: column; }
}
</style>
