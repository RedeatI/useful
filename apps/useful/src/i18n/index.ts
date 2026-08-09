// 轻量响应式 i18n：点分 key 取值 + 占位符替换。
import { ref } from "vue";
import zhCN from "./zh-CN";
import enUS from "./en-US";
import type { Locale } from "@/lib/types";

export type { Locale } from "@/lib/types";

const messages: Record<Locale, Record<string, unknown>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

const currentLocale = ref<Locale>("zh-CN");

export function setLocale(locale: Locale): void {
  currentLocale.value = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

export function getLocale(): Locale {
  return currentLocale.value;
}

function resolve(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * 翻译函数。`t("nav.home")`；支持 `t("shortcut.repaired", { count: 3 })`。
 * 找不到 key 时返回 key 本身，便于开发期发现缺失。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  // Reading the ref here registers a Vue render dependency, so all callers update immediately.
  let str = resolve(messages[currentLocale.value], key) ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

export default { t, setLocale, getLocale };
