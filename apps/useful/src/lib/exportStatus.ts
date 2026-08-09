// 导出任务状态的纯逻辑：事件归属判断与完成态文案。便于单元测试。
import { t } from "@/i18n";
import type { ExportDone } from "./types";

/** 事件是否属于当前导出任务（null 任务不接收任何事件）。 */
export function isCurrentExportTask(
  currentTaskId: string | null,
  eventTaskId: string,
): boolean {
  return currentTaskId !== null && currentTaskId === eventTaskId;
}

/** 导出完成事件对应的用户可读文案（completed/cancelled/failed）。 */
export function exportDoneMessage(done: ExportDone): string {
  switch (done.status) {
    case "completed":
      return t("vtrim.exportDone");
    case "cancelled":
      return t("vtrim.exportCancelled");
    case "failed":
      return `${t("vtrim.exportFailed")}: ${done.error ?? ""}`;
  }
}
