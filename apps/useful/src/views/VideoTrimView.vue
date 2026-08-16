<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { confirm as confirmDialog, open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import type { ProbedMediaInfo } from "@/lib/ipc";
import { exportDoneMessage, isCurrentExportTask } from "@/lib/exportStatus";
import { formatBytes } from "@/lib/format";
import { formatTimecode, clampTime, setInPoint, setOutPoint } from "@/lib/videoTimeline";
import type {
  EncoderSupport,
  ExportDone,
  ExportMode,
  ExportProgress,
  Sidecars,
} from "@/lib/types";
import AppIcon from "@/components/AppIcon.vue";
import { subscribeOpenFile } from "@/lib/openFileBus";
import StateBlock from "@/components/StateBlock.vue";
import VideoTimeline from "@/components/VideoTimeline.vue";

const router = useRouter();
const sidecars = ref<Sidecars | null>(null);
const encoders = ref<EncoderSupport | null>(null);
const filePath = ref<string | null>(null);
const info = ref<ProbedMediaInfo | null>(null);
const probing = ref(false);
const error = ref<string | null>(null);

const playhead = ref(0);
const inPoint = ref(0);
const outPoint = ref(0);
const thumbs = reactive<Record<number, string>>({});
const timelineRef = ref<InstanceType<typeof VideoTimeline> | null>(null);
const previewSurface = ref<HTMLElement | null>(null);
const playing = ref(false);
const frameDropWarning = ref(false);
const previewState = ref<"idle" | "loading" | "direct" | "backend-unavailable" | "direct-failed">("idle");
const previewMessage = ref<string | null>(null);
let mpvActive = false;
let previewRo: ResizeObserver | null = null;
let seeking = false;

// 导出状态
const exportMode = ref<ExportMode>("lossless");
const preciseCodec = ref<"h264" | "h265" | "av1">("h264");
const quality = ref(20);
const audioFormat = ref<"copy" | "mp3" | "aac" | "flac" | "wav">("mp3");
const exportTask = ref<string | null>(null);
const exportProgress = ref<ExportProgress | null>(null);
const exportStatus = ref<string | null>(null);

const mediaAvailable = computed(() => sidecars.value?.ffmpeg.available && sidecars.value?.ffprobe.available);
const mpvAvailable = computed(() => sidecars.value?.mpv.available ?? false);
const directPreviewAvailable = computed(() => previewState.value === "direct");
const fileName = computed(() => filePath.value?.replace(/^.*[\\/]/, "") ?? "");

let unlistenProgress: UnlistenFn | null = null;
let unlistenDone: UnlistenFn | null = null;
let unlistenDrop: UnlistenFn | null = null;
let unlistenTimePos: UnlistenFn | null = null;

async function safeListen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn | null> {
  try {
    return await listen<T>(event, handler);
  } catch {
    return null;
  }
}

function onOpenFile(event: Event): void {
  const detail = (event as CustomEvent<{ toolId: string; file: string }>).detail;
  if (detail?.toolId === "builtin.video-trim" && detail.file) {
    void openVideo(detail.file);
  }
}
let unlistenFrameDrops: UnlistenFn | null = null;

async function loadSidecars(): Promise<void> {
  try {
    sidecars.value = await ipc.mediaSidecars();
    encoders.value = sidecars.value.ffmpeg.available
      ? await ipc.mediaDetectEncoders().catch(() => null)
      : null;
    error.value = null;
  } catch {
    sidecars.value = {
      ffmpeg: { name: "ffmpeg", available: false },
      ffprobe: { name: "ffprobe", available: false },
      mpv: { name: "mpv", available: false },
    };
    encoders.value = null;
    error.value = t("vtrim.runtimeDetectionFailed");
  }
}

async function openRuntimeManager(required: "preview" | "transcode"): Promise<void> {
  await router.push({
    name: "media-runtime",
    query: { required, returnTo: "/tools/video-trim" },
  });
}

async function ensureTranscodeRuntime(): Promise<boolean> {
  if (!sidecars.value) {
    await loadSidecars();
  }
  if (mediaAvailable.value) return true;
  if (await confirmDialog(t("vtrim.installRuntimeConfirm"))) {
    await openRuntimeManager("transcode");
  }
  return false;
}

async function pickFile(): Promise<void> {
  if (!(await ensureTranscodeRuntime())) return;
  const sel = await open({
    multiple: false,
    filters: [
      {
        name: t("vtrim.filterCommonMedia"),
        extensions: [
          "mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "mts", "m2ts", "wmv", "asf",
          "flv", "mpg", "mpeg", "vob", "ogv", "3gp", "3g2", "mxf", "rm", "rmvb",
        ],
      },
      {
        name: t("vtrim.filterAllMedia"),
        extensions: [
          "mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "mts", "m2ts", "wmv", "asf",
          "flv", "mpg", "mpeg", "vob", "ogv", "3gp", "3g2", "mxf", "rm", "rmvb", "dv",
        ],
      },
      { name: t("vtrim.filterAllFiles"), extensions: ["*"] },
    ],
  });
  if (typeof sel === "string") await openVideo(sel);
}

async function openVideo(path: string): Promise<void> {
  if (!(await ensureTranscodeRuntime())) return;
  previewRo?.disconnect();
  previewRo = null;
  if (mpvActive) {
    await ipc.mpvStop().catch(() => {});
    mpvActive = false;
  }
  filePath.value = path;
  error.value = null;
  info.value = null;
  probing.value = true;
  previewState.value = "idle";
  previewMessage.value = null;
  frameDropWarning.value = false;
  for (const k of Object.keys(thumbs)) delete thumbs[Number(k)];
  try {
    const meta = await ipc.mediaProbe(path);
    info.value = meta;
    playhead.value = 0;
    inPoint.value = 0;
    outPoint.value = meta.durationSec;
    probing.value = false;
    // 等预览区域渲染后再创建 mpv 子窗口并载入（仅 mpv 可用时）
    await nextTick();
    await startPreview(path);
  } catch (e) {
    error.value = String(e);
    probing.value = false;
  }
}

/** 读取预览区域物理像素矩形（相对窗口客户区）。 */
function previewRect(): { x: number; y: number; w: number; h: number } | null {
  const el = previewSurface.value;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (r.width <= 0 || r.height <= 0) return null;
  return {
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    w: Math.round(r.width * dpr),
    h: Math.round(r.height * dpr),
  };
}

async function startPreview(path: string): Promise<void> {
  if (!mpvAvailable.value) {
    previewState.value = "backend-unavailable";
    previewMessage.value = t("vtrim.previewNoHost");
    return;
  }
  const rect = previewRect();
  if (!rect) {
    previewState.value = "backend-unavailable";
    previewMessage.value = t("vtrim.previewNotReady");
    return;
  }
  previewState.value = "loading";
  previewMessage.value = t("vtrim.previewLoading");
  try {
    await ipc.mpvStart(rect.x, rect.y, rect.w, rect.h, false);
    const loaded = await ipc.mpvLoad(path);
    if (loaded.status !== "loaded") throw new Error(t("vtrim.previewLoadUnconfirmed"));
    mpvActive = true;
    previewState.value = "direct";
    previewMessage.value = t("vtrim.previewDirectReady");
    playing.value = false;
    // 跟随预览区域尺寸变化
    if (previewSurface.value && !previewRo) {
      previewRo = new ResizeObserver(() => {
        const rr = previewRect();
        if (rr && mpvActive) void ipc.mpvSetRect(rr.x, rr.y, rr.w, rr.h).catch(() => {});
      });
      previewRo.observe(previewSurface.value);
    }
  } catch (e) {
    mpvActive = false;
    previewState.value = "direct-failed";
    previewMessage.value = t("vtrim.previewFailed", { err: String(e) });
    await ipc.mpvStop().catch(() => {});
  }
}

async function togglePlay(): Promise<void> {
  if (!directPreviewAvailable.value || !mpvActive) return;
  playing.value = !playing.value;
  await ipc.mpvSetPaused(!playing.value).catch(() => {});
}

function onSeek(sec: number): void {
  playhead.value = clampTime(sec, info.value?.durationSec ?? 0);
  // mpv 可用时通过 IPC seek（HWND 嵌入预览）
  if (mpvActive) {
    seeking = true;
    void ipc
      .mpvSeek(playhead.value)
      .catch(() => {})
      .finally(() => {
        seeking = false;
      });
  }
}
function markIn(): void {
  if (!info.value) return;
  const [i, o] = setInPoint(playhead.value, outPoint.value, info.value.durationSec);
  inPoint.value = i;
  outPoint.value = o;
}
function markOut(): void {
  if (!info.value) return;
  const [i, o] = setOutPoint(inPoint.value, playhead.value, info.value.durationSec);
  inPoint.value = i;
  outPoint.value = o;
}

function thumbLoader(sec: number): string | undefined {
  return thumbs[sec];
}
let thumbInflight = new Set<number>();
async function requestThumb(sec: number): Promise<void> {
  if (!filePath.value || thumbs[sec] || thumbInflight.has(sec) || !mediaAvailable.value) return;
  thumbInflight.add(sec);
  try {
    thumbs[sec] = await ipc.mediaThumbnail(filePath.value, sec, 160);
  } catch {
    /* 忽略单个缩略图失败 */
  } finally {
    thumbInflight.delete(sec);
  }
}

function onKey(e: KeyboardEvent): void {
  if (!info.value) return;
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "SELECT") return;
  if (e.key === "i" || e.key === "I") markIn();
  else if (e.key === "o" || e.key === "O") markOut();
}

