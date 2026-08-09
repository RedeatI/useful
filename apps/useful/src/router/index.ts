// 路由：内置工具静态路由 + 第三方插件动态路由（/plugin/:id）。
// video-trim / process-monitor 由宿主 capabilities 门控（Core edition 不注册对应后端）。
import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import { useAppStore } from "@/stores/app";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "home",
    component: () => import("@/views/HomeView.vue"),
  },
  {
    path: "/library",
    name: "library",
    component: () => import("@/views/ToolLibraryView.vue"),
  },
  {
    path: "/tools/video-trim",
    name: "video-trim",
    component: () => import("@/views/VideoTrimView.vue"),
    meta: { requiresMedia: true },
  },
  {
    path: "/media-runtime",
    name: "media-runtime",
    component: () => import("@/views/MediaRuntimeView.vue"),
    meta: { requiresMedia: true },
  },
  {
    path: "/tools/process-monitor",
    name: "process-monitor",
    component: () => import("@/views/ProcessMonitorView.vue"),
    meta: { requiresProcmon: true },
  },
  {
    // 实用工具（DevToys 风格）：网格与具体工具同页切换
    path: "/tools/utilities/:id?",
    name: "utilities",
    component: () => import("@/views/tools/UtilitiesView.vue"),
    props: true,
  },
  {
    path: "/tools/office/:id?",
    name: "office",
    component: () => import("@/views/tools/office/OfficeView.vue"),
    props: true,
  },
  {
    path: "/shop",
    name: "shop",
    component: () => import("@/views/ToolShopView.vue"),
  },
  {
    path: "/sources",
    name: "sources",
    component: () => import("@/views/SourceCenterView.vue"),
  },
  {
    path: "/downloads",
    name: "downloads",
    component: () => import("@/views/DownloadsView.vue"),
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("@/views/SettingsView.vue"),
  },
  {
    // 第三方插件页面：由工具注册表驱动，沙箱加载
    path: "/plugin/:id",
    name: "plugin",
    component: () => import("@/views/PluginHostView.vue"),
    props: true,
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/",
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const caps = useAppStore().appInfo?.capabilities;
  // Until appInfo loads, allow navigation; list_tools already hides unavailable builtins.
  if (!caps) return true;
  if (to.meta.requiresMedia && !caps.media) return { name: "home" };
  if (to.meta.requiresProcmon && !caps.procmon) return { name: "home" };
  return true;
});

export default router;
