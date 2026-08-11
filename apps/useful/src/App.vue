<script setup lang="ts">
import { defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppSidebar from "@/components/AppSidebar.vue";
import { useAppStore } from "@/stores/app";
import { useUiStore } from "@/stores/ui";
import { emit, listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { NativeSmokeStart } from "@/lib/nativeSmoke";
import type { NativePluginSmokeStart } from "@/lib/nativePluginSmoke";
import { t } from "@/i18n";
import { findBuiltinAction } from "@/lib/actionCatalog";
import { requestOpenFile } from "@/lib/openFileBus";

const CommandPalette = defineAsyncComponent(() => import("@/components/CommandPalette.vue"));

const appStore = useAppStore();
const uiStore = useUiStore();
const router = useRouter();
const commandPaletteLoaded = ref(uiStore.commandPaletteOpen);

// Do not request the palette chunk during initial render. Once opened, retain the
// component so its own close watcher can restore focus and future opens stay warm.
watch(
  () => uiStore.commandPaletteOpen,
  (isOpen) => {
    if (isOpen) commandPaletteLoaded.value = true;
  },
  { flush: "sync" },
);

let unlistenOpenTool: UnlistenFn | null = null;
let unlistenNativeSmoke: UnlistenFn | null = null;
let unlistenNativePluginSmoke: UnlistenFn | null = null;
let unlistenNativeReceipts: UnlistenFn | null = null;
let nativeReceiptsEnabled = false;
let nativeSmokeModule: Promise<typeof import("@/lib/nativeSmoke")> | null = null;
let nativePluginSmokeModule: Promise<typeof import("@/lib/nativePluginSmoke")> | null = null;
let nativeSmokeStarted = false;
let nativePluginSmokeStarted = false;

function loadNativeSmoke() {
  nativeSmokeModule ??= import("@/lib/nativeSmoke");
  return nativeSmokeModule;
}

function loadNativePluginSmoke() {
  nativePluginSmokeModule ??= import("@/lib/nativePluginSmoke");
  return nativePluginSmokeModule;
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function emitNativeSmokeBootstrapFailure(
  start: NativeSmokeStart,
  stage: "module load" | "runner",
  error: unknown,
): Promise<void> {
  const message = `native smoke ${stage} failed: ${failureDetail(error)}`;
  try {
    await emit("native-smoke-result", {
      scenario: "native-tauri-all-tools",
      commit: start.commit,
      version: start.version,
      total: 0,
      passed: 0,
      failed: 1,
      durationMs: 0,
      failures: [{ id: "bootstrap", message }],
      artifacts: [],
      checks: [],
      registryActionCount: 0,
      expectedMinimum: 0,
      uniqueFailureIds: ["bootstrap"],
      nativeCapabilities: {
        registryIpcPassed: false,
        sqlitePersistedFromPreviousRun: false,
        sqliteFavoritesPassed: false,
        sqliteRecentPassed: false,
        clipboardPassed: false,
        mediaFileOpened: false,
        mediaExportPassed: false,
        startupDeepLinkPassed: false,
        ffmpegAvailable: false,
        ffprobeAvailable: false,
        mpvAvailable: false,
        betaFeedbackExportPassed: false,
        isolatedPortableData: false,
      },
    });
  } catch {
    // The terminal event was attempted once. Never surface transport rejection
    // as an unhandled promise from a fire-and-forget Tauri event listener.
  }
}

async function emitNativePluginSmokeBootstrapFailure(
  start: NativePluginSmokeStart,
  stage: "module load" | "runner",
  error: unknown,
): Promise<void> {
  const failures = [
    ...start.bootstrapFailures.map((message) => ({ id: "bootstrap", message })),
    {
      id: "bootstrap",
      message: `native plugin smoke ${stage} failed: ${failureDetail(error)}`,
    },
  ];
  try {
    await emit("native-plugin-smoke-result", {
      scenario: "native-tauri-plugin-lifecycle",
      commit: start.commit,
      version: start.version,
      total: start.plugins.length,
      passed: 0,
      failed: failures.length,
      durationMs: 0,
      failures,
      checks: [],
    });
  } catch {
    // See emitNativeSmokeBootstrapFailure: event listeners must never leak a
    // rejected promise even if the Tauri event channel itself is unavailable.
  }
}

async function runNativeSmokeOnce(start: NativeSmokeStart): Promise<void> {
  if (nativeSmokeStarted) return;
  nativeSmokeStarted = true;
  let stage: "module load" | "runner" = "module load";
  try {
    const { runNativeSmoke } = await loadNativeSmoke();
    stage = "runner";
    await runNativeSmoke(router, start);
  } catch (error) {
    await emitNativeSmokeBootstrapFailure(start, stage, error);
  }
}

async function runNativePluginSmokeOnce(start: NativePluginSmokeStart): Promise<void> {
  if (nativePluginSmokeStarted) return;
  nativePluginSmokeStarted = true;
  let stage: "module load" | "runner" = "module load";
  try {
    const { runNativePluginSmoke } = await loadNativePluginSmoke();
    stage = "runner";
    await runNativePluginSmoke(router, appStore, start);
  } catch (error) {
    await emitNativePluginSmokeBootstrapFailure(start, stage, error);
  }
}

function onKeydown(e: KeyboardEvent): void {
  // Ctrl+K 打开命令面板
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    uiStore.toggleCommandPalette();
  }
}

onMounted(async () => {
  await uiStore.load();
  await appStore.loadAll();
  window.addEventListener("keydown", onKeydown);

  // 单实例二次启动 / 命令行 --open-tool / --open-action 时，后端发事件切换工具
  try {
    unlistenOpenTool = await listen<{ toolId: string; actionId?: string; file?: string }>(
      "open-tool",
      async (event) => {
        const { toolId, actionId, file } = event.payload;
        // Action 级直达只接受统一 GUI catalog 中的稳定 ID；未知 ID 不猜测路由。
        if (actionId) {
          const action = findBuiltinAction(actionId);
          const route = action?.route ?? "/library";
          await router.push(route);
          await nextTick();
          if (nativeReceiptsEnabled) {
            await emit("native-action-opened", {
              actionId,
              route: router.currentRoute.value.path,
              title: action ? t(action.nameKey) : "unknown",
              rendered: Boolean(document.querySelector("main")?.textContent?.trim()),
              at: new Date().toISOString(),
            });
          }
          return;
        }
        const tool = appStore.toolById(toolId);
        if (tool) {
          void appStore.recordUse(tool.id);
          await router.push(tool.route);
          await nextTick();
          if (file) {
            // Lazy routes may not have mounted yet after a single nextTick; bus drains on subscribe.
            requestOpenFile({ toolId, file });
            window.dispatchEvent(new CustomEvent("useful-open-file", {
              detail: { toolId, file },
            }));
          }
        }
      },
    );
    unlistenNativeSmoke = await listen<NativeSmokeStart>(
      "native-smoke-start",
      (event) => {
        // Register eagerly, load once on demand, and consume only the first
        // request so duplicate native events cannot run destructive cleanup twice.
        void runNativeSmokeOnce(event.payload);
      },
    );
    unlistenNativePluginSmoke = await listen<NativePluginSmokeStart>(
      "native-plugin-smoke-start",
      (event) => {
        void runNativePluginSmokeOnce(event.payload);
      },
    );
    unlistenNativeReceipts = await listen("native-action-receipts-enabled", () => {
      nativeReceiptsEnabled = true;
    });
    await emit("frontend-ready");
  } catch {
    // 非 Tauri 环境忽略
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  unlistenOpenTool?.();
  unlistenNativeSmoke?.();
  unlistenNativePluginSmoke?.();
  unlistenNativeReceipts?.();
});
</script>

<template>
  <div class="app-shell">
    <AppSidebar />
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
    <CommandPalette v-if="commandPaletteLoaded" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
.app-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  background: var(--useful-bg);
  position: relative;
}
.app-main > :deep(.useful-page),
.app-main > :deep(.pm) {
  /* 路由页自己管理滚动；确保设置等长页可完整展示 */
  max-height: 100%;
}
</style>
