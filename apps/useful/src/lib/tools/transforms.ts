// 实用工具纯逻辑：全部为无副作用、可测试的纯函数（除 hash 走 Web Crypto）。
// 设计原则：每个函数只做一件事、对非法输入返回明确错误、绝不抛未捕获异常给 UI。
import { runBase64Action, runJsonAction } from "@useful/action-runtime/browser";

// ---------- Base64 ----------

/** UTF-8 文本 → Base64。 */
export function base64Encode(text: string): string {
  return runBase64Action({ operation: "encode", text }).text;
}

/** Base64 → UTF-8 文本。非法输入抛出可读错误。 */
export function base64Decode(b64: string): string {
  return runBase64Action({ operation: "decode", text: b64 }).text;
}

// ---------- URL 编解码 ----------

export function urlEncode(text: string): string {
  return encodeURIComponent(text);
}

export function urlDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    throw new Error("不是合法的 URL 编码");
  }
}

// ---------- JSON ----------

/** 格式化 JSON（缩进 indent）。解析失败抛出带位置的错误。 */
export function jsonFormat(input: string, indent = 2): string {
  return runJsonAction({ operation: "format", text: input, indent }).text;
}

/** 压缩 JSON（去除所有空白）。 */
export function jsonMinify(input: string): string {
  return runJsonAction({ operation: "minify", text: input }).text;
}

// ---------- UUID ----------

/** 生成 1 个 v4 UUID（优先 crypto.randomUUID，回退到 getRandomValues）。 */
export function uuidV4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/** 批量生成 n 个 UUID（上限 1000，防止 UI 卡死）。 */
export function uuidBatch(n: number): string[] {
  const count = Math.max(1, Math.min(1000, Math.floor(n)));
  return Array.from({ length: count }, () => uuidV4());
}

// ---------- 时间戳 ----------

export interface TimeParts {
  unixSeconds: number;
  unixMillis: number;
  iso: string;
  utc: string;
  local: string;
}

/** 从 Unix 秒/毫秒构造多种表示。自动识别秒或毫秒（>= 1e12 视为毫秒）。 */
export function fromUnix(value: number): TimeParts {
  const ms = value >= 1e12 ? value : value * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new Error("非法时间戳");
  return {
    unixSeconds: Math.floor(ms / 1000),
    unixMillis: ms,
    iso: d.toISOString(),
    utc: d.toUTCString(),
    local: d.toLocaleString(),
  };
}

/** 从日期字符串解析为 Unix 时间。 */
export function fromDateString(s: string): TimeParts {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error("无法解析的日期");
  return fromUnix(d.getTime());
}

// ---------- 正则 ----------

export interface RegexMatch {
  index: number;
  match: string;
  groups: string[];
}

/** 运行正则，返回全部匹配与分组。flags 非法或正则非法时抛出可读错误。 */
export function regexTest(
  pattern: string,
  flags: string,
  text: string,
): RegexMatch[] {
  let re: RegExp;
  const withGlobal = flags.includes("g") ? flags : flags + "g";
  try {
    re = new RegExp(pattern, withGlobal);
  } catch (e) {
    throw new Error(`正则非法: ${(e as Error).message}`);
  }
  const out: RegexMatch[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    out.push({ index: m.index, match: m[0], groups: m.slice(1) });
    if (m.index === re.lastIndex) re.lastIndex++; // 防零宽匹配死循环
    if (++guard > 100000) break;
  }
  return out;
}

/** 正则替换。 */
export function regexReplace(
  pattern: string,
  flags: string,
  text: string,
  replacement: string,
): string {
  try {
    return text.replace(new RegExp(pattern, flags), replacement);
  } catch (e) {
    throw new Error(`正则非法: ${(e as Error).message}`);
  }
}

// ---------- JWT 解码（仅解码，不验签） ----------

export interface JwtParts {
  header: unknown;
  payload: unknown;
  signature: string;
}

