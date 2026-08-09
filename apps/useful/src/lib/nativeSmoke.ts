import { requestOpenFile } from "@/lib/openFileBus";
import { nextTick } from "vue";
import type { Router } from "vue-router";
import { emit, listen } from "@tauri-apps/api/event";
import type { ExportDone } from "@/lib/types";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import { OFFICE_ACTIONS } from "@/lib/officeRegistry";
import { UTIL_ACTIONS } from "@/lib/tools/registry";

export const REQUIRED_OFFICE_SMOKE_ROUTES = Object.freeze([
  { id: "builtin.office.docx", route: "/tools/office/docx" },
  { id: "builtin.office.pptx", route: "/tools/office/pptx" },
  { id: "builtin.office.spreadsheet", route: "/tools/office/spreadsheet" },
  { id: "builtin.office.pdf", route: "/tools/office/pdf" },
  { id: "builtin.office.markdown", route: "/tools/office/markdown" },
] as const);

export const NATIVE_SMOKE_ROUTE_ACTIONS = Object.freeze([
  ...UTIL_ACTIONS,
  ...OFFICE_ACTIONS,
]);

export const NATIVE_SMOKE_STANDALONE_TOOL_COUNT = 2;
export const NATIVE_SMOKE_TOTAL =
  NATIVE_SMOKE_ROUTE_ACTIONS.length + NATIVE_SMOKE_STANDALONE_TOOL_COUNT;

export const REQUIRED_NATIVE_TOOL_IDS = Object.freeze([
  "builtin.utilities",
  "builtin.office",
  "builtin.video-trim",
  "builtin.process-monitor",
] as const);

export interface NativeSmokeStart {
  commit: string;
  version: string;
  clipboardPassed: boolean;
  clipboardError?: string;
  mediaInput?: string;
}

