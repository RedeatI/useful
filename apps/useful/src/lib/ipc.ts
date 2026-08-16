// 类型安全的 Tauri invoke 封装。集中管理命令名，避免散落魔法字符串。
import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  AgentProfileView,
  AppUpdateSourceInfo,
  DiagEntry,
  DownloadRecord,
  EncoderSupport,
  ExportRequest,
  ExportStarted,
  MediaInfo,
  MediaPackCatalogView,
  ProcmonStats,
  Settings,
  ShopPackage,
  ShortcutRecord,
  Sidecars,
  SourceInfo,
  ToolDefinition,
  ToolVersionInfo,
  TrpMergedItem,
  TrpInstalledOrigin,
  TrpSourceInfo,
  TrpSourcePreview,
  TrpSyncResult,
  TrpUpdateCheck,
  SourceAccountInfo,
} from "./types";

export type ProbedMediaInfo = MediaInfo & {
  /** ffprobe 的容器/解复用器名称；扩展名不参与元数据识别。 */
  formatName?: string;
};

export interface MpvLoadResult {
  status: "loaded";
  backend: "mpv-windows";
}

export const ipc = {
  // Phase 0
  getAppInfo: (): Promise<AppInfo> => invoke("get_app_info"),
  listTools: (): Promise<ToolDefinition[]> => invoke("list_tools"),
  getSettings: (): Promise<Settings> => invoke("get_settings"),
  updateSetting: (key: string, value: string): Promise<void> =>
    invoke("update_setting", { key, value }),
  openTool: (toolId: string, file?: string): Promise<void> =>
    invoke("open_tool", { toolId, file: file ?? null }),
  openPath: (path: string): Promise<void> => invoke("open_path", { path }),
  /** 当前进程是否已提权；首发安全策略始终返回 canRequest=false。 */
  elevationStatus: (): Promise<{ elevated: boolean; platform: string; canRequest: boolean }> =>
    invoke("elevation_status"),
  /** 历史 ABI：首发版本稳定 fail closed，并指引用户从 Windows 外壳手动管理员启动。 */
  restartElevated: (openTool?: string): Promise<void> =>
    invoke("restart_elevated", { openTool: openTool ?? null }),
  getFavorites: (): Promise<string[]> => invoke("get_favorites"),
  toggleFavorite: (toolId: string): Promise<boolean> =>
    invoke("toggle_favorite", { toolId }),
  getRecentTools: (): Promise<string[]> => invoke("get_recent_tools"),
  recordToolUse: (toolId: string): Promise<void> =>
    invoke("record_tool_use", { toolId }),

  // Phase 12: action 级收藏与最近使用
  getActionFavorites: (): Promise<string[]> => invoke("get_action_favorites"),
  toggleActionFavorite: (actionId: string): Promise<boolean> =>
    invoke("toggle_action_favorite", { actionId }),
  getActionRecent: (): Promise<string[]> => invoke("get_action_recent"),
  recordActionUse: (actionId: string): Promise<void> =>
    invoke("record_action_use", { actionId }),
  clearActionRecent: (): Promise<void> => invoke("clear_action_recent"),

  // AI-5：固定应用数据路径中的 Agent profile 与独立导航 pin。
  agentProfileGet: (): Promise<AgentProfileView | null> => invoke("agent_profile_get"),
  agentProfileSave: (profileJson: string): Promise<AgentProfileView> =>
    invoke("agent_profile_save", { profileJson }),
  agentProfileExport: (): Promise<string> => invoke("agent_profile_export"),
  agentProfileOpenDirectory: (): Promise<void> => invoke("agent_profile_open_directory"),
  navigationPinsGet: (): Promise<string[]> => invoke("navigation_pins_get"),
  navigationPinSet: (itemId: string, pinned: boolean): Promise<void> =>
    invoke("navigation_pin_set", { itemId, pinned }),

  // 快捷方式
  createShortcut: (toolId: string): Promise<ShortcutRecord> =>
    invoke("create_shortcut", { toolId }),
  createActionShortcut: (actionId: string, displayName: string): Promise<ShortcutRecord> =>
    invoke("create_action_shortcut", { actionId, displayName }),
  listShortcuts: (): Promise<ShortcutRecord[]> => invoke("list_shortcuts"),
  deleteShortcut: (id: number): Promise<void> => invoke("delete_shortcut", { id }),
  repairAllShortcuts: (): Promise<number> => invoke("repair_all_shortcuts"),

  // Phase 1 插件
  installLocalPlugin: (archivePath: string): Promise<ToolDefinition> =>
    invoke("install_local_plugin", { archivePath }),
  listPlugins: (): Promise<ToolDefinition[]> => invoke("list_plugins"),
  uninstallPlugin: (pluginId: string): Promise<void> =>
    invoke("uninstall_plugin", { pluginId }),
  getPluginPermissions: (pluginId: string): Promise<string[]> =>
    invoke("get_plugin_permissions", { pluginId }),
  importLauncher: (name: string, target: string, args: string[]): Promise<ToolDefinition> =>
    invoke("import_launcher", { name, target, args }),

  // Phase 4 工具铺：源管理
  sourceAdd: (url: string, publicKey?: string): Promise<SourceInfo> =>
    invoke("source_add", { url, publicKey: publicKey ?? null }),
  sourceRefresh: (sourceId: string): Promise<SourceInfo> =>
    invoke("source_refresh", { sourceId }),
  sourceList: (): Promise<SourceInfo[]> => invoke("source_list"),
  sourceSetEnabled: (sourceId: string, enabled: boolean): Promise<void> =>
    invoke("source_set_enabled", { sourceId, enabled }),
  sourceRemove: (sourceId: string): Promise<void> =>
    invoke("source_remove", { sourceId }),
  shopCatalog: (): Promise<ShopPackage[]> => invoke("shop_catalog"),
  permissionDiff: (toolId: string, requested: string[]): Promise<string[]> =>
    invoke("permission_diff", { toolId, requested }),

  // Phase 6B 源中心（TRP v1 多源）
  trpSourcePreview: (url: string): Promise<TrpSourcePreview> =>
    invoke("trp_source_preview", { url }),
  trpSourceAdd: (
    url: string,
    expectedSourceId: string,
    expectedFingerprint: string,
    kind?: "tool" | "mirror",
  ): Promise<TrpSourceInfo> =>
    invoke("trp_source_add", {
      url,
      expectedSourceId,
      expectedFingerprint,
      kind: kind ?? null,
    }),
  trpSourceList: (): Promise<TrpSourceInfo[]> => invoke("trp_source_list"),
  trpSourceSetEnabled: (sourceId: string, enabled: boolean): Promise<void> =>
    invoke("trp_source_set_enabled", { sourceId, enabled }),
  trpSourceSetPriority: (sourceId: string, priority: number): Promise<void> =>
    invoke("trp_source_set_priority", { sourceId, priority }),
  trpSourceRemove: (sourceId: string): Promise<void> =>
    invoke("trp_source_remove", { sourceId }),
  trpSourceSync: (sourceId: string): Promise<TrpSyncResult> =>
    invoke("trp_source_sync", { sourceId }),
  trpSourceSyncAll: (): Promise<TrpSyncResult[]> => invoke("trp_source_sync_all"),
  trpCatalogSearch: (keyword: string): Promise<TrpMergedItem[]> =>
    invoke("trp_catalog_search", { keyword }),
  /** 只读回读安装来源绑定；调用方必须将其与安装前目录事实逐字段比对。 */
  trpInstalledOrigin: (toolId: string): Promise<TrpInstalledOrigin | null> =>
    invoke("trp_installed_origin", { toolId }),
  trpInstall: (
    sourceId: string,
    publisherKeyId: string,
    toolId: string,
    permissionsConfirmed: boolean,
  ): Promise<ToolDefinition> =>
    invoke("trp_install", { sourceId, publisherKeyId, toolId, permissionsConfirmed }),
  trpRollback: (
    toolId: string,
    targetVersion: string,
    permissionsConfirmed: boolean,
  ): Promise<ToolDefinition> =>
    invoke("trp_rollback", { toolId, targetVersion, permissionsConfirmed }),
  trpCheckUpdate: (toolId: string): Promise<TrpUpdateCheck> =>
    invoke("trp_check_update", { toolId }),

  // Phase 8 源账户（OAuth PKCE）
  sourceLogin: (sourceId: string): Promise<SourceAccountInfo> =>
    invoke("source_login", { sourceId }),
  sourceAccountGet: (sourceId: string): Promise<SourceAccountInfo | null> =>
    invoke("source_account_get", { sourceId }),
  sourceLogout: (sourceId: string): Promise<void> =>
    invoke("source_logout", { sourceId }),

  // Phase 4 下载与安装
  downloadAndInstall: (
    sourceId: string,
    packageId: string,
    version: string,
    allowDowngrade: boolean,
    permissionsConfirmed: boolean,
  ): Promise<string> =>
    invoke("download_and_install", {
      sourceId,
      packageId,
      version,
      allowDowngrade,
      permissionsConfirmed,
    }),
  downloadCancel: (downloadId: string): Promise<void> =>
    invoke("download_cancel", { downloadId }),
  downloadsList: (): Promise<DownloadRecord[]> => invoke("downloads_list"),
  downloadsClearFinished: (): Promise<void> => invoke("downloads_clear_finished"),

  // Phase 4 版本管理
  toolSetPinned: (toolId: string, pinned: boolean): Promise<void> =>
    invoke("tool_set_pinned", { toolId, pinned }),
  toolVersions: (toolId: string): Promise<ToolVersionInfo[]> =>
    invoke("tool_versions", { toolId }),
  toolRollback: (toolId: string): Promise<ToolDefinition> =>
    invoke("tool_rollback", { toolId }),

  // Phase 5 诊断包
  diagnosticsPreview: (): Promise<DiagEntry[]> => invoke("diagnostics_preview"),
  diagnosticsExport: (destPath: string): Promise<string> =>
    invoke("diagnostics_export", { destPath }),

  // Phase 10 客户端更新源（独立信任域，与工具源完全分离）
  appUpdateSourceGet: (): Promise<AppUpdateSourceInfo> => invoke("app_update_source_get"),
  appUpdateSourceSetCustom: (
    updateFeedUrl: string,
    updateRootPublicKey: string,
    warningAcknowledged: boolean,
  ): Promise<AppUpdateSourceInfo> =>
    invoke("app_update_source_set_custom", {
      updateFeedUrl,
      updateRootPublicKey,
      warningAcknowledged,
    }),
  appUpdateSourceResetOfficial: (): Promise<AppUpdateSourceInfo> =>
    invoke("app_update_source_reset_official"),
  appUpdateChannelSet: (channel: "stable" | "beta" | "nightly"): Promise<AppUpdateSourceInfo> =>
    invoke("app_update_channel_set", { channel }),

  // Phase 2 进程监视器（事件驱动：监听 procmon-delta）
  procmonStart: (): Promise<void> => invoke("procmon_start"),
  procmonStop: (): Promise<void> => invoke("procmon_stop"),
  procmonSetPaused: (paused: boolean): Promise<void> =>
    invoke("procmon_set_paused", { paused }),
  procmonStats: (): Promise<ProcmonStats> => invoke("procmon_stats"),
  procmonOpenFolder: (exePath: string): Promise<void> =>
    invoke("procmon_open_folder", { exePath }),
  killProcess: (pid: number, startTime: number): Promise<void> =>
    invoke("kill_process", { pid, startTime }),
  killProcessTree: (pid: number, startTime: number): Promise<void> =>
    invoke("kill_process_tree", { pid, startTime }),

  // Phase 3 视频裁剪
  mediaSidecars: (): Promise<Sidecars> => invoke("media_sidecars"),
  mediaProbe: (path: string): Promise<ProbedMediaInfo> => invoke("media_probe", { path }),
  mediaDetectEncoders: (): Promise<EncoderSupport> => invoke("media_detect_encoders"),
  mediaThumbnail: (path: string, timeSec: number, width: number): Promise<string> =>
    invoke("media_thumbnail", { path, timeSec, width }),
  mediaExport: (req: ExportRequest): Promise<ExportStarted> =>
    invoke("media_export", { req }),
  mediaCancelExport: (taskId: string): Promise<void> =>
    invoke("media_cancel_export", { taskId }),

  // 按需 MediaPack：renderer 只能选择 pack id，不能提供 URL 或公钥。
  mediaPackCatalog: (): Promise<MediaPackCatalogView> => invoke("media_pack_catalog"),
  mediaPackInstall: (packId: "preview" | "transcode"): Promise<string> =>
    invoke("media_pack_install", { packId }),
  mediaPackCancel: (taskId: string): Promise<void> =>
    invoke("media_pack_cancel", { taskId }),
  mediaPackRollback: (packId: "preview" | "transcode"): Promise<void> =>
    invoke("media_pack_rollback", { packId }),

  // mpv 预览（--wid HWND 嵌入）
  mpvStart: (x: number, y: number, width: number, height: number, software: boolean): Promise<void> =>
    invoke("mpv_start", { x, y, width, height, software }),
  mpvSetRect: (x: number, y: number, width: number, height: number): Promise<void> =>
    invoke("mpv_set_rect", { x, y, width, height }),
  mpvLoad: (path: string): Promise<MpvLoadResult> => invoke("mpv_load", { path }),
  mpvSetPaused: (paused: boolean): Promise<void> => invoke("mpv_set_paused", { paused }),
  mpvSeek: (sec: number): Promise<void> => invoke("mpv_seek", { sec }),
  mpvStop: (): Promise<void> => invoke("mpv_stop"),
} as const;

export default ipc;