async function startExport(): Promise<void> {
  if (!filePath.value || !info.value) return;
  exportStatus.value = null;
  exportProgress.value = null;
  // 输出路径：让用户选择保存位置
  let ext: string;
  try {
    ext = exportMode.value === "audio"
      ? audioExt()
      : exportMode.value === "lossless"
        ? losslessExt()
        : "mp4";
  } catch (e) {
    error.value = String(e);
    return;
  }
  const suggested = filePath.value.replace(/(\.[^.]+)?$/, `_cut.${ext}`);
  const dest = await save({
    defaultPath: suggested,
    filters: [{ name: `.${ext}`, extensions: [ext] }, { name: t("vtrim.filterAllFiles"), extensions: ["*"] }],
  }).catch(() => null);
  if (typeof dest !== "string") return;
  const output = dest;
  try {
    const started = await ipc.mediaExport({
      input: filePath.value,
      output,
      mode: exportMode.value,
      startSec: inPoint.value,
      endSec: outPoint.value,
      codec: exportMode.value === "precise" ? preciseCodec.value : undefined,
      quality: exportMode.value === "precise" ? quality.value : undefined,
      audioFormat: exportMode.value === "audio" ? audioFormat.value : undefined,
    });
    exportTask.value = started.taskId;
    exportStatus.value = t("vtrim.exporting");
  } catch (e) {
    error.value = String(e);
  }
}
function audioExt(): string {
  if (audioFormat.value !== "copy") {
    return { mp3: "mp3", aac: "m4a", flac: "flac", wav: "wav" }[audioFormat.value];
  }
  const codec = info.value?.audioCodec?.toLowerCase();
  const ext = codec && {
    aac: "m4a", alac: "m4a", mp3: "mp3", opus: "ogg", vorbis: "ogg", flac: "flac",
    pcm_s16le: "wav", pcm_s24le: "wav", pcm_s32le: "wav", pcm_f32le: "wav",
    ac3: "ac3", eac3: "eac3", wmav1: "wma", wmav2: "wma", wmapro: "wma",
  }[codec];
  if (!ext) throw new Error(t("vtrim.audioCopyContainerError", { codec: codec ?? t("vtrim.unknownCodec") }));
  return ext;
}

