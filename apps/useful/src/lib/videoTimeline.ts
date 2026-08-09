// 视频时间轴逻辑（与视图解耦，便于测试）：缩放/平移、虚拟化刻度、缩略图槽、
// 入出点钳制、seek 节流。

/** 时间轴视图状态：像素宽度、缩放（>=1）、平移（左端起始秒）。 */
export interface TimelineView {
  durationSec: number;
  widthPx: number;
  zoom: number;
  panSec: number; // 视口左边缘对应的时间
}

/** 每秒对应的像素数（考虑缩放）。 */
export function pxPerSec(v: TimelineView): number {
  if (v.durationSec <= 0) return 0;
  return (v.widthPx * v.zoom) / v.durationSec;
}

/** 时间 → 视口内像素 x。 */
export function timeToX(v: TimelineView, sec: number): number {
  return (sec - v.panSec) * pxPerSec(v);
}

/** 视口内像素 x → 时间。 */
export function xToTime(v: TimelineView, x: number): number {
  const pps = pxPerSec(v);
  if (pps <= 0) return 0;
  return v.panSec + x / pps;
}

/** 可见时间区间 [startSec, endSec]（用于只渲染可见内容）。 */
export function visibleRange(v: TimelineView): [number, number] {
  const start = Math.max(0, v.panSec);
  const end = Math.min(v.durationSec, xToTime(v, v.widthPx));
  return [start, Math.max(start, end)];
}

/** 选择“好看”的刻度间隔（秒），使刻度间距约 >= minGapPx。 */
export function tickIntervalSec(v: TimelineView, minGapPx = 80): number {
  const pps = pxPerSec(v);
  if (pps <= 0) return 1;
  const rawSec = minGapPx / pps;
  const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const n of nice) {
    if (n >= rawSec) return n;
  }
  return Math.ceil(rawSec / 3600) * 3600;
}

/** 生成可见刻度（仅可见范围内，虚拟化）。返回每个刻度的 { sec, x }。 */
export function visibleTicks(v: TimelineView, minGapPx = 80): { sec: number; x: number }[] {
  const interval = tickIntervalSec(v, minGapPx);
  const [start, end] = visibleRange(v);
  const first = Math.ceil(start / interval) * interval;
  const ticks: { sec: number; x: number }[] = [];
  for (let s = first; s <= end + 1e-6; s += interval) {
    ticks.push({ sec: s, x: timeToX(v, s) });
  }
  return ticks;
}

/** 生成可见缩略图槽（按给定间隔，仅可见范围）。 */
export function visibleThumbnailSlots(
  v: TimelineView,
  intervalSec: number,
): { sec: number; x: number; width: number }[] {
  if (intervalSec <= 0) return [];
  const [start, end] = visibleRange(v);
  const first = Math.floor(start / intervalSec) * intervalSec;
  const slotW = intervalSec * pxPerSec(v);
  const slots: { sec: number; x: number; width: number }[] = [];
  for (let s = first; s < end; s += intervalSec) {
    slots.push({ sec: s, x: timeToX(v, s), width: slotW });
  }
  return slots;
}

/** 将时间钳制到 [0, duration]。 */
export function clampTime(sec: number, durationSec: number): number {
  return Math.min(Math.max(sec, 0), durationSec);
}

/** 根据时长/宽度/缩放选择缩略图间隔（秒），对齐到“好看”的值，至少 1 秒。 */
export function thumbnailInterval(
  durationSec: number,
  widthPx: number,
  zoom: number,
): number {
  if (durationSec <= 0 || widthPx <= 0) return 1;
  const thumbPx = 120;
  const effectiveWidth = widthPx * Math.max(zoom, 0.01);
  const thumbs = Math.max(effectiveWidth / thumbPx, 1);
  const raw = durationSec / thumbs;
  const nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const n of nice) {
    if (raw <= n) return n;
  }
  return Math.ceil(raw / 60) * 60;
}

/** 设置入点：不能超过出点。返回新的 [in, out]。 */
export function setInPoint(
  inSec: number,
  outSec: number,
  durationSec: number,
): [number, number] {
  const clamped = clampTime(inSec, durationSec);
  return [Math.min(clamped, outSec), outSec];
}

/** 设置出点：不能小于入点。 */
export function setOutPoint(
  inSec: number,
  outSec: number,
  durationSec: number,
): [number, number] {
  const clamped = clampTime(outSec, durationSec);
  return [inSec, Math.max(clamped, inSec)];
}

/** 缩放（以某个锚点时间保持在同一像素位置）。返回新的 { zoom, panSec }。 */
export function zoomAt(
  v: TimelineView,
  factor: number,
  anchorX: number,
  minZoom = 1,
  maxZoom = 200,
): { zoom: number; panSec: number } {
  const anchorTime = xToTime(v, anchorX);
  const newZoom = Math.min(Math.max(v.zoom * factor, minZoom), maxZoom);
  const newView = { ...v, zoom: newZoom };
  // 保持 anchorTime 在 anchorX 处：panSec = anchorTime - anchorX / pps
  const pps = pxPerSec(newView);
  const panSec = pps > 0 ? anchorTime - anchorX / pps : 0;
  const maxPan = Math.max(0, v.durationSec - v.durationSec / newZoom);
  return { zoom: newZoom, panSec: Math.min(Math.max(panSec, 0), maxPan) };
}

/**
 * seek 节流：限制调用频率。返回一个函数，最多每 `intervalMs` 触发一次，
 * 且保证最后一次调用在空闲后被触发（trailing）。用于拖动播放头时限制 mpv seek。
 */
export function createSeekThrottle(
  fn: (sec: number) => void,
  intervalMs: number,
): (sec: number) => void {
  let last = 0;
  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const invoke = (sec: number): void => {
    last = Date.now();
    fn(sec);
  };

  return (sec: number): void => {
    const now = Date.now();
    const elapsed = now - last;
    if (elapsed >= intervalMs) {
      invoke(sec);
    } else {
      pending = sec;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (pending !== null) {
            const p = pending;
            pending = null;
            invoke(p);
          }
        }, intervalMs - elapsed);
      }
    }
  };
}

/** 格式化时间为 HH:MM:SS.mmm 或 MM:SS.mmm。 */
export function formatTimecode(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const mmm = String(ms).padStart(3, "0");
  return h > 0 ? `${h}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`;
}
