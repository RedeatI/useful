<script setup lang="ts">
// 插件宿主：将第三方 web 插件加载到沙箱 iframe，通过 postMessage 与宿主桥通信。
// 第三方页面不能直接访问 window.__TAURI__。
import { computed, nextTick, ref, onMounted, onUnmounted, watch } from "vue";
import { useAppStore } from "@/stores/app";
import { createBridgeCapability, createPluginBridge } from "@/lib/pluginBridge";
import { t } from "@/i18n";
import { toolErrorMessage } from "@/lib/tools/errors";
import StateBlock from "@/components/StateBlock.vue";

const props = defineProps<{ id: string }>();
const appStore = useAppStore();

const iframeRef = ref<HTMLIFrameElement | null>(null);
const iframeSrc = ref("");
const loadError = ref<string | null>(null);
const loading = ref(true);
const capability = ref("");
const loadGeneration = ref(0);

const tool = computed(() => appStore.toolById(props.id));

// WebView2 仅拦截 Wry 的 http workaround origin；其他平台使用原始自定义 scheme。
function pluginUrl(pluginId: string, secret: string): string {
  const origin = window.location.hostname === "tauri.localhost" && window.location.protocol === "http:"
    ? "http://usefulplugin.localhost"
    : "usefulplugin://localhost";
  return `${origin}/${encodeURIComponent(pluginId)}/index.html#usefulCapability=${encodeURIComponent(secret)}`;
}

let bridge: ReturnType<typeof createPluginBridge> | null = null;
let awaitingExplicitLoad = false;

function mountBridge(pluginId: string, secret: string): void {
  bridge?.dispose();
  if (!iframeRef.value) return;
  bridge = createPluginBridge({
    pluginId,
    iframe: iframeRef.value,
    capability: secret,
    onError: (msg) => {
      loadError.value = toolErrorMessage(msg);
    },
  });
}

async function loadPlugin(): Promise<void> {
  bridge?.dispose();
  bridge = null;
  iframeSrc.value = "";
  const generation = ++loadGeneration.value;
  if (!tool.value) return;
  const pluginId = props.id;
  const secret = createBridgeCapability();
  capability.value = secret;
  awaitingExplicitLoad = true;
  await nextTick();
  if (generation !== loadGeneration.value) return;
  iframeSrc.value = pluginUrl(pluginId, secret);
  await nextTick();
  if (generation !== loadGeneration.value) return;
  // 监听器在真实插件文档 load 前安装；此时的 bootstrap 一律会被关闭。
  mountBridge(pluginId, secret);
}

function onIframeLoad(): void {
  if (awaitingExplicitLoad) {
    awaitingExplicitLoad = false;
    // SDK 会等自身 load 后的下一 task 才发送，宿主先在该 load 回调中绑定此文档。
    if (!bridge) mountBridge(props.id, capability.value);
    if (!bridge?.armForLoadedDocument()) {
      bridge?.dispose();
      bridge = null;
      loadError.value = t("pluginHost.loadFailed");
      loading.value = false;
      return;
    }
    loading.value = false;
    return;
  }
  // reload / document navigation 是新的 load generation；未由宿主明确加载的文档不继承能力。
  bridge?.dispose();
  bridge = null;
}
function onIframeError(): void {
  bridge?.dispose();
  bridge = null;
  loading.value = false;
  loadError.value = t("pluginHost.loadFailed");
}

watch(() => props.id, () => {
  loading.value = true;
  loadError.value = null;
  void loadPlugin();
});

onMounted(() => {
  void loadPlugin();
});
onUnmounted(() => bridge?.dispose());
</script>

<template>
  <div class="plugin-host">
    <StateBlock
      v-if="!tool"
      variant="error"
      :title="t('pluginHost.notFoundTitle')"
      :hint="t('pluginHost.notFoundHint', { id })"
    />
    <StateBlock
      v-else-if="loadError"
      variant="error"
      :hint="loadError"
      retryable
      @retry="() => { loadError = null; loading = true; void loadPlugin(); }"
    />
    <template v-else>
      <div v-if="loading" class="plugin-host__loading">
        <StateBlock variant="loading" />
      </div>
      <!-- 插件协议与宿主跨源；保留插件自身同源以允许严格 self CSP，禁止 top navigation / 弹窗劫持。 -->
      <iframe
        v-if="iframeSrc"
        :key="loadGeneration"
        ref="iframeRef"
        class="plugin-host__frame"
        :class="{ 'plugin-host__frame--hidden': loading }"
        :src="iframeSrc"
        :title="tool.name"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        @load="onIframeLoad"
        @error="onIframeError"
      />
    </template>
  </div>
</template>

<style scoped>
.plugin-host {
  height: 100%;
  position: relative;
}
.plugin-host__frame {
  width: 100%;
  height: 100%;
  border: none;
  background: var(--useful-bg);
}
.plugin-host__frame--hidden {
  visibility: hidden;
}
.plugin-host__loading {
  position: absolute;
  inset: 0;
}
</style>
