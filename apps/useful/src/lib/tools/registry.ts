// 实用工具前端注册表：两级模型 = 工具包(ToolDefinition) → actions(ToolActionDefinition[])。
// 元数据唯一权威来源：侧边栏、工具网格、搜索、命令面板、收藏、最近使用、快捷方式均从此派生。
// 新增工具只需在此登记一条 + 写一个组件 + 纯逻辑（+单测），互不影响——“各是一把刀”。
import type { Component } from "vue";
import { defineAsyncComponent } from "vue";
import { BUILTIN_ACTION_CATALOG } from "@useful/action-runtime/catalog";

export type UtilCategory = "encode" | "convert" | "generate" | "text" | "web";

export interface AutomationMetadata {
  contractVersion: "1.0";
  executionMode: "pure" | "worker";
  surfaces: readonly ("gui" | "runtime-cli" | "mcp")[];
}

/** 父工具 ID 常量 */
export const PARENT_TOOL_ID = "builtin.utilities";

/** 工具包定义（一级） */
export interface UtilTool {
  id: string;
  /** i18n key：util.<id>.name / util.<id>.desc */
  nameKey: string;
  descKey: string;
  /** AppIcon 名称 */
  icon: string;
  category: UtilCategory;
  keywords: string[];
  component: Component;
  /** 常用别名（搜索用） */
  aliases?: string[];
  /** 敏感输入：不记录输入内容、不进入最近输入 */
  sensitiveInput?: boolean;
  /** 预期输入大小 */
  expectedInputSize?: "small" | "medium" | "large";
  /** 排序 */
  order?: number;
  /** 已完成 GUI/runtime CLI 共享语义闭环的 normalized action 元数据。 */
  automation?: AutomationMetadata;
}

/** Action 定义（二级）：每个工具 action 拥有稳定不可变 ID */
export interface ToolActionDefinition {
  /** 稳定 action ID，如 builtin.utilities.base64 */
  id: string;
  /** 父工具 ID */
  parentToolId: string;
  /** 短标题（可选，默认用 nameKey） */
  shortTitle?: string;
  /** i18n key */
  nameKey: string;
  descKey: string;
  icon: string;
  category: UtilCategory;
  keywords: string[];
  aliases: string[];
  /** 深链接路由，如 /tools/utilities/base64 */
  route: string;
  component: Component;
  sensitiveInput: boolean;
  expectedInputSize: "small" | "medium" | "large";
  supportsShortcut: boolean;
  supportsFavorite: boolean;
  supportsRecent: boolean;
  order: number;
  automation?: AutomationMetadata & { actionId: string };
}

const lazy = (loader: () => Promise<unknown>): Component =>
  defineAsyncComponent(loader as never);

type ToolOverrides = Partial<Pick<
  UtilTool,
  "aliases" | "sensitiveInput" | "expectedInputSize" | "order" | "automation"
>>;

function defineTool(
  id: string,
  i18nStem: string,
  icon: string,
  category: UtilCategory,
  keywords: string[],
  loader: () => Promise<unknown>,
  overrides: ToolOverrides = {},
): UtilTool {
  return {
    id,
    nameKey: `util.${i18nStem}.name`,
    descKey: `util.${i18nStem}.desc`,
    icon,
    category,
    keywords,
    component: lazy(loader),
    ...overrides,
  };
}

export const UTIL_CATEGORIES: { key: UtilCategory; labelKey: string }[] = [
  { key: "encode", labelKey: "util.cat.encode" },
  { key: "convert", labelKey: "util.cat.convert" },
  { key: "text", labelKey: "util.cat.text" },
  { key: "generate", labelKey: "util.cat.generate" },
  { key: "web", labelKey: "util.cat.web" },
];

