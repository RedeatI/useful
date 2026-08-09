<script setup lang="ts">
import { nextTick, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import AppSidebar from "@/components/AppSidebar.vue";
import CommandPalette from "@/components/CommandPalette.vue";
import { useAppStore } from "@/stores/app";
import { useUiStore } from "@/stores/ui";
import { emit, listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { runNativeSmoke, type NativeSmokeStart } from "@/lib/nativeSmoke";
import { runNativePluginSmoke, type NativePluginSmokeStart } from "@/lib/nativePluginSmoke";
import { t } from "@/i18n";
import { findBuiltinAction } from "@/lib/actionCatalog";
import { requestOpenFile } from "@/lib/openFileBus";

const appStore = useAppStore();
const uiStore = useUiStore();
const router = useRouter();

let unlistenOpenTool: UnlistenFn | null = null;
let unlistenNativeSmoke: UnlistenFn | null = null;
let unlistenNativePluginSmoke: UnlistenFn | null = null;
let unlistenNativeReceipts: UnlistenFn | null = null;
let nativeReceiptsEnabled = false;

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
        void runNativeSmoke(router, event.payload);
      },
    );
    unlistenNativePluginSmoke = await listen<NativePluginSmokeStart>(
      "native-plugin-smoke-start",
      (event) => {
        void runNativePluginSmoke(router, appStore, event.payload);
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
    <CommandPalette />
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
