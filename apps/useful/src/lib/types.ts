// 与 Rust 后端共享的类型定义（对应 serde camelCase 序列化）。

export type ToolCategory = "builtin" | "installed";
export type ToolKind = "builtin" | "web" | "launcher" | "worker";

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  route: string;
  category: ToolCategory;
  kind: ToolKind;
  order: number;
  supportsShortcut: boolean;
  requiredCapabilities: string[];
  version?: string;
}

export type RunMode = "portable" | "installed";
export type Theme = "system" | "light" | "dark";
export type Locale = "zh-CN" | "en-US";

export const NAVIGATION_ITEM_IDS = ["home", "library", "shop", "downloads", "settings"] as const;
export type NavigationItemId = (typeof NAVIGATION_ITEM_IDS)[number];
export const HOME_SECTION_IDS = ["recent", "favorites", "builtin"] as const;
export type HomeSectionId = (typeof HOME_SECTION_IDS)[number];
export type NavigationDensity = "comfortable" | "compact";

export interface NavigationLayoutItem<T extends string> {
  id: T;
  visible: boolean;
  order: number;
}

/** Strict, data-only layout contract. IDs are closed enums; no routes, CSS or components are persisted. */
export interface NavigationLayoutV1 {
  schemaVersion: "navigation-layout.v1";
  density: NavigationDensity;
  nav: NavigationLayoutItem<NavigationItemId>[];
  home: NavigationLayoutItem<HomeSectionId>[];
}

export type HostEdition = "standard" | "core" | "custom";

export interface HostCapabilities {
  procmon: boolean;
  media: boolean;
  edition: HostEdition | string;
}

export interface AppInfo {
  name: string;
  version: string;
  runMode: RunMode;
  dataDir: string;
  logsDir: string;
  pluginsDir: string;
  /** Compile-time host capabilities; Core omits procmon/media. */
  capabilities: HostCapabilities;
}

export interface Settings {
  theme: Theme;
  language: Locale;
  developerMode: boolean;
  sidebarCollapsed: boolean;
}

export interface AgentProfileView {
  profileId: string;
  name: string;
  schemaVersion: "useful.agent-profile.v1";
  profileJson: string;
  exportPath: string;
}

export interface ShortcutRecord {
  id: number;
  toolId: string;
  lnkPath: string;
  iconPath?: string;
  targetExe: string;
  args: string;
}

export interface PerfSnapshot {
  backendSamplingMs: number;
  processCount: number;
  etwStatus: string;
  mpvStatus: string;
  ffmpegTasks: number;
  pluginMessages: number;
  pluginRejections: number;
}

export interface NetworkCapability {
  available: boolean;
  reasonCode?: string;
  remediation?: string;
}

export interface InterfaceThroughput {
  key: string;
  name: string;
  description: string;
  upBytesPerSec: number;
  downBytesPerSec: number;
  isLoopback: boolean;
  isVirtual: boolean;
}

export interface NetworkSnapshot {
  interfaceCapability: NetworkCapability;
  connectionCapability: NetworkCapability;
  etwCapability: NetworkCapability;
  interfaces: InterfaceThroughput[];
  totalUpBytesPerSec: number;
  totalDownBytesPerSec: number;
  aggregateScope: string;
}

// 进程监视器后台统计（开发者性能面板）
export interface ProcmonStats {
  running: boolean;
  paused: boolean;
  backendSamplingMs: number;
  processCount: number;
  netAvailable: boolean;
  network: NetworkSnapshot;
  gpuAvailable: boolean;
  processControlAvailable: boolean;
  lastDeltaAdded: number;
  lastDeltaUpdated: number;
  lastDeltaRemoved: number;
}

// 进程监视器类型
export type Metric<T> = { state: "available"; value: T } | { state: "unavailable" };

export interface StaticInfo {
  name: string;
  exePath?: string;
  cmdLine?: string;
  publisher?: string;
  iconKey?: string;
  parent?: { pid: number; startTime: number };
}

export interface DynamicMetrics {
  cpu: number;
  workingSet: number;
  privateBytes: number;
  diskRead: number;
  diskWrite: number;
  netUp: Metric<number>;
  netDown: Metric<number>;
  /** 当前 owner-PID TCP 行数；连接数不是字节量。 */
  tcpConnections: Metric<number>;
  /** 当前 owner-PID UDP 本地端点数；端点数不是字节量。 */
  udpEndpoints: Metric<number>;
  gpu: Metric<number>;
  gpuMemory: Metric<number>;
  threads: number;
  handles: Metric<number>;
}

export interface ProcessSnapshot {
  identity: { pid: number; startTime: number };
  static: StaticInfo;
  dynamic: DynamicMetrics;
}

