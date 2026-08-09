<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, triggerRef } from "vue";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { t } from "@/i18n";
import ipc from "@/lib/ipc";
import { ProcTable, type ProcRow, type SortColumn, type SortDir } from "@/lib/procTable";
import { formatBytes, formatPercent, formatRate, metricValue } from "@/lib/format";
import type { ProcessDelta, ProcmonStats } from "@/lib/types";
import AppIcon from "@/components/AppIcon.vue";

const ROW_HEIGHT = 30;
const OVERSCAN = 6;
const EXPANDED_KEY = "useful.procmon.expanded";

const table = shallowRef(new ProcTable());
const mode = ref<"tree" | "list">("tree");
const sortCol = ref<SortColumn>("cpu");
const sortDir = ref<SortDir>("desc");
const search = ref("");
const expanded = ref<Set<string>>(loadExpanded());
const running = ref(false);
const paused = ref(false);
const stats = ref<ProcmonStats | null>(null);
const errorMsg = ref<string | null>(null);

// 虚拟化滚动
const scrollTop = ref(0);
const viewportH = ref(600);
const scroller = ref<HTMLElement | null>(null);

let unlisten: UnlistenFn | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}
function saveExpanded(): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded.value]));
  } catch {
    /* ignore */
  }
}

// 全部可见行（树或列表）
const rows = computed<ProcRow[]>(() => {
  // 依赖 table 版本（triggerRef 触发）与各控制项
  void table.value;
  if (mode.value === "tree") {
    return table.value.treeMode(sortCol.value, sortDir.value, search.value, expanded.value);
  }
  return table.value.listMode(sortCol.value, sortDir.value, search.value);
});

// 可见窗口
const totalHeight = computed(() => rows.value.length * ROW_HEIGHT);
const startIndex = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN),
);
const endIndex = computed(() =>
  Math.min(
    rows.value.length,
    Math.ceil((scrollTop.value + viewportH.value) / ROW_HEIGHT) + OVERSCAN,
  ),
);
const visibleRows = computed(() => rows.value.slice(startIndex.value, endIndex.value));
const topPad = computed(() => startIndex.value * ROW_HEIGHT);

const columns: { key: SortColumn; label: string; sortable: boolean }[] = [
  { key: "name", label: "procmon.colName", sortable: true },
  { key: "pid", label: "procmon.colPid", sortable: true },
  { key: "cpu", label: "procmon.colCpu", sortable: true },
  { key: "memory", label: "procmon.colMemory", sortable: true },
  { key: "disk", label: "procmon.colDisk", sortable: true },
  { key: "net", label: "procmon.colNet", sortable: true },
  { key: "gpu", label: "procmon.colGpu", sortable: true },
  { key: "gpuMemory", label: "procmon.colGpuMem", sortable: true },
  { key: "pid", label: "procmon.colThreads", sortable: false },
  { key: "pid", label: "procmon.colHandles", sortable: false },
];

const gridTemplate =
  "minmax(220px,2fr) 80px 80px 100px 110px 160px 80px 100px 70px 70px";

function onScroll(e: Event): void {
  scrollTop.value = (e.target as HTMLElement).scrollTop;
}

function toggleSort(col: SortColumn): void {
  if (sortCol.value === col) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortCol.value = col;
    sortDir.value = "desc";
  }
}

function toggleExpand(row: ProcRow): void {
  if (expanded.value.has(row.key)) expanded.value.delete(row.key);
  else expanded.value.add(row.key);
  expanded.value = new Set(expanded.value);
  saveExpanded();
}

function hasChildren(row: ProcRow): boolean {
  return table.value.allRows().some((r) => r.parentKey === row.key);
}

function expandAll(): void {
  const all = new Set<string>();
  for (const r of table.value.allRows()) all.add(r.key);
  expanded.value = all;
  saveExpanded();
}
function collapseAll(): void {
  expanded.value = new Set();
  saveExpanded();
}

async function start(): Promise<void> {
  errorMsg.value = null;
  try {
    await ipc.procmonStart();
    running.value = true;
    paused.value = false;
  } catch (e) {
    errorMsg.value = String(e);
  }
}
async function togglePause(): Promise<void> {
  paused.value = !paused.value;
  await ipc.procmonSetPaused(paused.value);
}
async function refresh(): Promise<void> {
  // 差量由后端每秒推送；此处仅刷新一次统计
  await pollStats();
}