interface NativeSmokeCheck {
  id: string;
  route: string;
  title: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

interface NativeSmokeFailure {
  id: string;
  message: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function settle(ms = 80): Promise<void> {
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await delay(ms);
}

function assertRendered(route: string, title: string): void {
  const main = document.querySelector("main");
  const text = main?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  if (text.length < 4) throw new Error("主内容为空，疑似白屏");
  if (!text.includes(title)) throw new Error(`页面未呈现注册表标题: ${title}`);
  if (document.querySelector(".util__notfound")) throw new Error("有效 action 进入了未知页面");
  if (location.pathname !== route) {
    throw new Error(`路由不一致: expected=${route}, actual=${location.pathname}`);
  }
}

export async function runNativeSmoke(router: Router, start: NativeSmokeStart): Promise<void> {
  const started = performance.now();
  const checks: NativeSmokeCheck[] = [];
  const failures: NativeSmokeFailure[] = [];
  let activeId = "startup";
  const runtimeErrors: string[] = [];
  const onError = (event: ErrorEvent) => {
    runtimeErrors.push(`${activeId}: ${event.message || "window.error"}`);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    runtimeErrors.push(`${activeId}: ${String(event.reason)}`);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  let registryIpcPassed = false;
  let sqlitePersistedFromPreviousRun = false;
  let sqliteFavoritesPassed = false;
  let sqliteRecentPassed = false;
  let clipboardPassed = false;
  let mediaFileOpened = false;
  let mediaExportPassed = false;
  let startupDeepLinkPassed = false;
  let ffmpegAvailable = false;
  let ffprobeAvailable = false;
  let mpvAvailable = false;
  let betaFeedbackExportPassed = false;
  const checkpoint = async (name: string): Promise<void> => {
    await emit("native-smoke-checkpoint", {
      name,
      activeId,
      elapsedMs: performance.now() - started,
    });
  };

  const runCheck = async (id: string, route: string, title: string, waitMs = 80) => {
    activeId = id;
    const checkStarted = performance.now();
    try {
      await router.push(route);
      await settle(waitMs);
      assertRendered(route, title);
      checks.push({ id, route, title, passed: true, durationMs: performance.now() - checkStarted });
    } catch (error) {
      const message = String(error);
      checks.push({ id, route, title, passed: false, durationMs: performance.now() - checkStarted, error: message });
      failures.push({ id, message });
    }
  };

  try {
    await checkpoint("started");
    if (start.mediaInput) {
      activeId = "startup-media-deep-link";
      const fileName = start.mediaInput.replace(/^.*[\\/]/, "");
      const openedAt = performance.now();
      while (!(document.querySelector("main")?.textContent ?? "").includes(fileName)) {
        if (performance.now() - openedAt > 10_000) {
          throw new Error("首启 --open-tool/--file 未在 10 秒内呈现真实文件名");
        }
        await delay(100);
      }
      startupDeepLinkPassed = true;
      await checkpoint("startup-media-deep-link-opened");
    }
    const smokeRoutes = new Map(
      NATIVE_SMOKE_ROUTE_ACTIONS.map((action) => [action.id, action.route]),
    );
    for (const required of REQUIRED_OFFICE_SMOKE_ROUTES) {
      if (smokeRoutes.get(required.id) !== required.route) {
        failures.push({
          id: `registry-baseline.${required.id}`,
          message: `Office native smoke 缺少必需 action/route: ${required.id} -> ${required.route}`,
        });
      }
    }

    try {
      const nativeTools = await ipc.listTools();
      const ids = new Set(nativeTools.map((tool) => tool.id));
      registryIpcPassed = REQUIRED_NATIVE_TOOL_IDS.every((id) => ids.has(id));
      if (!registryIpcPassed) throw new Error("Rust 注册表 IPC 缺少内置工具");
    } catch (error) {
      failures.push({ id: "native-registry-ipc", message: String(error) });
    }
    await checkpoint("registry-checked");

    for (const action of NATIVE_SMOKE_ROUTE_ACTIONS) {
      await runCheck(action.id, action.route, t(action.nameKey));
    }
    await checkpoint("action-routes-checked");

    await runCheck("builtin.video-trim", "/tools/video-trim", t("tools.videoTrim.name"), 250);
    await runCheck(
      "builtin.process-monitor",
      "/tools/process-monitor",
      t("tools.processMonitor.name"),
      1400,
    );
    try {
      const stats = await ipc.procmonStats();
      if (!stats.running) throw new Error("进程采样器未运行");
    } catch (error) {
      failures.push({ id: "builtin.process-monitor.ipc", message: String(error) });
    }

    activeId = "unknown-action";
    await router.push("/tools/utilities/__native-smoke-unknown__");
    await settle(250);
    const notFound = document.querySelector(".util__notfound")?.textContent ?? "";
    if (!notFound.includes("__native-smoke-unknown__")) {
      failures.push({ id: "unknown-action", message: "未知 action 未显示可识别错误页" });
    }
    await settle(250);
    const stopped = await ipc.procmonStats();
    if (stopped.running) {
      failures.push({ id: "builtin.process-monitor.cleanup", message: "离开页面后采样器仍在运行" });
    }
    await checkpoint("process-monitor-checked");

    try {
      const marker = "builtin.utilities.base64";
      const favoritesBefore = await ipc.getActionFavorites();
      sqlitePersistedFromPreviousRun = favoritesBefore.includes(marker);
      if (!sqlitePersistedFromPreviousRun) await ipc.toggleActionFavorite(marker);
      await ipc.recordActionUse("builtin.utilities.hash");
      const favoritesAfter = await ipc.getActionFavorites();
      const recentAfter = await ipc.getActionRecent();
      sqliteFavoritesPassed = favoritesAfter.includes(marker);
      sqliteRecentPassed = recentAfter[0] === "builtin.utilities.hash";
      if (!sqliteFavoritesPassed || !sqliteRecentPassed) {
        throw new Error("SQLite action 收藏或最近使用未按预期写入");
      }
    } catch (error) {
      failures.push({ id: "native-sqlite", message: String(error) });
    }
    await checkpoint("sqlite-checked");

    clipboardPassed = start.clipboardPassed;
    if (!clipboardPassed) {
      failures.push({
        id: "native-clipboard",
        message: start.clipboardError ?? "系统剪贴板原生读写失败",
      });
    }

    if (start.mediaInput) {
      activeId = "builtin.video-trim.media";
      try {
        await checkpoint("media-started");
        await router.push("/tools/video-trim");
        await settle(200);
        requestOpenFile({ toolId: "builtin.video-trim", file: start.mediaInput });
        window.dispatchEvent(new CustomEvent("useful-open-file", {
          detail: { toolId: "builtin.video-trim", file: start.mediaInput },
        }));
        const fileName = start.mediaInput.replace(/^.*[\\/]/, "");
        const openedAt = performance.now();
        while (!(document.querySelector("main")?.textContent ?? "").includes(fileName)) {
          if (performance.now() - openedAt > 10_000) {
            throw new Error("视频页面未在 10 秒内显示真实文件名");
          }
          await delay(100);
        }
        const sidecars = await ipc.mediaSidecars();
        ffmpegAvailable = sidecars.ffmpeg.available;
        ffprobeAvailable = sidecars.ffprobe.available;
        mpvAvailable = sidecars.mpv.available;
        if (!ffmpegAvailable || !ffprobeAvailable) {
          throw new Error("ffmpeg 或 ffprobe 不可用");
        }
        const media = await ipc.mediaProbe(start.mediaInput);
        if (!(media.durationSec > 0)) throw new Error("ffprobe 未返回有效视频时长");
        mediaFileOpened = true;
        await checkpoint("media-opened");

        let exportTaskId = "";
        const earlyExportDone: ExportDone[] = [];
        let resolveExportDone: (value: ExportDone) => void = () => {};
        const exportDone = new Promise<ExportDone>((resolve) => { resolveExportDone = resolve; });
        const unlistenExportDone = await listen<ExportDone>("media-export-done", (event) => {
          if (!exportTaskId) {
            earlyExportDone.push(event.payload);
          } else if (event.payload.taskId === exportTaskId) {
            resolveExportDone(event.payload);
          }
        });
        const output = `${start.mediaInput}.native-smoke-output.mp4`;
        try {
          const startedExport = await ipc.mediaExport({
            input: start.mediaInput,
            output,
            mode: "lossless",
            startSec: 0,
            endSec: Math.min(1.5, media.durationSec),
          });
          exportTaskId = startedExport.taskId;
          const completedEarly = earlyExportDone.find((done) => done.taskId === exportTaskId);
          if (completedEarly) resolveExportDone(completedEarly);
          await checkpoint("media-export-started");
          const done = await Promise.race([
            exportDone,
            delay(30_000).then(() => {
              throw new Error("视频导出在 30 秒内未完成");
            }),
          ]);
          if (done.status !== "completed") {
            throw new Error(`视频导出失败: ${done.status} ${done.error ?? ""}`);
          }
          await checkpoint("media-export-completed");
        } finally {
          unlistenExportDone();
        }
        mediaExportPassed = true;
      } catch (error) {
        failures.push({ id: activeId, message: String(error) });
      }
    } else {
      failures.push({ id: "builtin.video-trim.media", message: "native smoke 未提供真实媒体输入" });
    }

    activeId = "beta-feedback-export";
    try {
      if (!start.mediaInput) throw new Error("缺少可定位反馈包的测试目录");
      const preview = await ipc.diagnosticsPreview();
      const names = new Set(preview.map((entry) => entry.name));
      if (!names.has("diagnostics.txt") || !names.has("beta-feedback-template.md")) {
        throw new Error("Beta 反馈包预览缺少摘要或反馈模板");
      }
      await ipc.diagnosticsExport(`${start.mediaInput}.beta-feedback.zip`);
      betaFeedbackExportPassed = true;
    } catch (error) {
      failures.push({ id: activeId, message: String(error) });
    }

    await router.push("/tools/utilities/base64");
    await settle(200);
    await checkpoint("final-route-restored");
  } catch (error) {
    failures.push({ id: activeId, message: String(error) });
  } finally {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  }

  for (const message of runtimeErrors) {
    failures.push({ id: "runtime-error", message });
  }

  const total = NATIVE_SMOKE_TOTAL;
  const failedIds = new Set(failures.map((failure) => failure.id));
  const failedChecks = checks.filter((check) => !check.passed).length;
  const result = {
    scenario: "native-tauri-all-tools",
    commit: start.commit,
    version: start.version,
    total,
    passed: Math.max(0, total - failedChecks),
    failed: failures.length,
    durationMs: performance.now() - started,
    failures,
    artifacts: [],
    checks,
    registryActionCount: NATIVE_SMOKE_ROUTE_ACTIONS.length,
    expectedMinimum: NATIVE_SMOKE_TOTAL,
    uniqueFailureIds: [...failedIds],
    nativeCapabilities: {
      registryIpcPassed,
      sqlitePersistedFromPreviousRun,
      sqliteFavoritesPassed,
      sqliteRecentPassed,
      clipboardPassed,
      mediaFileOpened,
      mediaExportPassed,
      startupDeepLinkPassed,
      ffmpegAvailable,
      ffprobeAvailable,
      mpvAvailable,
      betaFeedbackExportPassed,
      isolatedPortableData: true,
    },
  };
  await checkpoint("result-emitting");
  await emit("native-smoke-result", result);
}
