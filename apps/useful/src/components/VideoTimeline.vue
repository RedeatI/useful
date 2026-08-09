<script setup lang="ts">
// 时间轴组件：虚拟化刻度/缩略图、播放头拖动（seek 节流）、入/出点标记、缩放平移。
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  visibleTicks,
  visibleThumbnailSlots,
  timeToX,
  xToTime,
  zoomAt,
  clampTime,
  formatTimecode,
  createSeekThrottle,
  thumbnailInterval,
  type TimelineView,
} from "@/lib/videoTimeline";

const props = defineProps<{
  duration: number;
  playhead: number;
  inPoint: number;
  outPoint: number;
  thumbLoader: (sec: number) => string | undefined; // 返回已缓存缩略图 dataURL
  requestThumb: (sec: number) => void; // 请求生成某时间点缩略图
}>();

const emit = defineEmits<{
  seek: [sec: number];
  setIn: [sec: number];
  setOut: [sec: number];
}>();

const el = ref<HTMLElement | null>(null);
const widthPx = ref(800);
const zoom = ref(1);
const panSec = ref(0);
const dragging = ref(false);

const view = computed<TimelineView>(() => ({
  durationSec: props.duration,
  widthPx: widthPx.value,
  zoom: zoom.value,
  panSec: panSec.value,
}));

const ticks = computed(() => visibleTicks(view.value));
const thumbInterval = computed(() => thumbnailInterval(props.duration, widthPx.value, zoom.value));
const slots = computed(() => visibleThumbnailSlots(view.value, thumbInterval.value));

const playheadX = computed(() => timeToX(view.value, props.playhead));
const inX = computed(() => timeToX(view.value, props.inPoint));
const outX = computed(() => timeToX(view.value, props.outPoint));

const throttledSeek = createSeekThrottle((sec) => emit("seek", sec), 120);

function localX(e: MouseEvent): number {
  const rect = el.value?.getBoundingClientRect();
  return rect ? e.clientX - rect.left : 0;
}

function onPointerDown(e: MouseEvent): void {
  dragging.value = true;
  const sec = clampTime(xToTime(view.value, localX(e)), props.duration);
  throttledSeek(sec);
}
function onPointerMove(e: MouseEvent): void {
  if (!dragging.value) return;
  const sec = clampTime(xToTime(view.value, localX(e)), props.duration);
  throttledSeek(sec);
}
function onPointerUp(): void {
  dragging.value = false;
}

function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.shiftKey) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const r = zoomAt(view.value, factor, localX(e));
    zoom.value = r.zoom;
    panSec.value = r.panSec;
  }
}

function zoomBy(factor: number): void {
  const r = zoomAt(view.value, factor, widthPx.value / 2);
  zoom.value = r.zoom;
  panSec.value = r.panSec;
}
defineExpose({ zoomBy });

// 为可见缩略图槽请求生成（渐进加载）
watch(
  () => slots.value.map((s) => Math.round(s.sec)),
  (secs) => {
    for (const s of secs) {
      if (!props.thumbLoader(s)) props.requestThumb(s);
    }
  },
);

let ro: ResizeObserver | null = null;
onMounted(() => {
  if (el.value) {
    widthPx.value = el.value.clientWidth;
    ro = new ResizeObserver(() => {
      if (el.value) widthPx.value = el.value.clientWidth;
    });
    ro.observe(el.value);
  }
  window.addEventListener("mousemove", onPointerMove);
  window.addEventListener("mouseup", onPointerUp);
});
onUnmounted(() => {
  ro?.disconnect();
  window.removeEventListener("mousemove", onPointerMove);
  window.removeEventListener("mouseup", onPointerUp);
});
</script>

<template>
  <div class="tl">
    <div ref="el" class="tl__track" @mousedown="onPointerDown" @wheel="onWheel">
      <!-- 缩略图槽（仅可见） -->
      <div
        v-for="slot in slots"
        :key="'th' + slot.sec"
        class="tl__thumb"
        :style="{ left: slot.x + 'px', width: slot.width + 'px' }"
      >
        <img v-if="thumbLoader(Math.round(slot.sec))" :src="thumbLoader(Math.round(slot.sec))" alt="" />
      </div>

      <!-- 选中区间高亮 -->
      <div
        class="tl__selection"
        :style="{ left: inX + 'px', width: Math.max(0, outX - inX) + 'px' }"
      />

      <!-- 刻度（仅可见） -->
      <div v-for="tick in ticks" :key="'t' + tick.sec" class="tl__tick" :style="{ left: tick.x + 'px' }">
        <span class="tl__tick-label">{{ formatTimecode(tick.sec) }}</span>
      </div>

      <!-- 入/出点标记 -->
      <div class="tl__marker tl__marker--in" :style="{ left: inX + 'px' }" />
      <div class="tl__marker tl__marker--out" :style="{ left: outX + 'px' }" />

      <!-- 播放头 -->
      <div class="tl__playhead" :style="{ left: playheadX + 'px' }" />
    </div>
  </div>
</template>

<style scoped>
.tl {
  width: 100%;
}
.tl__track {
  position: relative;
  height: 96px;
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-md);
  overflow: hidden;
  cursor: pointer;
  user-select: none;
}
.tl__thumb {
  position: absolute;
  top: 20px;
  bottom: 0;
  overflow: hidden;
  border-right: 1px solid var(--useful-border);
}
.tl__thumb img {
  height: 100%;
  width: 100%;
  object-fit: cover;
  display: block;
}
.tl__selection {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(28, 167, 196, 0.18);
  border-left: 2px solid var(--useful-accent);
  border-right: 2px solid var(--useful-accent);
  pointer-events: none;
}
.tl__tick {
  position: absolute;
  top: 0;
  height: 18px;
  border-left: 1px solid var(--useful-border-strong);
  pointer-events: none;
}
.tl__tick-label {
  font-size: 10px;
  color: var(--useful-text-tertiary);
  padding-left: 3px;
  white-space: nowrap;
}
.tl__marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  pointer-events: none;
}
.tl__marker--in {
  background: #6ccb5f;
}
.tl__marker--out {
  background: #f2b705;
}
.tl__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--useful-danger);
  pointer-events: none;
}
</style>