async function pollStats(): Promise<void> {
  try {
    stats.value = await ipc.procmonStats();
    running.value = stats.value.running;
    paused.value = stats.value.paused;
  } catch {
    /* ignore */
  }
}

// 右键上下文菜单（视口钳制，避免贴边溢出）
const MENU_WIDTH = 220;
const MENU_EST_HEIGHT = 220;
const menu = ref<{ x: number; y: number; row: ProcRow } | null>(null);
const elevated = ref(false);
/** 网卡列表默认折叠，避免几十个虚拟接口撑满视口。 */
const showInterfaces = ref(false);

const networkInterfaces = computed(() => {
  const list = stats.value?.network?.interfaces ?? [];
  return [...list].sort((a, b) => {
    const traffic = (i: typeof a) => i.upBytesPerSec + i.downBytesPerSec;
    const diff = traffic(b) - traffic(a);
    if (diff !== 0) return diff;
    return (a.name || a.description || a.key).localeCompare(b.name || b.description || b.key, "zh-CN");
  });
});
const activeInterfaceCount = computed(
  () => networkInterfaces.value.filter((i) => i.upBytesPerSec + i.downBytesPerSec > 0).length,
);

function openMenu(e: MouseEvent, row: ProcRow): void {
  e.preventDefault();
  e.stopPropagation();
  const x = Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 8);
  const y = Math.min(e.clientY, window.innerHeight - MENU_EST_HEIGHT - 8);
  menu.value = { x: Math.max(8, x), y: Math.max(8, y), row };
}
function closeMenu(): void {
  menu.value = null;
}

// 从内部 map 读取 exe / 命令行（allRows 不含静态字段，改用专用查询）
function findExe(key: string): string | undefined {
  return table.value.exePathOf(key);
}
function findCmd(key: string): string | undefined {
  return table.value.cmdLineOf(key);
}

async function openFolder(row: ProcRow): Promise<void> {
  closeMenu();
  const exe = findExe(row.key);
  if (!exe) {
    errorMsg.value = t("procmon.noExePath");
    return;
  }
  try {
    await ipc.procmonOpenFolder(exe);
  } catch (e) {
    errorMsg.value = String(e);
  }
}
async function copyText(text: string): Promise<void> {
  closeMenu();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}
const cmdlineDialog = ref<string | null>(null);
function viewCmdline(row: ProcRow): void {
  closeMenu();
  cmdlineDialog.value = findCmd(row.key) ?? t("procmon.noCommandLine");
}

const needsManualElevation = computed(() => {
  const etw = stats.value?.network?.etwCapability;
  return Boolean(etw && !etw.available && etw.reasonCode === "etw_access_denied" && !elevated.value);
});

async function refreshElevation(): Promise<void> {
  try {
    const status = await ipc.elevationStatus();
    elevated.value = status.elevated;
  } catch {
    elevated.value = false;
  }
}

onMounted(async () => {
  if (scroller.value) viewportH.value = scroller.value.clientHeight;
  unlisten = await listen<ProcessDelta>("procmon-delta", (event) => {
    table.value.applyDelta(event.payload);
    triggerRef(table);
  });
  await refreshElevation();
  await start();
  statsTimer = setInterval(pollStats, 1000);
});

onUnmounted(async () => {
  unlisten?.();
  if (statsTimer) clearInterval(statsTimer);
  await ipc.procmonStop().catch(() => {});
});
</script>

