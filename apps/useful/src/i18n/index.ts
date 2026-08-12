// 轻量响应式 i18n：点分 key 取值 + 占位符替换。
import { ref } from "vue";
import zhCN from "./zh-CN";
import type { Locale } from "@/lib/types";

export type { Locale } from "@/lib/types";

type Messages = Record<string, unknown>;
type EnglishLocaleModule = { default: Messages };
export type EnglishLocaleLoader = () => Promise<EnglishLocaleModule>;

const loadBundledEnglish: EnglishLocaleLoader = () => import("./en-US");

let loadEnglish = loadBundledEnglish;
let englishMessages: Messages | undefined;
let englishLoad: Promise<Messages> | undefined;
let loaderGeneration = 0;
let localeGeneration = 0;

const currentLocale = ref<Locale>("zh-CN");

function applyLocale(locale: Locale): void {
  currentLocale.value = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

function loadEnglishMessages(): Promise<Messages> {
  if (englishMessages) return Promise.resolve(englishMessages);
  if (!englishLoad) {
    const generation = loaderGeneration;
    const pending = loadEnglish().then((module) => {
      if (generation === loaderGeneration) englishMessages = module.default;
      return module.default;
    });
    englishLoad = pending;
    void pending.catch(() => {
      if (generation === loaderGeneration && englishLoad === pending) englishLoad = undefined;
    });
  }
  return englishLoad;
}

/** Applies a locale only after its messages are available. Failures are contained. */
export function setLocale(locale: Locale): Promise<boolean> {
  const generation = ++localeGeneration;
  if (locale === "zh-CN" || englishMessages) {
    applyLocale(locale);
    return Promise.resolve(true);
  }
  return loadEnglishMessages().then(
    () => {
      if (generation !== localeGeneration) return false;
      applyLocale(locale);
      return true;
    },
    () => false,
  );
}

/** Test seam for deterministic chunk loading, retries, and races. */
export function resetLocaleForTests(loader: EnglishLocaleLoader = loadBundledEnglish): void {
  localeGeneration += 1;
  loaderGeneration += 1;
  loadEnglish = loader;
  englishMessages = undefined;
  englishLoad = undefined;
  applyLocale("zh-CN");
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
  const messages = currentLocale.value === "en-US" ? englishMessages : zhCN;
  let str = resolve(messages ?? zhCN, key) ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

export default { t, setLocale, getLocale };
