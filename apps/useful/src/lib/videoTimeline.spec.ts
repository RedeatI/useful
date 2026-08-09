import { describe, it, expect, vi } from "vitest";
import {
  pxPerSec,
  timeToX,
  xToTime,
  visibleTicks,
  visibleThumbnailSlots,
  setInPoint,
  setOutPoint,
  clampTime,
  zoomAt,
  createSeekThrottle,
  formatTimecode,
  type TimelineView,
} from "@/lib/videoTimeline";

const base: TimelineView = { durationSec: 120, widthPx: 1200, zoom: 1, panSec: 0 };

describe("时间轴 时间/像素映射", () => {
  it("pxPerSec 与缩放成正比", () => {
    expect(pxPerSec(base)).toBe(10); // 1200px / 120s
    expect(pxPerSec({ ...base, zoom: 2 })).toBe(20);
  });

  it("timeToX / xToTime 互逆", () => {
    expect(timeToX(base, 60)).toBe(600);
    expect(xToTime(base, 600)).toBe(60);
  });

  it("duration=0 不崩溃", () => {
    expect(pxPerSec({ ...base, durationSec: 0 })).toBe(0);
    expect(xToTime({ ...base, durationSec: 0 }, 100)).toBe(0);
  });
});

describe("虚拟化刻度", () => {
  it("只生成可见范围内的刻度", () => {
    const ticks = visibleTicks(base);
    expect(ticks.length).toBeGreaterThan(0);
    // 所有刻度都在 [0, duration]
    for (const t of ticks) {
      expect(t.sec).toBeGreaterThanOrEqual(0);
      expect(t.sec).toBeLessThanOrEqual(base.durationSec + 1e-6);
    }
  });

  it("平移后刻度随之变化（虚拟化）", () => {
    const zoomed: TimelineView = { ...base, zoom: 10, panSec: 60 };
    const ticks = visibleTicks(zoomed);
    // 可见区起点应 >= panSec
    expect(ticks[0].sec).toBeGreaterThanOrEqual(60);
  });

  it("缩略图槽仅覆盖可见范围", () => {
    const slots = visibleThumbnailSlots(base, 10);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].sec).toBe(0);
  });
});

describe("入点/出点钳制", () => {
  it("入点不超过出点", () => {
    const [i, o] = setInPoint(80, 50, 120);
    expect(i).toBeLessThanOrEqual(o);
    expect(i).toBe(50);
  });
  it("出点不小于入点", () => {
    const [i, o] = setOutPoint(50, 30, 120);
    expect(o).toBeGreaterThanOrEqual(i);
    expect(o).toBe(50);
  });
  it("钳制到 [0, duration]", () => {
    expect(clampTime(-5, 120)).toBe(0);
    expect(clampTime(999, 120)).toBe(120);
  });
});

describe("缩放锚点", () => {
  it("放大后 zoom 增大且 pan 有界", () => {
    const r = zoomAt(base, 2, 600);
    expect(r.zoom).toBe(2);
    expect(r.panSec).toBeGreaterThanOrEqual(0);
  });
  it("受 min/max 限制", () => {
    expect(zoomAt(base, 0.1, 0, 1, 200).zoom).toBe(1); // 不低于 minZoom
    expect(zoomAt({ ...base, zoom: 200 }, 2, 0, 1, 200).zoom).toBe(200);
  });
});

describe("seek 节流", () => {
  it("首次立即触发，随后节流", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = createSeekThrottle(fn, 100);
    throttled(1); // 立即
    throttled(2); // 节流
    throttled(3); // 覆盖 pending
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(1);
    vi.advanceTimersByTime(100);
    // trailing 触发最后一个值
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
    vi.useRealTimers();
  });
});

describe("时间码格式", () => {
  it("格式化", () => {
    expect(formatTimecode(65.5)).toBe("01:05.500");
    expect(formatTimecode(3661.25)).toBe("1:01:01.250");
    expect(formatTimecode(-1)).toBe("00:00.000");
  });
});