export interface ProcessDelta {
  added: ProcessSnapshot[];
  updated: { key: string; dynamic: DynamicMetrics }[];
  removed: string[];
}

// 视频裁剪类型
export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec?: string;
  audioCodec?: string;
  bitRate?: number;
  audioTracks: number;
}

export interface EncoderSupport {
  nvenc: boolean;
  qsv: boolean;
  amf: boolean;
}

export interface SidecarSet {
  name: string;
  path?: string;
  available: boolean;
  reason?: "not-found" | "media-pack-damaged" | "platform-unsupported";
}
export interface Sidecars {
  ffmpeg: SidecarSet;
  ffprobe: SidecarSet;
  mpv: SidecarSet;
}

export type ExportMode = "lossless" | "precise" | "audio";

export interface ExportRequest {
  input: string;
  output: string;
  mode: ExportMode;
  startSec: number;
  endSec: number;
  codec?: "h264" | "h265" | "av1";
  quality?: number;
  audioFormat?: "copy" | "mp3" | "aac" | "flac" | "wav";
}

export interface ExportStarted {
  taskId: string;
  output: string;
}

export interface ExportProgress {
  taskId: string;
  percent: number;
  etaSec: number | null;
  frame: number;
  speed: number;
  done: boolean;
}

export interface ExportDone {
  taskId: string;
  status: "completed" | "cancelled" | "failed";
  output?: string;
  error?: string;
}

// 工具铺（Phase 4）
export interface SourceInfo {
  id: string;
  name: string;
  url: string;
  publicKey: string;
  fingerprint: string;
  enabled: boolean;
  lastRefreshedAt: number | null;
  packageCount: number;
}

export interface ShopPackage {
  sourceId: string;
  id: string;
  version: string;
  size: number;
  changelog: string;
  category: string;
  permissions: string[];
  minHostVersion: string;
  installedVersion: string | null;
  updateAvailable: boolean;
  downgrade: boolean;
  pinned: boolean;
}

export interface ToolVersionInfo {
  version: string;
  installedAt: number;
  current: boolean;
}

export type DownloadStatus =
  | "pending"
  | "downloading"
  | "verifying"
  | "installing"
  | "done"
  | "failed"
  | "cancelled";

export interface DownloadRecord {
  id: string;
  url: string;
  packageId: string | null;
  version: string | null;
  totalBytes: number | null;
  receivedBytes: number;
  status: DownloadStatus;
  digest: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: number;
}

export interface DownloadProgressEvent {
  id: string;
  packageId: string;
  version: string;
  receivedBytes: number;
  totalBytes: number;
  status: DownloadStatus;
  digest: string;
}

export interface DownloadDoneEvent {
  id: string;
  packageId: string;
  version: string;
  status: "done" | "failed" | "cancelled";
  error: string | null;
  errorCode: string | null;
}

export type MediaPackTrustState = "blocked" | "unavailable" | "ready";

export interface MediaPackCatalogEntry {
  id: "preview" | "transcode";
  downloadBytes: number;
  archiveBytes: number;
  sourceName: string;
  sourcePageUrl: string;
  sourceCodeUrl: string;
  archiveSha256: string;
  installed: boolean;
  previousAvailable: boolean;
  damaged: boolean;
}

export interface MediaPackCatalogView {
  trustState: MediaPackTrustState;
  reason: string | null;
  sourceLockSha256: string | null;
  packs: MediaPackCatalogEntry[];
}

export type MediaPackPhase = "downloading" | "verifying" | "installing" | "redetecting";

export interface MediaPackProgressEvent {
  taskId: string;
  packId: "preview" | "transcode";
  phase: MediaPackPhase;
  receivedBytes: number;
  totalBytes: number;
}

export interface MediaPackDoneEvent {
  taskId: string;
  packId: "preview" | "transcode";
  status: "done" | "failed" | "cancelled";
  errorCode: string | null;
}

// 诊断包（Phase 5）
export interface DiagEntry {
  name: string;
  sizeBytes: number;
  kind: "log" | "summary";
}

// 源中心（Phase 6B：TRP v1 多源）
export interface TrpCapabilities {
  catalog: boolean;
  remoteSearch: boolean;
  authentication: boolean;
  entitlements: boolean;
  paidDownloads: boolean;
  publisherPortal: boolean;
  privateTools: boolean;
  staticMirror: boolean;
  nativeWorkers: boolean;
}

export interface TrpSourcePreview {
  sourceId: string;
  name: string;
  description: string;
  operator: string;
  discoveryUrl: string;
  local: boolean;
  rootKeyFingerprint: string;
  capabilities: Partial<TrpCapabilities>;
  deliveryType: "unknown" | "static-https" | "dynamic";
  requiresAuth: boolean;
  paidDownloads: boolean;
  nativeWorkers: boolean;
  /** 仅由预置根指纹匹配产生；与名称/ID/URL 无关 */
  isOfficial: boolean;
}

