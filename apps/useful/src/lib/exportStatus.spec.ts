// 导出任务状态测试（需求十八：导出任务状态）。
import { describe, it, expect } from "vitest";
import { exportDoneMessage, isCurrentExportTask } from "@/lib/exportStatus";

describe("导出任务状态", () => {
  it("只接收当前任务的事件", () => {
    expect(isCurrentExportTask("t1", "t1")).toBe(true);
    expect(isCurrentExportTask("t1", "t2")).toBe(false);
    expect(isCurrentExportTask(null, "t1")).toBe(false);
  });

  it("完成/取消/失败映射到对应文案", () => {
    expect(exportDoneMessage({ taskId: "t", status: "completed" })).toBe("导出完成");
    expect(exportDoneMessage({ taskId: "t", status: "cancelled" })).toBe("导出已取消");
    expect(
      exportDoneMessage({ taskId: "t", status: "failed", error: "磁盘已满" }),
    ).toBe("导出失败: 磁盘已满");
    // 无错误信息时不显示 undefined
    expect(exportDoneMessage({ taskId: "t", status: "failed" })).toBe("导出失败: ");
  });
});
