// 应用状态：工具注册表、收藏、最近使用、action 级收藏与最近使用。侧边栏由此驱动，不硬编码第三方工具。
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import ipc from "@/lib/ipc";
import type { AgentProfileView, AppInfo, ToolDefinition } from "@/lib/types";
import { findBuiltinAction, type BuiltinGuiAction } from "@/lib/actionCatalog";

export const useAppStore = defineStore("app", () => {
  const tools = ref<ToolDefinition[]>([]);
  const favorites = ref<string[]>([]);
  const recent = ref<string[]>([]);
  // Phase 12: action 级状态
  const actionFavorites = ref<string[]>([]);
  const actionRecent = ref<string[]>([]);
  const navigationPins = ref<string[]>([]);
  const agentProfile = ref<AgentProfileView | null>(null);
  const appInfo = ref<AppInfo | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const builtinTools = computed(() =>
    tools.value.filter((t) => t.category === "builtin"),
  );
  const installedTools = computed(() =>
    tools.value.filter((t) => t.category === "installed"),
  );

  function toolById(id: string): ToolDefinition | undefined {
    return tools.value.find((t) => t.id === id);
  }

  const favoriteTools = computed(() =>
    favorites.value
      .map((id) => toolById(id))
      .filter((t): t is ToolDefinition => !!t),
  );
  const recentTools = computed(() =>
    recent.value
      .map((id) => toolById(id))
      .filter((t): t is ToolDefinition => !!t),
  );

  // ---------- Action 级计算属性 ----------

  /** 收藏的 actions（查找失败时保留 ID，不报错） */
  const favoriteActions = computed<BuiltinGuiAction[]>(() =>
    actionFavorites.value
      .map((id) => findBuiltinAction(id))
      .filter((a): a is BuiltinGuiAction => !!a),
  );

  /** 最近使用的 actions */
  const recentActions = computed<BuiltinGuiAction[]>(() =>
    actionRecent.value
      .map((id) => findBuiltinAction(id))
      .filter((a): a is BuiltinGuiAction => !!a),
  );

  async function loadAll(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const [info, list, favs, rec, actFavs, actRec, pins, profile] = await Promise.all([
        ipc.getAppInfo(),
        ipc.listTools(),
        ipc.getFavorites(),
        ipc.getRecentTools(),
        ipc.getActionFavorites(),
        ipc.getActionRecent(),
        ipc.navigationPinsGet(),
        ipc.agentProfileGet(),
      ]);
      appInfo.value = info;
      tools.value = list;
      favorites.value = favs;
      recent.value = rec;
      actionFavorites.value = actFavs;
      actionRecent.value = actRec;
      navigationPins.value = pins;
      agentProfile.value = profile;
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function reloadTools(): Promise<void> {
    tools.value = await ipc.listTools();
  }

  async function toggleFavorite(toolId: string): Promise<void> {
    const isFav = await ipc.toggleFavorite(toolId);
    if (isFav) {
      if (!favorites.value.includes(toolId)) favorites.value.push(toolId);
    } else {
      favorites.value = favorites.value.filter((id) => id !== toolId);
    }
  }

  function isFavorite(toolId: string): boolean {
    return favorites.value.includes(toolId);
  }

  async function recordUse(toolId: string): Promise<void> {
    await ipc.recordToolUse(toolId);
    recent.value = [toolId, ...recent.value.filter((id) => id !== toolId)].slice(0, 12);
  }

  // ---------- Action 级操作 ----------

  async function toggleActionFav(actionId: string): Promise<void> {
    const isFav = await ipc.toggleActionFavorite(actionId);
    if (isFav) {
      if (!actionFavorites.value.includes(actionId)) actionFavorites.value.push(actionId);
    } else {
      actionFavorites.value = actionFavorites.value.filter((id) => id !== actionId);
    }
  }

  function isActionFavorite(actionId: string): boolean {
    return actionFavorites.value.includes(actionId);
  }

  async function recordActionUse(actionId: string): Promise<void> {
    await ipc.recordActionUse(actionId);
    actionRecent.value = [
      actionId,
      ...actionRecent.value.filter((id) => id !== actionId),
    ].slice(0, 12);
  }

  async function clearActionRecent(): Promise<void> {
    await ipc.clearActionRecent();
    actionRecent.value = [];
  }

  function isPinned(itemId: string): boolean {
    return navigationPins.value.includes(itemId);
  }

  async function setPinned(itemId: string, pinned: boolean): Promise<void> {
    await ipc.navigationPinSet(itemId, pinned);
    navigationPins.value = pinned
      ? [...navigationPins.value.filter((id) => id !== itemId), itemId]
      : navigationPins.value.filter((id) => id !== itemId);
  }

  function setAgentProfile(view: AgentProfileView): void {
    agentProfile.value = view;
  }

  return {
    tools,
    favorites,
    recent,
    actionFavorites,
    actionRecent,
    navigationPins,
    agentProfile,
    appInfo,
    loading,
    error,
    builtinTools,
    installedTools,
    favoriteTools,
    recentTools,
    favoriteActions,
    recentActions,
    toolById,
    loadAll,
    reloadTools,
    toggleFavorite,
    isFavorite,
    recordUse,
    toggleActionFav,
    isActionFavorite,
    recordActionUse,
    clearActionRecent,
    isPinned,
    setPinned,
    setAgentProfile,
  };
});
