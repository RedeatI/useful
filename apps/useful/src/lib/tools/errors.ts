import { t } from "@/i18n";

const EXACT_ERRORS: Record<string, string> = {
  "无法解析的日期": "toolErrors.dateParse",
  "只能包含数字": "toolErrors.digitsOnly",
  "非法 HEX 颜色": "toolErrors.invalidHex",
  "不是合法数字": "toolErrors.invalidNumber",
  "请输入数值": "toolErrors.numberRequired",
  "未知温度单位": "toolErrors.unknownTemperatureUnit",
  "未知单位": "toolErrors.unknownUnit",
  "区间非法": "toolErrors.invalidRange",
  "十六进制长度必须为偶数": "toolErrors.hexEvenLength",
  "包含非十六进制字符": "toolErrors.nonHexCharacter",
  "请输入非负数值": "toolErrors.nonNegativeNumber",
  "不是合法的 URL 编码": "toolErrors.invalidUrlEncoding",
  "非法时间戳": "toolErrors.invalidTimestamp",
  "JWT 必须为三段（header.payload.signature）": "toolErrors.jwtThreeSegments",
  "JWT 段不是合法的 Base64URL/JSON": "toolErrors.jwtInvalidSegment",
  "至少选择一种字符集": "toolErrors.chooseCharacterSet",
  "Worker 发生内部错误": "toolErrors.workerInternal",
  "已取消": "toolErrors.cancelled",
  "插件消息超过大小限制": "toolErrors.pluginMessageTooLarge",
  "请求超时": "toolErrors.requestTimeout",
};

type Matcher = {
  pattern: RegExp;
  key: string;
  params: (match: RegExpExecArray) => Record<string, string | number>;
};

const MATCHERS: Matcher[] = [
  { pattern: /^正则非法:\s*(.*)$/s, key: "toolErrors.invalidRegex", params: (m) => ({ details: m[1] }) },
  { pattern: /^不是合法的 (\d+) 进制数$/, key: "toolErrors.invalidBaseNumber", params: (m) => ({ base: m[1] }) },
  { pattern: /^文件过大（([\d.]+) MB），上限 ([\d.]+) MB。$/, key: "toolErrors.fileTooLarge", params: (m) => ({ actual: m[1], max: m[2] }) },
  { pattern: /^正则执行超时（(\d+)ms），可能存在高复杂度表达式（ReDoS 风险）$/, key: "toolErrors.regexTimeout", params: (m) => ({ timeout: m[1] }) },
  { pattern: /^输入文本过大（(\d+) 字符），上限 (\d+)。请缩短输入或使用文件模式。$/, key: "toolErrors.regexTextTooLarge", params: (m) => ({ actual: m[1], max: m[2] }) },
  { pattern: /^正则表达式过长（(\d+) 字符），上限 (\d+)。$/, key: "toolErrors.regexPatternTooLong", params: (m) => ({ actual: m[1], max: m[2] }) },
  { pattern: /^匹配数超过上限 (\d+)，请缩小输入或优化正则$/, key: "toolErrors.regexTooManyMatches", params: (m) => ({ max: m[1] }) },
  { pattern: /^方法未被允许: (.+)$/s, key: "toolErrors.pluginMethodForbidden", params: (m) => ({ method: m[1] }) },
  { pattern: /^未知操作: (.+)$/s, key: "toolErrors.unknownOperation", params: (m) => ({ operation: m[1] }) },
];

export function toolErrorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? "");
  const exact = EXACT_ERRORS[raw];
  if (exact) return t(exact);
  for (const matcher of MATCHERS) {
    const match = matcher.pattern.exec(raw);
    if (match) return t(matcher.key, matcher.params(match));
  }
  return raw;
}