function losslessExt(): string {
  const sourceExt = filePath.value?.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
  const aliases: Record<string, string> = {
    mp4: "mp4", m4v: "mp4", mov: "mov", mkv: "mkv", webm: "webm", avi: "avi",
    ts: "ts", mts: "ts", m2ts: "ts", wmv: "wmv", asf: "wmv", flv: "flv",
    mpg: "mpg", mpeg: "mpg", mpe: "mpg", vob: "vob", ogv: "ogv", "3gp": "3gp", "3g2": "3gp", mxf: "mxf",
  };
  if (sourceExt && aliases[sourceExt]) return aliases[sourceExt];
  const format = info.value?.formatName?.split(",")[0];
  const byProbe: Record<string, string> = {
    mov: "mp4", mp4: "mp4", matroska: "mkv", webm: "webm", avi: "avi", mpegts: "ts", asf: "wmv", flv: "flv",
    mpeg: "mpg", mpegvideo: "mpg", ogg: "ogv", "3gp": "3gp", mxf: "mxf", dvd: "vob",
  };
  if (format && byProbe[format]) return byProbe[format];
  throw new Error(t("vtrim.losslessContainerError"));
}
async function cancelExport(): Promise<void> {
  if (exportTask.value) await ipc.mediaCancelExport(exportTask.value);
}