export const UTIL_TOOLS: UtilTool[] = [
  defineTool("json", "json", "braces", "convert", ["json", "格式化", "美化", "压缩", "校验", "树形", "查询", "pointer", "format", "tree", "query"], () => import("@/views/tools/util/JsonTool.vue"), {
    aliases: ["pretty", "beautify", "minify", "json-pointer"],
    expectedInputSize: "large",
    automation: { contractVersion: "1.0", executionMode: "pure", surfaces: ["gui", "runtime-cli"] },
  }),
  defineTool("base64", "base64", "code", "encode", ["base64", "编码", "解码", "encode", "decode"], () => import("@/views/tools/util/Base64Tool.vue"), {
    aliases: ["b64", "atob", "btoa"],
    expectedInputSize: "large",
    automation: { contractVersion: "1.0", executionMode: "pure", surfaces: ["gui", "runtime-cli"] },
  }),
  defineTool("hash", "hash", "fingerprint", "encode", ["hash", "哈希", "sha", "sha256", "摘要", "digest"], () => import("@/views/tools/util/HashTool.vue"), {
    aliases: ["sha1", "sha384", "sha512", "checksum", "校验和"],
    expectedInputSize: "large",
    automation: { contractVersion: "1.0", executionMode: "pure", surfaces: ["gui", "runtime-cli"] },
  }),
  defineTool("url", "url", "link", "encode", ["url", "编码", "解码", "percent", "转义"], () => import("@/views/tools/util/UrlTool.vue")),
  defineTool("uuid", "uuid", "hash", "generate", ["uuid", "guid", "唯一", "标识", "生成"], () => import("@/views/tools/util/UuidTool.vue"), {
    aliases: ["v4", "guid", "唯一id"],
  }),
  defineTool("password", "password", "key", "generate", ["password", "密码", "随机", "生成", "口令"], () => import("@/views/tools/util/PasswordTool.vue"), {
    aliases: ["pwd", "pass", "secret"],
    sensitiveInput: true,
  }),
  defineTool("timestamp", "timestamp", "clock", "convert", ["timestamp", "时间戳", "unix", "日期", "时间"], () => import("@/views/tools/util/TimestampTool.vue"), {
    aliases: ["epoch", "date", "datetime"],
  }),
  defineTool("base-convert", "baseConvert", "binary", "convert", ["进制", "二进制", "十六进制", "binary", "hex", "base"], () => import("@/views/tools/util/BaseConvertTool.vue"), {
    aliases: ["bin", "oct", "decimal"],
  }),
  defineTool("color", "color", "palette", "convert", ["color", "颜色", "hex", "rgb", "hsl", "调色"], () => import("@/views/tools/util/ColorTool.vue"), {
    aliases: ["colour", "picker"],
  }),
  defineTool("case", "case", "type", "text", ["case", "命名", "驼峰", "下划线", "camel", "snake"], () => import("@/views/tools/util/CaseTool.vue")),
  defineTool("regex", "regex", "regex", "text", ["regex", "正则", "匹配", "替换", "regexp"], () => import("@/views/tools/util/RegexTool.vue"), {
    aliases: ["regular expression", "pattern"],
    expectedInputSize: "large",
  }),
  defineTool("jwt", "jwt", "shield", "web", ["jwt", "token", "解码", "令牌", "decode"], () => import("@/views/tools/util/JwtTool.vue"), {
    aliases: ["json web token", "bearer"],
    sensitiveInput: true,
  }),
  defineTool("html", "html", "code", "encode", ["html", "实体", "转义", "entity", "escape", "去标签"], () => import("@/views/tools/util/HtmlEntitiesTool.vue")),
  defineTool("hex-text", "hexText", "binary", "encode", ["hex", "十六进制", "文本", "bytes", "字节"], () => import("@/views/tools/util/HexTextTool.vue")),
  defineTool("morse", "morse", "wand", "encode", ["morse", "摩尔斯", "电码", "点划"], () => import("@/views/tools/util/MorseTool.vue")),
  defineTool("text-stats", "textStats", "type", "text", ["字数", "统计", "字符", "行数", "count", "words"], () => import("@/views/tools/util/TextStatsTool.vue")),
  defineTool("text-lines", "textLines", "menu", "text", ["行", "排序", "去重", "去空", "sort", "dedupe", "lines"], () => import("@/views/tools/util/TextLinesTool.vue")),
  defineTool("slug", "slug", "link", "text", ["slug", "url", "固定链接", "短名"], () => import("@/views/tools/util/SlugTool.vue")),
  defineTool("byte-size", "byteSize", "binary", "convert", ["字节", "byte", "kb", "mb", "gb", "大小", "size"], () => import("@/views/tools/util/ByteSizeTool.vue")),
  defineTool("lorem", "lorem", "type", "generate", ["lorem", "ipsum", "占位", "假文", "placeholder"], () => import("@/views/tools/util/LoremTool.vue")),
  defineTool("duration", "duration", "clock", "convert", ["日期", "间隔", "duration", "相差", "时长"], () => import("@/views/tools/util/DurationTool.vue")),
  defineTool("byte-unit", "unit", "wrench", "convert", ["单位", "换算", "长度", "重量", "温度", "unit", "convert"], () => import("@/views/tools/util/UnitConvertTool.vue")),
  defineTool("number-format", "numberFormat", "hash", "convert", ["数字", "千分位", "格式化", "number", "format"], () => import("@/views/tools/util/NumberFormatTool.vue")),
  defineTool("unicode", "unicode", "type", "encode", ["unicode", "\\u", "转义", "escape", "码位"], () => import("@/views/tools/util/UnicodeTool.vue")),
  defineTool("caesar", "caesar", "wand", "text", ["凯撒", "caesar", "rot13", "位移", "cipher"], () => import("@/views/tools/util/CaesarTool.vue")),
  defineTool("luhn", "luhn", "fingerprint", "web", ["luhn", "信用卡", "银行卡", "校验", "校验位", "checksum"], () => import("@/views/tools/util/LuhnTool.vue"), {
    aliases: ["card", "credit card"],
  }),
  defineTool("contrast", "contrast", "palette", "web", ["对比度", "wcag", "contrast", "无障碍", "a11y"], () => import("@/views/tools/util/ContrastTool.vue")),
  defineTool("random-number", "random", "binary", "generate", ["随机", "random", "骰子", "数字", "number"], () => import("@/views/tools/util/RandomNumberTool.vue")),
  defineTool("data-format", "dataFormat", "braces", "convert", ["json", "yaml", "yml", "格式", "转换", "format"], () => import("@/views/tools/util/DataFormatTool.vue"), {
    aliases: ["json yaml", "yaml json"],
    expectedInputSize: "large",
  }),
  defineTool("text-diff", "textDiff", "menu", "text", ["diff", "文本", "比较", "差异", "行"], () => import("@/views/tools/util/TextDiffTool.vue"), {
    aliases: ["compare", "patch"],
    expectedInputSize: "large",
  }),
  defineTool("ipv4", "ipv4", "link", "web", ["ipv4", "cidr", "ip", "子网", "网段", "地址"], () => import("@/views/tools/util/Ipv4Tool.vue"), {
    aliases: ["subnet", "network"],
  }),
];

