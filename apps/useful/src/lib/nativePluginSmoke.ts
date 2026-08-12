import { nextTick } from "vue";
import type { Router } from "vue-router";
import { emit, listen } from "@tauri-apps/api/event";
import ipc from "@/lib/ipc";
import type { useAppStore } from "@/stores/app";

interface PluginUnderTest {
  id: string;
  name: string;
  route: string;
  version?: string;
}

export interface NativePluginSmokeStart {
  commit: string;
  version: string;
  plugins: PluginUnderTest[];
  bootstrapFailures: string[];
}

type AppStore = ReturnType<typeof useAppStore>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const PALETTE_OPEN_TIMEOUT_MS = 10_000;
const PALETTE_POLL_INTERVAL_MS = 50;

async function waitForPaletteInput(
  timeoutMs = PALETTE_OPEN_TIMEOUT_MS,
): Promise<HTMLInputElement> {
  const deadline = performance.now() + timeoutMs;
  let input = document.querySelector<HTMLInputElement>(".palette__input");
  while (!input && performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    await delay(Math.min(PALETTE_POLL_INTERVAL_MS, remainingMs));
    input = document.querySelector<HTMLInputElement>(".palette__input");
  }
  if (input) return input;
  throw new Error(`Ctrl+K 未在 ${timeoutMs}ms 内打开命令面板`);
}

async function waitForReceipt(
  receipts: Map<string, unknown>,
  pluginId: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  const started = performance.now();
  while (!receipts.has(pluginId)) {
    if (performance.now() - started > timeoutMs) {
      throw new Error(`插件入口未在 ${timeoutMs}ms 内报告 ready: ${pluginId}`);
    }
    await delay(50);
  }
  return receipts.get(pluginId);
}

async function assertPaletteContains(name: string): Promise<void> {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  let input: HTMLInputElement | null = null;
  try {
    // The first Ctrl+K may need to fetch and mount the async palette chunk.
    // Poll to a fixed deadline so a cold start is covered without hanging smoke.
    input = await waitForPaletteInput();
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const labels = [...document.querySelectorAll<HTMLElement>(".palette__label")]
      .map((node) => node.textContent?.trim());
    if (!labels.includes(name)) throw new Error(`命令面板未出现插件: ${name}`);
  } finally {
    const openInput = input?.isConnected
      ? input
      : document.querySelector<HTMLInputElement>(".palette__input");
    if (openInput) {
      openInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else {
      // A rejected or overdue async palette chunk has no input to receive
      // Escape. Reuse App's global Ctrl+K toggle to close the state opened above,
      // so a chunk that settles later cannot render a stale palette.
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
      }));
    }
    await nextTick();
  }
}

