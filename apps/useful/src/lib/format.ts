// 数值格式化工具：字节、速率、百分比。
import type { Metric } from "./types";

export function formatBytes(n: number): string {
  if (n <= 0) return "0";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatRate(n: number): string {
  return `${formatBytes(n)}/s`;
}

export function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** 渲染可选指标：不可用返回 undefined（由调用方显示「不可用」）。 */
export function metricValue<T>(m: Metric<T>): T | undefined {
  return m.state === "available" ? m.value : undefined;
}