const UTIL_RECOMMENDED_ORDER: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(UTIL_TOOLS.map((tool, index) => [tool.id, (index + 1) * 10])),
);
const builtinDescriptorById = new Map(
  BUILTIN_ACTION_CATALOG.map((descriptor) => [descriptor.actionId, descriptor]),
);

export function findTool(id: string): UtilTool | undefined {
  return UTIL_TOOLS.find((tt) => tt.id === id);
}

// ---------- Action 级注册表（二级模型） ----------

/** 从 UtilTool 生成 ToolActionDefinition，action ID = builtin.utilities.<id> */
export const UTIL_ACTIONS: ToolActionDefinition[] = UTIL_TOOLS.map((tool) => {
  const actionId = `${PARENT_TOOL_ID}.${tool.id}`;
  const descriptor = builtinDescriptorById.get(actionId);
  return ({
  id: actionId,
  parentToolId: PARENT_TOOL_ID,
  nameKey: tool.nameKey,
  descKey: tool.descKey,
  icon: tool.icon,
  category: tool.category,
  keywords: tool.keywords,
  aliases: tool.aliases ?? [],
  route: `/tools/utilities/${tool.id}`,
  component: tool.component,
  sensitiveInput: tool.sensitiveInput ?? false,
  expectedInputSize: tool.expectedInputSize ?? "medium",
  supportsShortcut: true,
  supportsFavorite: true,
  supportsRecent: true,
  order: tool.order ?? UTIL_RECOMMENDED_ORDER[tool.id],
  automation: descriptor
    ? {
        contractVersion: "1.0",
        executionMode: descriptor.execution.mode === "worker" ? "worker" : "pure",
        surfaces: ["gui", "runtime-cli", "mcp"],
        actionId,
      }
    : undefined,
  });
});

/** 按 action ID 查找（支持完整 ID 如 builtin.utilities.base64 或短 ID 如 base64） */
export function findAction(actionId: string): ToolActionDefinition | undefined {
  const full = UTIL_ACTIONS.find((a) => a.id === actionId);
  if (full) return full;
  // 短 ID 回退
  return UTIL_ACTIONS.find((a) => a.id === `${PARENT_TOOL_ID}.${actionId}`);
}

/** 从 action ID 提取短 ID（去掉父级前缀） */
export function actionToShortId(actionId: string): string {
  return actionId.startsWith(`${PARENT_TOOL_ID}.`)
    ? actionId.slice(PARENT_TOOL_ID.length + 1)
    : actionId;
}

/** 从短 ID 构造完整 action ID */
export function shortIdToAction(shortId: string): string {
  return shortId.startsWith(`${PARENT_TOOL_ID}.`)
    ? shortId
    : `${PARENT_TOOL_ID}.${shortId}`;
}

/** 全局搜索：按 id / keywords / aliases 搜匹配的 actions */
export function searchActions(query: string): ToolActionDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return UTIL_ACTIONS;
  return UTIL_ACTIONS.filter(
    (a) =>
      a.id.includes(q) ||
      a.keywords.some((k) => k.toLowerCase().includes(q)) ||
      a.aliases.some((al) => al.toLowerCase().includes(q)),
  );
}

/** 按关键词/名称过滤（名称需调用方翻译后传入匹配器）。这里仅按 id + keywords + aliases 粗筛。 */
export function searchTools(query: string): UtilTool[] {
  const q = query.trim().toLowerCase();
  if (!q) return UTIL_TOOLS;
  return UTIL_TOOLS.filter(
    (tt) =>
      tt.id.includes(q) ||
      tt.keywords.some((k) => k.toLowerCase().includes(q)) ||
      (tt.aliases ?? []).some((al) => al.toLowerCase().includes(q)),
  );
}
