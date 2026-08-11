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

export const UTIL_CATEGORIES: { key: UtilCategory; labelKey: string }[] = [
  { key: "encode", labelKey: "util.cat.encode" },
  { key: "convert", labelKey: "util.cat.convert" },
  { key: "text", labelKey: "util.cat.text" },
  { key: "generate", labelKey: "util.cat.generate" },
  { key: "web", labelKey: "util.cat.web" },
];

export const UTIL_TOOLS: UtilTool[] = [
  {
    id: "json",
    nameKey: "util.json.name",
    descKey: "util.json.desc",
    icon: "braces",
    category: "convert",
    keywords: ["json", "格式化", "美化", "压缩", "校验", "format"],
    aliases: ["pretty", "beautify", "minify"],
    component: lazy(() => import("@/views/tools/util/JsonTool.vue")),
    expectedInputSize: "large",
    automation: { contractVersion: "1.0", executionMode: "pure", surfaces: ["gui", "runtime-cli"] },
  },
  {
    id: "base64",
    nameKey: "util.base64.name",
    descKey: "util.base64.desc",
    icon: "code",
    category: "encode",
    keywords: ["base64", "编码", "解码", "encode", "decode"],
    aliases: ["b64", "atob", "btoa"],
    component: lazy(() => import("@/views/tools/util/Base64Tool.vue")),
    expectedInputSize: "large",
    automation: { contractVersion: "1.0", executionMode: "pure", surfaces: ["gui", "runtime-cli"] },
  },
  {
    id: "hash",
    nameKey: "util.hash.name",
    descKey: "util.hash.desc",
    icon: "fingerprint",
    category: "encode",
    keywords: ["hash", "哈希", "sha", "sha256", "摘要", "digest"],
    aliases: ["sha1", "sha384", "sha512", "checksum", "校验和"],
    component: lazy(() => import("@/views/tools/util/HashTool.vue")),
    expectedInputSize: "large",
    automation: { contractVersion: "1.0", executionMode: "pure", surfaces: ["gui", "runtime-cli"] },
  },
  {
    id: "url",
    nameKey: "util.url.name",
    descKey: "util.url.desc",
    icon: "link",
    category: "encode",
    keywords: ["url", "编码", "解码", "percent", "转义"],
    component: lazy(() => import("@/views/tools/util/UrlTool.vue")),
  },
  {
    id: "uuid",
    nameKey: "util.uuid.name",
    descKey: "util.uuid.desc",
    icon: "hash",
    category: "generate",
    keywords: ["uuid", "guid", "唯一", "标识", "生成"],
    aliases: ["v4", "guid", "唯一id"],
    component: lazy(() => import("@/views/tools/util/UuidTool.vue")),
  },
  {
    id: "password",
    nameKey: "util.password.name",
    descKey: "util.password.desc",
    icon: "key",
    category: "generate",
    keywords: ["password", "密码", "随机", "生成", "口令"],
    aliases: ["pwd", "pass", "secret"],
    component: lazy(() => import("@/views/tools/util/PasswordTool.vue")),
    sensitiveInput: true,
  },
  {
    id: "timestamp",
    nameKey: "util.timestamp.name",
    descKey: "util.timestamp.desc",
    icon: "clock",
    category: "convert",
    keywords: ["timestamp", "时间戳", "unix", "日期", "时间"],
    aliases: ["epoch", "date", "datetime"],
    component: lazy(() => import("@/views/tools/util/TimestampTool.vue")),
  },
  {
    id: "base-convert",
    nameKey: "util.baseConvert.name",
    descKey: "util.baseConvert.desc",
    icon: "binary",
    category: "convert",
    keywords: ["进制", "二进制", "十六进制", "binary", "hex", "base"],
    aliases: ["bin", "oct", "decimal"],
    component: lazy(() => import("@/views/tools/util/BaseConvertTool.vue")),
  },
  {
    id: "color",
    nameKey: "util.color.name",
    descKey: "util.color.desc",
    icon: "palette",
    category: "convert",
    keywords: ["color", "颜色", "hex", "rgb", "hsl", "调色"],
    aliases: ["colour", "picker"],
    component: lazy(() => import("@/views/tools/util/ColorTool.vue")),
  },
  {
    id: "case",
    nameKey: "util.case.name",
    descKey: "util.case.desc",
    icon: "type",
    category: "text",
    keywords: ["case", "命名", "驼峰", "下划线", "camel", "snake"],
    component: lazy(() => import("@/views/tools/util/CaseTool.vue")),
  },
  {
    id: "regex",
    nameKey: "util.regex.name",
    descKey: "util.regex.desc",
    icon: "regex",
    category: "text",
    keywords: ["regex", "正则", "匹配", "替换", "regexp"],
    aliases: ["regular expression", "pattern"],
    component: lazy(() => import("@/views/tools/util/RegexTool.vue")),
    expectedInputSize: "large",
  },
  {
    id: "jwt",
    nameKey: "util.jwt.name",
    descKey: "util.jwt.desc",
    icon: "shield",
    category: "web",
    keywords: ["jwt", "token", "解码", "令牌", "decode"],
    aliases: ["json web token", "bearer"],
    component: lazy(() => import("@/views/tools/util/JwtTool.vue")),
    sensitiveInput: true,
  },
  {
    id: "html",
    nameKey: "util.html.name",
    descKey: "util.html.desc",
    icon: "code",
    category: "encode",
    keywords: ["html", "实体", "转义", "entity", "escape", "去标签"],
    component: lazy(() => import("@/views/tools/util/HtmlEntitiesTool.vue")),
  },
  {
    id: "hex-text",
    nameKey: "util.hexText.name",
    descKey: "util.hexText.desc",
    icon: "binary",
    category: "encode",
    keywords: ["hex", "十六进制", "文本", "bytes", "字节"],
    component: lazy(() => import("@/views/tools/util/HexTextTool.vue")),
  },
  {
    id: "morse",
    nameKey: "util.morse.name",
    descKey: "util.morse.desc",
    icon: "wand",
    category: "encode",
    keywords: ["morse", "摩尔斯", "电码", "点划"],
    component: lazy(() => import("@/views/tools/util/MorseTool.vue")),
  },
  {
    id: "text-stats",
    nameKey: "util.textStats.name",
    descKey: "util.textStats.desc",
    icon: "type",
    category: "text",
    keywords: ["字数", "统计", "字符", "行数", "count", "words"],
    component: lazy(() => import("@/views/tools/util/TextStatsTool.vue")),
  },
  {
    id: "text-lines",
    nameKey: "util.textLines.name",
    descKey: "util.textLines.desc",
    icon: "menu",
    category: "text",
    keywords: ["行", "排序", "去重", "去空", "sort", "dedupe", "lines"],
    component: lazy(() => import("@/views/tools/util/TextLinesTool.vue")),
  },
  {
    id: "slug",
    nameKey: "util.slug.name",
    descKey: "util.slug.desc",
    icon: "link",
    category: "text",
    keywords: ["slug", "url", "固定链接", "短名"],
    component: lazy(() => import("@/views/tools/util/SlugTool.vue")),
  },
  {
    id: "byte-size",
    nameKey: "util.byteSize.name",
    descKey: "util.byteSize.desc",
    icon: "binary",
    category: "convert",
    keywords: ["字节", "byte", "kb", "mb", "gb", "大小", "size"],
    component: lazy(() => import("@/views/tools/util/ByteSizeTool.vue")),
  },
  {
    id: "lorem",
    nameKey: "util.lorem.name",
    descKey: "util.lorem.desc",
    icon: "type",
    category: "generate",
    keywords: ["lorem", "ipsum", "占位", "假文", "placeholder"],
    component: lazy(() => import("@/views/tools/util/LoremTool.vue")),
  },
  {
    id: "duration",
    nameKey: "util.duration.name",
    descKey: "util.duration.desc",
    icon: "clock",
    category: "convert",
    keywords: ["日期", "间隔", "duration", "相差", "时长"],
    component: lazy(() => import("@/views/tools/util/DurationTool.vue")),
  },
  {
    id: "byte-unit",
    nameKey: "util.unit.name",
    descKey: "util.unit.desc",
    icon: "wrench",
    category: "convert",
    keywords: ["单位", "换算", "长度", "重量", "温度", "unit", "convert"],
    component: lazy(() => import("@/views/tools/util/UnitConvertTool.vue")),
  },
  {
    id: "number-format",
    nameKey: "util.numberFormat.name",
    descKey: "util.numberFormat.desc",
    icon: "hash",
    category: "convert",
    keywords: ["数字", "千分位", "格式化", "number", "format"],
    component: lazy(() => import("@/views/tools/util/NumberFormatTool.vue")),
  },
  {
    id: "unicode",
    nameKey: "util.unicode.name",
    descKey: "util.unicode.desc",
    icon: "type",
    category: "encode",
    keywords: ["unicode", "\\u", "转义", "escape", "码位"],
    component: lazy(() => import("@/views/tools/util/UnicodeTool.vue")),
  },
  {
    id: "caesar",
    nameKey: "util.caesar.name",
    descKey: "util.caesar.desc",
    icon: "wand",
    category: "text",
    keywords: ["凯撒", "caesar", "rot13", "位移", "cipher"],
    component: lazy(() => import("@/views/tools/util/CaesarTool.vue")),
  },
  {
    id: "luhn",
    nameKey: "util.luhn.name",
    descKey: "util.luhn.desc",
    icon: "fingerprint",
    category: "web",
    keywords: ["luhn", "信用卡", "银行卡", "校验", "校验位", "checksum"],
    aliases: ["card", "credit card"],
    component: lazy(() => import("@/views/tools/util/LuhnTool.vue")),
  },
  {
    id: "contrast",
    nameKey: "util.contrast.name",
    descKey: "util.contrast.desc",
    icon: "palette",
    category: "web",
    keywords: ["对比度", "wcag", "contrast", "无障碍", "a11y"],
    component: lazy(() => import("@/views/tools/util/ContrastTool.vue")),
  },
  {
    id: "random-number",
    nameKey: "util.random.name",
    descKey: "util.random.desc",
    icon: "binary",
    category: "generate",
    keywords: ["随机", "random", "骰子", "数字", "number"],
    component: lazy(() => import("@/views/tools/util/RandomNumberTool.vue")),
  },
  {
    id: "data-format",
    nameKey: "util.dataFormat.name",
    descKey: "util.dataFormat.desc",
    icon: "braces",
    category: "convert",
    keywords: ["json", "yaml", "yml", "格式", "转换", "format"],
    aliases: ["json yaml", "yaml json"],
    component: lazy(() => import("@/views/tools/util/DataFormatTool.vue")),
    expectedInputSize: "large",
  },
  {
    id: "text-diff",
    nameKey: "util.textDiff.name",
    descKey: "util.textDiff.desc",
    icon: "menu",
    category: "text",
    keywords: ["diff", "文本", "比较", "差异", "行"],
    aliases: ["compare", "patch"],
    component: lazy(() => import("@/views/tools/util/TextDiffTool.vue")),
    expectedInputSize: "large",
  },
  {
    id: "ipv4",
    nameKey: "util.ipv4.name",
    descKey: "util.ipv4.desc",
    icon: "link",
    category: "web",
    keywords: ["ipv4", "cidr", "ip", "子网", "网段", "地址"],
    aliases: ["subnet", "network"],
    component: lazy(() => import("@/views/tools/util/Ipv4Tool.vue")),
  },
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