let unsubscribeOpenFile: (() => void) | null = null;

onMounted(async () => {
  window.addEventListener("useful-open-file", onOpenFile);
  unsubscribeOpenFile = subscribeOpenFile((detail) => {
    if (detail.toolId === "builtin.video-trim" && detail.file) void openVideo(detail.file);
  });
  await loadSidecars();
  window.addEventListener("keydown", onKey);
  unlistenProgress = await safeListen<ExportProgress>("media-progress", (ev) => {
    if (isCurrentExportTask(exportTask.value, ev.payload.taskId))
      exportProgress.value = ev.payload;
  });
  unlistenDone = await safeListen<ExportDone>("media-export-done", (ev) => {
    if (!isCurrentExportTask(exportTask.value, ev.payload.taskId)) return;
    exportTask.value = null;
    exportStatus.value = exportDoneMessage(ev.payload);
  });
  // Tauri 文件拖放
  unlistenDrop = await safeListen<{ paths: string[] }>("tauri://drag-drop", (ev) => {
    const p = ev.payload?.paths?.[0];
    if (p) void openVideo(p);
  });
  // mpv 属性回读：播放头跟随 time-pos 事件流（拖动中不覆盖）
  unlistenTimePos = await safeListen<number | null>("mpv-time-pos", (ev) => {
    if (typeof ev.payload === "number" && playing.value && !seeking) {
      playhead.value = clampTime(ev.payload, info.value?.durationSec ?? 0);
    }
  });
  // 持续丢帧只降级提示，不把仍然活跃的直接预览误报为不可用。
  unlistenFrameDrops = await safeListen("mpv-frame-drops", () => {
    frameDropWarning.value = true;
  });
});

onUnmounted(() => {
  window.removeEventListener("useful-open-file", onOpenFile);
  unsubscribeOpenFile?.();
  unsubscribeOpenFile = null;
  window.removeEventListener("keydown", onKey);
  unlistenProgress?.();
  unlistenDone?.();
  unlistenDrop?.();
  unlistenTimePos?.();
  unlistenFrameDrops?.();
  previewRo?.disconnect();
  if (mpvActive) void ipc.mpvStop().catch(() => {});
});
</script>