export async function runNativePluginSmoke(
  router: Router,
  appStore: AppStore,
  start: NativePluginSmokeStart,
): Promise<void> {
  const started = performance.now();
  const failures = start.bootstrapFailures.map((message) => ({ id: "bootstrap", message }));
  const checks: Array<Record<string, unknown>> = [];
  const receipts = new Map<string, unknown>();
  const favoritesAdded = new Set<string>();
  const bridgeMessages: Array<Record<string, unknown>> = [];
  const observeBridgeMessage = (event: MessageEvent): void => {
    const data = event.data as { __useful?: unknown; method?: unknown } | null;
    if (!data || data.__useful !== true) return;
    const frame = document.querySelector<HTMLIFrameElement>(".plugin-host__frame");
    bridgeMessages.push({
      method: typeof data.method === "string" ? data.method : "response",
      origin: event.origin,
      hasSource: event.source !== null,
      sourceMatchesFrame: event.source === frame?.contentWindow,
    });
  };
  window.addEventListener("message", observeBridgeMessage);
  const unlistenReady = await listen<{ pluginId: string; details?: unknown }>(
    "plugin-ready-observed",
    (event) => receipts.set(event.payload.pluginId, event.payload.details),
  );

  try {
    if (start.plugins.length === 0) {
      failures.push({ id: "plugin-count", message: "至少需要 1 个插件" });
    }
    for (const plugin of start.plugins) {
      const checkStarted = performance.now();
      try {
        if (!appStore.toolById(plugin.id)) throw new Error("插件未进入统一 Rust/前端注册表");
        await router.push(plugin.route);
        await nextTick();
        const details = await waitForReceipt(receipts, plugin.id);
        await delay(100);
        const frame = document.querySelector<HTMLIFrameElement>(`.plugin-host__frame[title="${CSS.escape(plugin.name)}"]`);
        if (!frame || frame.classList.contains("plugin-host__frame--hidden")) {
          throw new Error("插件沙箱 iframe 未成功加载");
        }
        await assertPaletteContains(plugin.name);
        const shortcut = await ipc.createShortcut(plugin.id);
        if (!shortcut.args.includes("--open-tool") || !shortcut.args.includes(plugin.id)) {
          throw new Error("插件快捷方式参数未绑定稳定 tool ID");
        }
        const favoriteAdded = await ipc.toggleFavorite(plugin.id);
        if (!favoriteAdded) throw new Error("隔离数据目录中的首次收藏未成功");
        favoritesAdded.add(plugin.id);
        checks.push({
          id: plugin.id,
          name: plugin.name,
          route: plugin.route,
          ready: true,
          readyDetails: details,
          palette: true,
          shortcut: { id: shortcut.id, path: shortcut.lnkPath, args: shortcut.args },
          durationMs: performance.now() - checkStarted,
          passed: true,
        });
      } catch (error) {
        const frame = document.querySelector<HTMLIFrameElement>(".plugin-host__frame");
        const hostError = document.querySelector<HTMLElement>(".plugin-host .state-block")?.textContent?.trim();
        const message = [
          String(error),
          `frame=${frame ? `${frame.src}, hidden=${frame.classList.contains("plugin-host__frame--hidden")}` : "missing"}`,
          `bridgeMessages=${JSON.stringify(bridgeMessages.slice(-3))}`,
          hostError ? `hostError=${hostError}` : "",
        ].filter(Boolean).join("; ");
        failures.push({ id: plugin.id, message });
        checks.push({ id: plugin.id, passed: false, message, durationMs: performance.now() - checkStarted });
      }
    }

    for (const plugin of start.plugins) {
      try {
        await ipc.uninstallPlugin(plugin.id);
      } catch (error) {
        failures.push({ id: `${plugin.id}.uninstall`, message: String(error) });
      }
    }
    await appStore.reloadTools();
    const installedAfter = await ipc.listPlugins();
    const shortcutsAfter = await ipc.listShortcuts();
    const favoritesAfter = await ipc.getFavorites();
    for (const plugin of start.plugins) {
      if (installedAfter.some((tool) => tool.id === plugin.id) || appStore.toolById(plugin.id)) {
        failures.push({ id: `${plugin.id}.index-cleanup`, message: "卸载后插件仍在注册表或搜索索引" });
      }
      if (shortcutsAfter.some((shortcut) => shortcut.toolId === plugin.id)) {
        failures.push({ id: `${plugin.id}.shortcut-cleanup`, message: "卸载后快捷方式记录仍存在" });
      }
      if (favoritesAdded.has(plugin.id) && !favoritesAfter.includes(plugin.id)) {
        failures.push({ id: `${plugin.id}.favorite-tombstone`, message: "卸载后稳定收藏 ID 未保留" });
      }
    }
  } catch (error) {
    failures.push({ id: "native-plugin-smoke", message: String(error) });
  } finally {
    window.removeEventListener("message", observeBridgeMessage);
    unlistenReady();
  }

  await emit("native-plugin-smoke-result", {
    scenario: "native-tauri-plugin-lifecycle",
    commit: start.commit,
    version: start.version,
    total: start.plugins.length,
    passed: checks.filter((check) => check.passed === true).length,
    failed: failures.length,
    durationMs: performance.now() - started,
    failures,
    checks,
  });
}