export type TrpSyncStatus = "never" | "ok" | "failed";

export interface TrpSourceInfo {
  id: string;
  kind: "tool" | "mirror";
  discoveryUrl: string;
  displayName: string;
  operator: string;
  local: boolean;
  enabled: boolean;
  priority: number;
  rootKeyFingerprint: string;
  trustConfirmedAt: number;
  capabilities: Partial<TrpCapabilities>;
  deliveryType: "unknown" | "static-https" | "dynamic";
  lastSyncAt: number | null;
  lastSyncStatus: TrpSyncStatus;
  lastSyncError: string | null;
  lastSyncDurationMs: number | null;
  entryCount: number;
  /** 仅由预置根指纹匹配产生 */
  isOfficial: boolean;
}

export interface TrpSyncResult {
  sourceId: string;
  ok: boolean;
  message: string | null;
  entryCount: number;
  durationMs: number;
}

export interface TrpCatalogItem {
  sourceId: string;
  sourcePriority: number;
  publisherKeyId: string;
  toolId: string;
  name: string;
  summary: string;
  license: string;
  latestStable: string | null;
  latestStableDigest: string | null;
  accessMode: string;
  isNativeWorker: boolean;
  /** 以下为各独立审核/签名状态（Phase 9）：绝不合并成单一 safe 布尔 */
  repositorySignatureVerified: boolean;
  publisherSignatureVerified: boolean;
  officialReviewPassed: boolean;
  securityScanPassed: boolean;
  /** 发布者签名方式：ed25519 | sigstore（UI 分别展示，不合并） */
  signatureMethod?: string;
  /** Sigstore 身份（issuer + subject），仅 sigstore 签名时存在 */
  signatureIdentity?: string;
  /** 复现构建验证状态（作者声明与官方验证分离，绝不合并） */
  reproducibleBuild?: ReproducibleBuildView;
  /** Catalog 中的来源自报可用性；不是客户端独立探测结果。 */
  availability?: AvailabilityView;
  /** 安全公告数（>0 时展示公告横幅） */
  advisoryCount: number;
  /** 公告最高严重级别（low|medium|high|critical） */
  maxAdvisorySeverity: string | null;
}

/** 来源自报可用性视图（UI 显示状态、检查时间与报告来源）。 */
export interface AvailabilityView {
  status: "unknown" | "healthy" | "degraded" | "unavailable";
  checkedAt?: string;
  source?: string;
}

/** 复现构建视图：作者声明与官方验证严格分离。 */
export interface ReproducibleBuildView {
  /** 状态机：unknown|claimed|verification-pending|verified|failed */
  status: string;
  /** 验证策略：dual-build | provenance（verified 时存在） */
  strategy?: string;
  /** 失败可解释原因 */
  failureReason?: string;
}

export interface TrpMergedItem {
  item: TrpCatalogItem;
  /** 同发布者同摘要的镜像源 */
  mirrorSourceIds: string[];
  /** 同 toolId 存在不同发布者（同名冲突，不合并） */
  nameConflict: boolean;
}

/** Phase 10：客户端更新源（独立信任域，与工具源完全分离） */
export interface AppUpdateSourceInfo {
  updateFeedUrl: string;
  channel: "stable" | "beta" | "nightly";
  /** 仅由预置更新根公钥字节匹配产生 */
  isOfficial: boolean;
  isDefaultOfficial: boolean;
  /** 开发/QA release profile 使用随附的非生产更新信任根。 */
  usingDevelopmentUpdateTrust: boolean;
  rootFingerprint: string;
  warningAcknowledgedAt: string | null;
  currentVersion: string;
  pendingUpdate: boolean;
  bootstrapPresent: boolean;
}

export type TrpRejectReason =
  | "source-mismatch"
  | "publisher-key-mismatch"
  | "tool-id-mismatch"
  | "invalid-version"
  | "not-an-upgrade"
  | "channel-changed"
  | "same-version-different-digest";

export type TrpUpdateDecision =
  | { decision: "allow"; addedPermissions: string[] }
  | { decision: "reject"; reason: TrpRejectReason };

export interface TrpUpdateCheck {
  toolId: string;
  installedVersion: string;
  candidateVersion: string | null;
  decision: TrpUpdateDecision | null;
}

// 源账户（Phase 8：OAuth PKCE）
export interface SourceAccountInfo {
  sourceId: string;
  accountId: string;
  displayName: string;
  scopes: string[];
  expiresAt: number;
  lastAuthenticatedAt: number;
  /** access token 已过期（需重新登录；已装工具运行不受影响） */
  expired: boolean;
}