function b64urlToJson(seg: string): unknown {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** 解码 JWT（不验证签名——UI 必须显著提示）。 */
export function jwtDecode(token: string): JwtParts {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error("JWT 必须为三段（header.payload.signature）");
  try {
    return {
      header: b64urlToJson(parts[0]),
      payload: b64urlToJson(parts[1]),
      signature: parts[2],
    };
  } catch {
    throw new Error("JWT 段不是合法的 Base64URL/JSON");
  }
}

// ---------- 大小写 / 命名转换 ----------

/** 拆分为单词序列（支持 camelCase / snake_case / kebab-case / 空格）。 */
export function splitWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export type CaseStyle =
  | "camel"
  | "pascal"
  | "snake"
  | "kebab"
  | "constant"
  | "title";

export function convertCase(input: string, style: CaseStyle): string {
  const words = splitWords(input);
  if (words.length === 0) return "";
  const lower = words.map((w) => w.toLowerCase());
  switch (style) {
    case "camel":
      return lower
        .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
        .join("");
    case "pascal":
      return lower.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
    case "snake":
      return lower.join("_");
    case "kebab":
      return lower.join("-");
    case "constant":
      return lower.join("_").toUpperCase();
    case "title":
      return lower.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  }
}

// ---------- 颜色转换 ----------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 解析 #RGB / #RRGGBB → RGB（0-255）。非法返回 null。 */
export function parseHex(hex: string): Rgb | null {
  const h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  return null;
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** RGB → HSL（h:0-360, s/l:0-100）。 */
export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
    }
    h /= 6;
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

// ---------- 密码生成 ----------

export interface PasswordOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  /** 排除易混淆字符（0O1lI| 等） */
  excludeAmbiguous?: boolean;
}

// 易混淆字符集
const AMBIGUOUS_CHARS = "0O1lI|`'";

/** 计算密码的近似熵（bit）。仅估算，不得宣称绝对安全。 */
export function estimateEntropy(opts: PasswordOptions): number {
  let poolSize = 0;
  if (opts.lower) poolSize += 26;
  if (opts.upper) poolSize += 26;
  if (opts.digits) poolSize += 10;
  if (opts.symbols) poolSize += 23;
  if (opts.excludeAmbiguous) poolSize -= AMBIGUOUS_CHARS.length;
  if (poolSize <= 0) return 0;
  const len = Math.max(4, Math.min(256, Math.floor(opts.length)));
  return Math.round(len * Math.log2(poolSize));
}

/** 生成随机密码（crypto.getRandomValues CSPRNG，避免取模偏置）。 */
export function generatePassword(opts: PasswordOptions): string {
  const sets: string[] = [];
  if (opts.lower) sets.push("abcdefghijklmnopqrstuvwxyz");
  if (opts.upper) sets.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  if (opts.digits) sets.push("0123456789");
  if (opts.symbols) sets.push("!@#$%^&*()-_=+[]{};:,.<>?");
  // 排除易混淆字符
  if (opts.excludeAmbiguous) {
    for (let i = 0; i < sets.length; i++) {
      sets[i] = [...sets[i]].filter((c) => !AMBIGUOUS_CHARS.includes(c)).join("");
    }
  }
  const pool = sets.join("");
  if (pool.length === 0) throw new Error("至少选择一种字符集");
  const len = Math.max(4, Math.min(256, Math.floor(opts.length)));

  const pick = (chars: string): string => {
    // 拒绝采样消除取模偏置
    const max = Math.floor(256 / chars.length) * chars.length;
    const buf = new Uint8Array(1);
    let v: number;
    do {
      crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= max);
    return chars[v % chars.length];
  };

  const out: string[] = [];
  // 保证每个选中的字符集至少出现一次
  for (const s of sets) out.push(pick(s));
  for (let i = out.length; i < len; i++) out.push(pick(pool));
  // Fisher-Yates 洗牌（避免前几位固定为各字符集）
  for (let i = out.length - 1; i > 0; i--) {
    const buf = new Uint8Array(1);
    let j: number;
    const max = Math.floor(256 / (i + 1)) * (i + 1);
    do {
      crypto.getRandomValues(buf);
      j = buf[0];
    } while (j >= max);
    j %= i + 1;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

// ---------- 进制转换 ----------

/** 在 2/8/10/16 进制间转换。非法输入抛错。 */
export function convertBase(value: string, fromBase: number, toBase: number): string {
  const cleaned = value.trim().toLowerCase().replace(/^0x/, "");
  if (cleaned === "") throw new Error("请输入数值");
  const n = parseInt(cleaned, fromBase);
  if (Number.isNaN(n) || !isFinite(n)) {
    throw new Error(`不是合法的 ${fromBase} 进制数`);
  }
  // 严格校验：parseInt 会容忍非法尾字符（如 "1z" → 1）。
  // 反编码后与去除前导零的输入比较，不一致则拒绝。
  const strippedInput = cleaned.replace(/^0+(?=.)/, "");
  if (n.toString(fromBase) !== strippedInput) {
    throw new Error(`不是合法的 ${fromBase} 进制数`);
  }
  return n.toString(toBase);
}
