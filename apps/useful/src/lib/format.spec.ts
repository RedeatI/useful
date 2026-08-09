import { describe, it, expect } from "vitest";
import { formatBytes, formatRate, formatPercent, metricValue } from "@/lib/format";
import type { Metric } from "@/lib/types";

describe("format", () => {
  it("formatBytes 人类可读", () => {
    expect(formatBytes(0)).toBe("0");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("formatRate 带 /s", () => {
    expect(formatRate(1024)).toBe("1.0 KB/s");
  });

  it("formatPercent 一位小数", () => {
    expect(formatPercent(12.34)).toBe("12.3%");
  });

  it("metricValue 区分可用与不可用", () => {
    const avail: Metric<number> = { state: "available", value: 42 };
    const unavail: Metric<number> = { state: "unavailable" };
    expect(metricValue(avail)).toBe(42);
    expect(metricValue(unavail)).toBeUndefined();
  });
});