<template>
  <div class="pm" @click="closeMenu">
    <div class="pm__head">
      <h1 class="pm__title">{{ t("procmon.title") }}</h1>
      <div class="pm__status">
        <span
          class="useful-badge"
          :class="running && !paused ? 'useful-badge--accent' : ''"
        >
          {{ paused ? t("procmon.paused") : running ? t("procmon.running") : t("procmon.stopped") }}
        </span>
        <span class="useful-badge">{{ t("procmon.processCount", { count: rows.length }) }}</span>
        <span v-if="stats && !stats.processControlAvailable" class="useful-badge">
          {{ t("procmon.readOnlyMode") }}
        </span>
      </div>
    </div>

    <div class="pm__toolbar">
      <button class="useful-btn" :disabled="!running" @click="togglePause">
        <AppIcon :name="paused ? 'play' : 'pause'" :size="16" />
        {{ paused ? t("procmon.resume") : t("procmon.pause") }}
      </button>
      <button class="useful-btn" @click="refresh">
        <AppIcon name="refresh" :size="16" />{{ t("procmon.refresh") }}
      </button>
      <div class="seg">
        <button
          class="seg__btn"
          :class="{ 'seg__btn--active': mode === 'tree' }"
          @click="mode = 'tree'"
        >
          {{ t("procmon.treeMode") }}
        </button>
        <button
          class="seg__btn"
          :class="{ 'seg__btn--active': mode === 'list' }"
          @click="mode = 'list'"
        >
          {{ t("procmon.listMode") }}
        </button>
      </div>
      <button v-if="mode === 'tree'" class="useful-btn useful-btn--ghost" @click="expandAll">
        {{ t("procmon.expandAll") }}
      </button>
      <button v-if="mode === 'tree'" class="useful-btn useful-btn--ghost" @click="collapseAll">
        {{ t("procmon.collapseAll") }}
      </button>
      <input
        v-model="search"
        class="useful-input pm__search"
        type="text"
        :placeholder="t('procmon.searchPlaceholder')"
        :aria-label="t('procmon.searchPlaceholder')"
      />
    </div>

    <p class="pm__note">
      <AppIcon name="alert" :size="14" /> {{ t("procmon.counterNote") }}
    </p>
    <section v-if="stats" class="pm__network" :aria-label="t('procmon.networkStatusLabel')">
      <div class="pm__network-summary">
        <strong>{{ t("procmon.interfaceThroughput") }}</strong>
        <template v-if="stats.network.interfaceCapability.available">
          <span>↑ {{ formatRate(stats.network.totalUpBytesPerSec) }}</span>
          <span>↓ {{ formatRate(stats.network.totalDownBytesPerSec) }}</span>
          <button
            type="button"
            class="pm__iface-toggle"
            :aria-expanded="showInterfaces"
            data-testid="toggle-network-interfaces"
            :title="stats.network.aggregateScope"
            @click.stop="showInterfaces = !showInterfaces"
          >
            {{ t("procmon.interfaceListToggle", {
              count: networkInterfaces.length,
              active: activeInterfaceCount,
            }) }}
            <span class="pm__iface-chevron" aria-hidden="true">{{ showInterfaces ? "▾" : "▸" }}</span>
          </button>
        </template>
        <span v-else class="pm__na">
          {{ stats.network.interfaceCapability.remediation ?? t("procmon.interfaceUnavailable") }}
        </span>
      </div>
      <div
        v-if="stats.network.interfaceCapability.available && showInterfaces"
        class="pm__interfaces"
        data-testid="network-interfaces-list"
        :title="stats.network.aggregateScope"
      >
        <span
          v-for="iface in networkInterfaces"
          :key="iface.key"
          class="pm__interface"
          :class="{
            'pm__interface--excluded': iface.isLoopback,
            'pm__interface--idle': iface.upBytesPerSec + iface.downBytesPerSec === 0 && !iface.isLoopback,
          }"
          :title="iface.description"
        >
          {{ iface.name || iface.description || iface.key }}
          <small v-if="iface.isLoopback">{{ t("procmon.loopbackExcluded") }}</small>
          <small v-else-if="iface.isVirtual">{{ t("procmon.virtualIncluded") }}</small>
          <span>↑{{ formatRate(iface.upBytesPerSec) }} ↓{{ formatRate(iface.downBytesPerSec) }}</span>
        </span>
      </div>
      <p v-if="!stats.network.etwCapability.available" class="pm__network-hint">
        <strong>{{ t("procmon.processBytesUnavailable") }}</strong>
        <code v-if="stats.network.etwCapability.reasonCode">{{ stats.network.etwCapability.reasonCode }}</code>
        {{ stats.network.etwCapability.remediation ?? "" }}
        {{ t("procmon.processBytesFallback") }}
      </p>
      <p v-if="needsManualElevation" class="pm__network-hint" data-testid="manual-elevation-guidance">
        {{ t("procmon.manualElevation") }}
      </p>
      <p v-else-if="elevated && stats.network.etwCapability.available" class="pm__network-hint pm__network-hint--ok">
        {{ t("procmon.elevatedActive") }}
      </p>
      <p v-if="!stats.network.connectionCapability.available" class="pm__network-hint">
        <strong>{{ t("procmon.connectionCountsUnavailable") }}</strong>
        <code v-if="stats.network.connectionCapability.reasonCode">{{ stats.network.connectionCapability.reasonCode }}</code>
        {{ stats.network.connectionCapability.remediation ?? "" }}
      </p>
    </section>
    <p v-if="errorMsg" class="pm__error" role="alert">{{ errorMsg }}</p>

    <!-- 表头 -->
    <div class="pm__header" :style="{ gridTemplateColumns: gridTemplate }">
      <button
        v-for="(col, idx) in columns"
        :key="idx"
        class="pm__th"
        :class="{ 'pm__th--right': col.key !== 'name' || idx !== 0, 'pm__th--btn': col.sortable }"
        :disabled="!col.sortable"
        @click="col.sortable && toggleSort(col.key)"
      >
        {{ t(col.label) }}
        <span v-if="col.sortable && sortCol === col.key" class="pm__sort">
          {{ sortDir === "asc" ? "▲" : "▼" }}
        </span>
      </button>
    </div>

    <!-- 虚拟化行区 -->
    <div ref="scroller" class="pm__body" @scroll="onScroll">
      <div v-if="rows.length === 0" class="pm__empty">{{ t("procmon.startHint") }}</div>
      <div v-else :style="{ height: totalHeight + 'px', position: 'relative' }">
        <div :style="{ transform: `translateY(${topPad}px)` }">
          <div
            v-for="row in visibleRows"
            :key="row.key"
            class="pm__row"
            :style="{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT + 'px' }"
            @contextmenu="openMenu($event, row)"
          >
            <div class="pm__cell pm__cell--name" :style="{ paddingLeft: (mode === 'tree' ? row.depth * 16 + 4 : 4) + 'px' }">
              <button
                v-if="mode === 'tree' && hasChildren(row)"
                class="pm__twisty"
                @click.stop="toggleExpand(row)"
                :aria-label="expanded.has(row.key) ? t('procmon.collapseAll') : t('procmon.expandAll')"
              >
                {{ expanded.has(row.key) ? "▾" : "▸" }}
              </button>
              <span v-else class="pm__twisty pm__twisty--empty" />
              <span class="pm__name" :title="row.name">{{ row.name }}</span>
            </div>
            <div class="pm__cell pm__cell--num">{{ row.pid }}</div>
            <div class="pm__cell pm__cell--num">{{ formatPercent(row.dynamic.cpu) }}</div>
            <div class="pm__cell pm__cell--num">{{ formatBytes(row.dynamic.workingSet) }}</div>
            <div class="pm__cell pm__cell--num">
              {{ formatRate(row.dynamic.diskRead + row.dynamic.diskWrite) }}
            </div>
            <div class="pm__cell pm__cell--num">
              <template v-if="metricValue(row.dynamic.netUp) !== undefined || metricValue(row.dynamic.netDown) !== undefined">
                <span>↑{{ metricValue(row.dynamic.netUp) === undefined ? t("procmon.unavailable") : formatRate(metricValue(row.dynamic.netUp)!) }}</span>
                <span>↓{{ metricValue(row.dynamic.netDown) === undefined ? t("procmon.unavailable") : formatRate(metricValue(row.dynamic.netDown)!) }}</span>
              </template>
              <span
                v-if="metricValue(row.dynamic.tcpConnections) !== undefined || metricValue(row.dynamic.udpEndpoints) !== undefined"
                class="pm__connection-count"
                :title="t('procmon.connectionCountTitle')"
              >
                {{ t("procmon.connections", {
                  tcp: metricValue(row.dynamic.tcpConnections) ?? t("procmon.unavailable"),
                  udp: metricValue(row.dynamic.udpEndpoints) ?? t("procmon.unavailable"),
                }) }}
              </span>
              <span
                v-else-if="metricValue(row.dynamic.netUp) === undefined && metricValue(row.dynamic.netDown) === undefined"
                class="pm__na"
              >{{ t("procmon.unavailable") }}</span>
            </div>
            <div class="pm__cell pm__cell--num">
              <template v-if="metricValue(row.dynamic.gpu) !== undefined">
                {{ formatPercent(metricValue(row.dynamic.gpu)!) }}
              </template>
              <span v-else class="pm__na">{{ t("procmon.unavailable") }}</span>
            </div>
            <div class="pm__cell pm__cell--num">
              <template v-if="metricValue(row.dynamic.gpuMemory) !== undefined">
                {{ formatBytes(metricValue(row.dynamic.gpuMemory)!) }}
              </template>
              <span v-else class="pm__na">{{ t("procmon.unavailable") }}</span>
            </div>
            <div class="pm__cell pm__cell--num">{{ row.dynamic.threads }}</div>
            <div class="pm__cell pm__cell--num">
              <template v-if="metricValue(row.dynamic.handles) !== undefined">
                {{ metricValue(row.dynamic.handles) }}
              </template>
              <span v-else class="pm__na">{{ t("procmon.unavailable") }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 上下文菜单：信息 / 打开 / 危险操作 分组 -->
    <div
      v-if="menu"
      class="pm__menu"
      role="menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <div class="pm__menu-header" :title="menu.row.name">
        <strong>{{ menu.row.name }}</strong>
        <span>PID {{ menu.row.pid }}</span>
      </div>
      <button class="pm__menu-item" role="menuitem" @click="copyText(menu.row.name)">
        {{ t("procmon.copyName") }}
      </button>
      <button class="pm__menu-item" role="menuitem" @click="copyText(String(menu.row.pid))">
        {{ t("procmon.copyPid") }}
      </button>
      <button
        class="pm__menu-item"
        role="menuitem"
        :disabled="!findExe(menu.row.key)"
        @click="copyText(findExe(menu.row.key) ?? '')"
      >
        {{ t("procmon.copyPath") }}
      </button>
      <button class="pm__menu-item" role="menuitem" @click="viewCmdline(menu.row)">
        {{ t("procmon.viewCmdline") }}
      </button>
      <div class="pm__menu-sep" />
      <button
        class="pm__menu-item"
        role="menuitem"
        :disabled="!findExe(menu.row.key)"
        @click="openFolder(menu.row)"
      >
        {{ t("procmon.openFolder") }}
      </button>
    </div>

    <!-- 命令行对话框 -->
    <div v-if="cmdlineDialog !== null" class="pm__dialog-overlay" @click="cmdlineDialog = null">
      <div class="pm__dialog" @click.stop>
        <h3>{{ t("procmon.cmdlineTitle") }}</h3>
        <pre class="pm__cmdline useful-mono">{{ cmdlineDialog }}</pre>
        <button class="useful-btn" @click="cmdlineDialog = null">{{ t("common.close") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pm {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: var(--useful-space-4) var(--useful-space-5);
  overflow: hidden;
}
.pm__head {
  display: flex;
  align-items: center;
  gap: var(--useful-space-3);
  flex-shrink: 0;
}
.pm__title {
  font-size: var(--useful-text-xl);
  font-weight: 700;
  margin: 0;
}
.pm__status {
  display: flex;
  gap: var(--useful-space-2);
}
.pm__toolbar {
  display: flex;
  align-items: center;
  gap: var(--useful-space-2);
  margin: var(--useful-space-3) 0;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.pm__network {
  flex-shrink: 0;
  margin: 0 0 var(--useful-space-2);
  padding: var(--useful-space-2) var(--useful-space-3);
  border: 1px solid var(--useful-border);
  border-radius: var(--useful-radius-md);
  background: var(--useful-bg-layer);
  font-size: var(--useful-text-xs);
  min-height: 0;
  max-height: min(36vh, 280px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pm__network-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--useful-space-3);
  flex-shrink: 0;
}
.pm__iface-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--useful-border);
  border-radius: 999px;
  background: var(--useful-bg);
  color: var(--useful-text-secondary);
  font: inherit;
  font-size: var(--useful-text-xs);
  cursor: pointer;
}
.pm__iface-toggle:hover {
  background: var(--useful-bg-hover);
  color: var(--useful-text);
}
.pm__iface-chevron {
  font-size: 10px;
  opacity: 0.8;
}
.pm__interfaces {
  display: flex;
  align-items: flex-start;
  align-content: flex-start;
  flex-wrap: wrap;
  gap: var(--useful-space-2);
  margin-top: var(--useful-space-2);
  min-height: 0;
  max-height: 7.5rem;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
}
.pm__interface {
  display: inline-flex;
  align-items: center;
  gap: var(--useful-space-2);
  max-width: 100%;
  padding: 2px var(--useful-space-2);
  border-radius: var(--useful-radius-sm);
  background: var(--useful-bg-elevated);
}
.pm__interface--excluded,
.pm__interface--idle {
  opacity: 0.62;
}
.pm__interface small,
.pm__connection-count {
  color: var(--useful-text-tertiary);
  font-size: 10px;
}
.pm__network-hint {
  margin: var(--useful-space-2) 0 0;
  color: var(--useful-text-tertiary);
}
.pm__network-hint--ok {
  color: var(--useful-success);
}
.pm__network-hint code {
  margin: 0 var(--useful-space-1);
}
.pm__search {
  max-width: 240px;
  margin-left: auto;
}
.pm__note {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  margin: 0 0 var(--useful-space-2);
  flex-shrink: 0;
}
.pm__error {
  color: var(--useful-danger);
  font-size: var(--useful-text-sm);
  margin: 0 0 var(--useful-space-2);
  flex-shrink: 0;
}
.pm__header {
  display: grid;
  border-bottom: 1px solid var(--useful-border-strong);
  background: var(--useful-bg-layer);
  flex-shrink: 0;
}
.pm__th {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  font-size: var(--useful-text-xs);
  font-weight: 600;
  color: var(--useful-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: inherit;
}
.pm__th--right {
  justify-content: flex-end;
}
.pm__sort {
  color: var(--useful-accent);
}
.pm__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.pm__empty {
  padding: var(--useful-space-6);
  text-align: center;
  color: var(--useful-text-tertiary);
}
.pm__row {
  display: grid;
  align-items: center;
  border-bottom: 1px solid var(--useful-border);
  font-size: var(--useful-text-sm);
}
.pm__row:hover {
  background: var(--useful-bg-hover);
}
.pm__cell {
  padding: 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pm__cell--num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pm__cell--name {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pm__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.pm__twisty {
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--useful-text-secondary);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
}
.pm__twisty--empty {
  cursor: default;
}
.pm__na {
  color: var(--useful-text-tertiary);
  font-style: italic;
}
.pm__menu {
  position: fixed;
  z-index: 500;
  min-width: 220px;
  max-width: min(320px, calc(100vw - 16px));
  background: var(--useful-bg-elevated);
  border: 1px solid var(--useful-border-strong);
  border-radius: var(--useful-radius-md);
  box-shadow: var(--useful-shadow-lg);
  padding: 4px;
}
.pm__menu-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px 6px;
  border-bottom: 1px solid var(--useful-border);
  margin-bottom: 4px;
}
.pm__menu-header strong {
  font-size: var(--useful-text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pm__menu-header span {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
}
.pm__menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--useful-text);
  cursor: pointer;
  border-radius: var(--useful-radius-sm);
  font-family: inherit;
  font-size: var(--useful-text-sm);
}
.pm__menu-item:hover:not(:disabled) {
  background: var(--useful-bg-hover);
}
.pm__menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pm__menu-sep {
  height: 1px;
  background: var(--useful-border);
  margin: 4px 0;
}
.pm__dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 600;
}
.pm__dialog {
  background: var(--useful-bg-elevated);
  border-radius: var(--useful-radius-lg);
  padding: var(--useful-space-4);
  max-width: 640px;
  width: 90%;
  box-shadow: var(--useful-shadow-lg);
}
.pm__cmdline {
  background: var(--useful-bg);
  padding: var(--useful-space-3);
  border-radius: var(--useful-radius-md);
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.seg {
  display: inline-flex;
  background: var(--useful-bg-active);
  border-radius: var(--useful-radius-md);
  padding: 2px;
}
.seg__btn {
  border: none;
  background: transparent;
  color: var(--useful-text-secondary);
  padding: 5px 12px;
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
