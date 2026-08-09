<script setup lang="ts">
// 统一 SVG 图标组件。内置线性图标，绝不使用 emoji 充当图标。
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    name: string;
    size?: number;
    label?: string;
  }>(),
  { size: 20, label: "" },
);

// 24x24 视图内的路径定义（stroke 线性风格）
const paths: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5",
  video: "M4 5h16v14H4zM10 9l5 3-5 3z",
  process: "M4 20V10M9 20V4M14 20v-8M19 20V7",
  shop: "M4 8h16l-1 12H5zM8 8V6a4 4 0 0 1 8 0v2",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 1a7 7 0 0 0-2-1l-1-2H8L7 5a7 7 0 0 0-2 1L3 5 1 9l2 1a7 7 0 0 0 0 2l-2 1 2 4 2-1a7 7 0 0 0 2 1l1 2h4l1-2a7 7 0 0 0 2-1l2 1 2-4-2-1a7 7 0 0 0 0-2z",
  puzzle:
    "M10 3v2a2 2 0 1 0 4 0V3h4v4h2a2 2 0 1 1 0 4h-2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4H4a2 2 0 1 1 0-4h2V3z",
  star: "M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3.4 1.1-6.5L2.6 9.8l6.5-.9z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  menu: "M4 6h16M4 12h16M4 18h16",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  chevronUp: "M6 15l6-6 6 6",
  chevronDown: "M6 9l6 6 6-6",
  folder: "M3 6h6l2 2h10v11H3z",
  refresh: "M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2M18 4v5h-5M6 20v-5h5",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  play: "M8 5v14l11-7z",
  pause: "M7 5h4v14H7zM13 5h4v14h-4z",
  alert: "M12 3l9 16H3zM12 10v4M12 17v.5",
  source:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c-2.5 2.4-4 5.5-4 9s1.5 6.6 4 9c2.5-2.4 4-5.5 4-9s-1.5-6.6-4-9z",
  // 实用工具图标集（线性）
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  wrench:
    "M14 6a4 4 0 0 0-5 5L4 16v4h4l5-5a4 4 0 0 0 5-5l-3 3-3-3z",
  braces:
    "M8 4c-2 0-2 2-2 4s0 3-2 4c2 1 2 2 2 4s0 4 2 4M16 4c2 0 2 2 2 4s0 3 2 4c-2 1-2 2-2 4s0 4-2 4",
  code: "M9 8l-5 4 5 4M15 8l5 4-5 4",
  link: "M10 14a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1",
  fingerprint:
    "M12 5a7 7 0 0 0-7 7v3M9 21a10 10 0 0 0 .5-9 3 3 0 0 1 5.5 2v2M19 16v-4a7 7 0 0 0-4-6.3M12 12v3a6 6 0 0 0 1 3",
  hash: "M9 4L7 20M17 4l-2 16M5 9h15M4 15h15",
  key: "M14 7a4 4 0 1 1-5 5l-5 5v3h3l1-1h2v-2h2l2-2a4 4 0 0 0 0-8zM16 9h.01",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  binary:
    "M7 4h2v7H7zM6 11h4M8 13h1v7H7M15 4h2v7h-2zM14 11h4M16 13h1v7h-2",
  palette:
    "M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2 0-1.5 1-2 2-2h1a4 4 0 0 0 4-4c0-5-4-8-9-8zM7 12h.01M10 8h.01M15 8h.01",
  type: "M4 6V4h16v2M12 4v16M9 20h6",
  regex: "M4 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM14 5v8M11 7l6 4M11 11l6-4",
  shield: "M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z",
  copy: "M9 9h10v10H9zM5 15H4V4h11v1",
  check: "M5 12l5 5 9-11",
  wand: "M15 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1zM13 8L4 17l3 3 9-9",
  x: "M6 6l12 12M18 6L6 18",
  loader: "M12 3a9 9 0 1 0 9 9",
  file: "M6 4h8l4 4v12H6zM14 4v4h4",
  office: "M4 4h6v16H4zM12 4h8v4h-8zM12 10h8v4h-8zM12 16h8v4h-8z",
  document: "M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6",
  presentation: "M4 4h16v12H4zM8 20l4-4 4 4M8 8h8M8 11h5",
  spreadsheet: "M4 4h16v16H4zM4 9h16M4 14h16M10 4v16",
  pdf: "M6 3h8l4 4v14H6zM14 3v5h5M8 13h2a2 2 0 0 0 0-4H8v7M12 16v-7h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2z",
  markdown: "M3 6h18v12H3zM6 14V9l3 3 3-3v5M15 11l2 2 2-2M17 9v4",
  swap: "M7 4l-4 4 4 4M3 8h14M17 20l4-4-4-4M21 16H7",
  save: "M5 4h14v16H5zM8 4v5h7M8 14h8v6H8z",
  upload: "M12 3v12M7 8l5-5 5 5M4 21h16",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeOff: "M3 3l18 18M10 6a10 7 0 0 1 12 6 10 7 0 0 1-2 3M6 8a10 7 0 0 0-4 4 10 7 0 0 0 12 4M9 9a3 3 0 0 0 4 4",
  ban: "M4 4l16 16M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  shieldCheck: "M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6zM9 12l2 2 4-4",
};

const d = computed(() => paths[props.name] ?? paths.puzzle);
const ariaHidden = computed(() => (props.label ? undefined : true));
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="ariaHidden"
    :aria-label="label || undefined"
    :role="label ? 'img' : undefined"
  >
    <path :d="d" />
  </svg>
</template>