<template>
  <div class="vt">
    <h1 class="vt__title">{{ t("tools.videoTrim.name") }}</h1>
    <p class="vt__subtitle">{{ t("tools.videoTrim.description") }}</p>

    <div v-if="sidecars && !mediaAvailable" class="vt__warn" role="alert">
      <span><AppIcon name="alert" :size="14" /> {{ t("vtrim.mediaUnavailable") }}</span>
      <button class="useful-btn" data-testid="manage-media-runtime" @click="openRuntimeManager('transcode')">
        {{ t("vtrim.manageRuntime") }}
      </button>
    </div>
    <p v-if="error" class="vt__error" role="alert">{{ error }}</p>

    <!-- 无文件：拖放区 -->
    <div v-if="!filePath" class="vt__drop" @click="pickFile">
      <StateBlock variant="empty" :title="t('tools.videoTrim.name')" :hint="t('vtrim.dropHint')">
        <button class="useful-btn useful-btn--primary" data-testid="choose-video" @click.stop="pickFile">
          <AppIcon name="video" :size="16" />{{ t("vtrim.chooseFile") }}
        </button>
      </StateBlock>
    </div>

    <template v-else>
      <StateBlock v-if="probing" variant="loading" :title="t('vtrim.probing')" />
      <template v-else-if="info">
        <div class="vt__grid">
          <!-- 预览区（mpv HWND 嵌入区域；不可用时提示） -->
          <div class="vt__preview">
            <div ref="previewSurface" class="vt__preview-surface" data-mpv-surface>
              <div v-if="previewState !== 'direct' && previewState !== 'loading'" class="vt__preview-note">
                <AppIcon name="video" :size="32" />
                <span>{{ previewMessage ?? t("vtrim.mpvUnavailable") }}</span>
                <button
                  v-if="!mpvAvailable"
                  class="useful-btn"
                  data-testid="manage-preview-runtime"
                  @click="openRuntimeManager('preview')"
                >
                  {{ t("vtrim.managePreviewRuntime") }}
                </button>
              </div>
              <div v-else-if="previewState === 'loading'" class="vt__preview-note">
                <span>{{ previewMessage }}</span>
              </div>
            </div>
            <p v-if="frameDropWarning" class="vt__dropwarn" role="alert">
              <AppIcon name="alert" :size="14" />
              {{ t("vtrim.droppedFramesNoProxy") }}
              <button class="useful-btn useful-btn--ghost" @click="frameDropWarning = false">
                {{ t("common.close") }}
              </button>
            </p>
            <div class="vt__transport">
              <button
                class="useful-icon-btn"
                :disabled="!directPreviewAvailable"
                :title="playing ? t('vtrim.pause') : t('vtrim.play')"
                @click="togglePlay"
              >
                <AppIcon :name="playing ? 'pause' : 'play'" :size="18" />
              </button>
              <span class="vt__time useful-mono">
                {{ formatTimecode(playhead) }} / {{ formatTimecode(info.durationSec) }}
              </span>
              <div class="vt__spacer" />
              <button class="useful-btn" @click="markIn">{{ t("vtrim.setIn") }}</button>
              <button class="useful-btn" @click="markOut">{{ t("vtrim.setOut") }}</button>
              <button class="useful-icon-btn" :title="t('vtrim.zoomOut')" @click="timelineRef?.zoomBy(1 / 1.5)">
                <AppIcon name="chevronLeft" :size="16" />
              </button>
              <button class="useful-icon-btn" :title="t('vtrim.zoomIn')" @click="timelineRef?.zoomBy(1.5)">
                <AppIcon name="chevronRight" :size="16" />
              </button>
            </div>
            <VideoTimeline
              ref="timelineRef"
              :duration="info.durationSec"
              :playhead="playhead"
              :in-point="inPoint"
              :out-point="outPoint"
              :thumb-loader="thumbLoader"
              :request-thumb="requestThumb"
              @seek="onSeek"
            />
            <div class="vt__selinfo useful-mono">
              {{ t("vtrim.selection") }}: {{ formatTimecode(inPoint) }} → {{ formatTimecode(outPoint) }}
              ({{ formatTimecode(Math.max(0, outPoint - inPoint)) }})
            </div>
          </div>

          <!-- 侧栏：元数据 + 导出 -->
          <aside class="vt__side">
            <section class="useful-card">
              <h2 class="vt__h2">{{ t("vtrim.metadata") }}</h2>
              <dl class="vt__meta">
                <dt>{{ t("vtrim.fileName") }}</dt><dd :title="fileName">{{ fileName }}</dd>
                <dt>{{ t("vtrim.duration") }}</dt><dd>{{ formatTimecode(info.durationSec) }}</dd>
                <dt>{{ t("vtrim.resolution") }}</dt><dd>{{ info.width }}×{{ info.height }}</dd>
                <dt>{{ t("vtrim.fps") }}</dt><dd>{{ info.fps.toFixed(2) }}</dd>
                <dt>{{ t("vtrim.videoCodec") }}</dt><dd>{{ info.videoCodec ?? "—" }}</dd>
                <dt>{{ t("vtrim.audioCodec") }}</dt><dd>{{ info.audioCodec ?? "—" }}</dd>
                <dt>{{ t("vtrim.bitrate") }}</dt>
                <dd>{{ info.bitRate ? formatBytes(info.bitRate / 8) + "/s" : "—" }}</dd>
                <dt>{{ t("vtrim.audioTracks") }}</dt><dd>{{ info.audioTracks }}</dd>
              </dl>
            </section>

            <section class="useful-card">
              <h2 class="vt__h2">{{ t("vtrim.exportTitle") }}</h2>
              <div class="seg vt__modes">
                <button class="seg__btn" :class="{ 'seg__btn--active': exportMode === 'lossless' }" @click="exportMode = 'lossless'">
                  {{ t("vtrim.modeLossless") }}
                </button>
                <button class="seg__btn" :class="{ 'seg__btn--active': exportMode === 'precise' }" @click="exportMode = 'precise'">
                  {{ t("vtrim.modePrecise") }}
                </button>
                <button class="seg__btn" :class="{ 'seg__btn--active': exportMode === 'audio' }" @click="exportMode = 'audio'">
                  {{ t("vtrim.modeAudio") }}
                </button>
              </div>

              <p v-if="exportMode === 'lossless'" class="vt__note">{{ t("vtrim.losslessNote") }}</p>
              <template v-else-if="exportMode === 'precise'">
                <p class="vt__note">{{ t("vtrim.preciseNote") }}</p>
                <label class="vt__field">
                  <span>{{ t("vtrim.codec") }}</span>
                  <select v-model="preciseCodec" class="useful-select">
                    <option value="h264">H.264</option>
                    <option value="h265">H.265</option>
                    <option value="av1">AV1</option>
                  </select>
                </label>
                <label class="vt__field">
                  <span>{{ t("vtrim.quality") }}: {{ quality }}</span>
                  <input v-model.number="quality" type="range" min="0" max="51" />
                </label>
                <p class="vt__hw">
                  {{ t("vtrim.hwEncoders") }}:
                  <span v-if="encoders && (encoders.nvenc || encoders.qsv || encoders.amf)">
                    <span v-if="encoders.nvenc" class="useful-badge useful-badge--accent">NVENC</span>
                    <span v-if="encoders.qsv" class="useful-badge useful-badge--accent">QSV</span>
                    <span v-if="encoders.amf" class="useful-badge useful-badge--accent">AMF</span>
                  </span>
                  <span v-else class="vt__hw-none">{{ t("vtrim.noHwEncoder") }}</span>
                </p>
              </template>
              <label v-else class="vt__field">
                <span>{{ t("vtrim.audioFormat") }}</span>
                <select v-model="audioFormat" class="useful-select">
                  <option value="copy">{{ t("vtrim.audioCopy") }}</option>
                  <option value="mp3">MP3</option>
                  <option value="aac">AAC/M4A</option>
                  <option value="flac">FLAC</option>
                  <option value="wav">WAV</option>
                </select>
              </label>

              <p class="vt__hint">{{ t("vtrim.rename") }}</p>

              <div class="vt__actions">
                <button
                  v-if="!exportTask"
                  class="useful-btn useful-btn--primary"
                  :disabled="!mediaAvailable"
                  @click="startExport"
                >
                  {{ t("vtrim.startExport") }}
                </button>
                <button v-else class="useful-btn useful-btn--danger" @click="cancelExport">
                  {{ t("vtrim.cancelExport") }}
                </button>
              </div>

              <div v-if="exportProgress" class="vt__progress">
                <div class="vt__bar">
                  <div class="vt__bar-fill" :style="{ width: exportProgress.percent + '%' }" />
                </div>
                <div class="vt__prog-meta useful-mono">
                  {{ exportProgress.percent.toFixed(1) }}% ·
                  {{ t("vtrim.speed") }} {{ exportProgress.speed.toFixed(2) }}x ·
                  {{ t("vtrim.frame") }} {{ exportProgress.frame }}
                  <template v-if="exportProgress.etaSec !== null">
                    · {{ t("vtrim.eta") }} {{ formatTimecode(exportProgress.etaSec) }}
                  </template>
                </div>
              </div>
              <p v-if="exportStatus" class="vt__status">{{ exportStatus }}</p>
            </section>
          </aside>
        </div>
      </template>
      <StateBlock v-else variant="error" :hint="error ?? ''" retryable @retry="openVideo(filePath!)" />
    </template>
  </div>
</template>

<style scoped>
.vt {
  padding: var(--useful-space-4) var(--useful-space-5);
  height: 100%;
  overflow: auto;
}
.vt__title {
  font-size: var(--useful-text-xl);
  font-weight: 700;
  margin: 0;
}
.vt__subtitle {
  color: var(--useful-text-secondary);
  margin: 4px 0 var(--useful-space-3);
}
.vt__warn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  background: rgba(157, 93, 0, 0.12);
  color: var(--useful-warning);
  padding: var(--useful-space-2) var(--useful-space-3);
  border-radius: var(--useful-radius-md);
  font-size: var(--useful-text-sm);
}
.vt__warn > span { display: flex; align-items: center; gap: 6px; }
.vt__error {
  color: var(--useful-danger);
  font-size: var(--useful-text-sm);
}
.vt__drop {
  cursor: pointer;
  border: 2px dashed var(--useful-border-strong);
  border-radius: var(--useful-radius-lg);
}
.vt__grid {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: var(--useful-space-4);
}
.vt__preview {
  min-width: 0;
}
.vt__preview-surface {
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: var(--useful-radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--useful-space-3);
}
.vt__preview-note {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #aaa;
  font-size: var(--useful-text-sm);
  text-align: center;
  padding: var(--useful-space-4);
}
.vt__dropwarn {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  margin: var(--useful-space-2) 0 0;
  padding: var(--useful-space-2) var(--useful-space-3);
  border-radius: var(--useful-radius-md);
  background: rgba(157, 93, 0, 0.12);
  color: var(--useful-warning);
  font-size: var(--useful-text-sm);
}
.vt__transport {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  margin-bottom: var(--useful-space-2);
}
.vt__spacer {
  flex: 1;
}
.vt__time {
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
}
.vt__selinfo {
  margin-top: var(--useful-space-2);
  color: var(--useful-text-secondary);
  font-size: var(--useful-text-sm);
}
.vt__side {
  display: flex;
  flex-direction: column;
  gap: var(--useful-space-3);
}
.vt__h2 {
  font-size: var(--useful-text-md);
  font-weight: 600;
  margin: 0 0 var(--useful-space-2);
}
.vt__meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: var(--useful-text-sm);
}
.vt__meta dt {
  color: var(--useful-text-tertiary);
}
.vt__meta dd {
  margin: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vt__modes {
  display: flex;
  width: 100%;
  margin-bottom: var(--useful-space-2);
}
.vt__modes .seg__btn {
  flex: 1;
}
.vt__note {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  margin: 0 0 var(--useful-space-2);
}
.vt__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--useful-space-2);
  font-size: var(--useful-text-sm);
}
.vt__hw {
  font-size: var(--useful-text-sm);
  display: flex;
  gap: 4px;
  align-items: center;
  flex-wrap: wrap;
}
.vt__hw-none {
  color: var(--useful-text-tertiary);
}
.vt__actions {
  margin: var(--useful-space-2) 0;
}
.vt__bar {
  height: 8px;
  background: var(--useful-bg-active);
  border-radius: 999px;
  overflow: hidden;
}
.vt__bar-fill {
  height: 100%;
  background: var(--useful-accent);
  transition: width 0.2s;
}
.vt__prog-meta {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-secondary);
  margin-top: 4px;
}
.vt__status {
  font-size: var(--useful-text-sm);
  color: var(--useful-success);
  margin: var(--useful-space-2) 0 0;
}
.seg {
  background: var(--useful-bg-active);
  border-radius: var(--useful-radius-md);
  padding: 2px;
}
.seg__btn {
  border: none;
  background: transparent;
  color: var(--useful-text-secondary);
  padding: 6px 10px;
  border-radius: var(--useful-radius-sm);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--useful-text-sm);
}
.seg__btn--active {
  background: var(--useful-bg-elevated);
  color: var(--useful-text);
  box-shadow: var(--useful-shadow-sm);
}
</style>
