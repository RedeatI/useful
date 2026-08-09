// 第三批实用工具纯逻辑：换算/校验/数字/字符。全部无副作用、可测试。
import { parseHex } from "./transforms";

// ---------- 日期间隔 ----------

export interface Duration {
  totalSeconds: number;
  negative: boolean;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function durationBetween(a: string, b: string): Duration {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) throw new Error("无法解析的日期");
  const diff = tb - ta;
  const negative = diff < 0;
  let s = Math.floor(Math.abs(diff) / 1000);
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  s -= minutes * 60;
  return {
    totalSeconds: Math.floor(Math.abs(diff) / 1000),
    negative,
    days,
    hours,
    minutes,
    seconds: s,
  };
}

// ---------- Luhn 校验 ----------

/** Luhn 算法校验（信用卡等）。仅接受数字字符（可含空格/连字符，会被剔除）。 */
export function luhnValidate(input: string): boolean {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** 为不含校验位的数字串计算 Luhn 校验位（0-9）。 */
export function luhnCheckDigit(partial: string): number {
  const digits = partial.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) throw new Error("只能包含数字");
  let sum = 0;
  let alt = true; // 从最右（将成为校验位左侧）开始翻倍
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return (10 - (sum % 10)) % 10;
}

// ---------- WCAG 颜色对比度 ----------

function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error("非法 HEX 颜色");
  const srgb = [rgb.r, rgb.g, rgb.b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

export interface ContrastResult {
  ratio: number;
  aaNormal: boolean;
  aaLarge: boolean;
  aaaNormal: boolean;
  aaaLarge: boolean;
}

/** 计算两色对比度比值（1–21）与 WCAG 等级判定。 */
export function contrastRatio(fg: string, bg: string): ContrastResult {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const rawRatio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  const r = Math.round(rawRatio * 100) / 100;
  return {
    ratio: r,
    aaNormal: rawRatio >= 4.5,
    aaLarge: rawRatio >= 3,
    aaaNormal: rawRatio >= 7,
    aaaLarge: rawRatio >= 4.5,
  };
}

// ---------- 数字格式化 ----------

/** 千分位分组 + 固定小数位。非数字抛错。 */
function parseFormattedNumber(value: string): number {
  const normalized = value.trim();
  const valid = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!valid.test(normalized)) throw new Error("不是合法数字");
  const number = Number(normalized.replace(/,/g, ""));
  if (!Number.isFinite(number)) throw new Error("不是合法数字");
  return number;
}

export function formatNumber(value: string, decimals: number | null): string {
  const n = parseFormattedNumber(value);
  const opts: Intl.NumberFormatOptions = {};
  if (decimals !== null) {
    opts.minimumFractionDigits = decimals;
    opts.maximumFractionDigits = decimals;
  }
  return new Intl.NumberFormat("en-US", opts).format(n);
}

/** 科学计数法。 */
export function toScientific(value: string): string {
  const n = parseFormattedNumber(value);
  return n.toExponential();
}

// ---------- 凯撒 / ROT13 ----------

/** 凯撒位移（仅 A-Za-z，其余保持）。shift 可为负。 */
export function caesar(text: string, shift: number): string {
  const s = ((shift % 26) + 26) % 26;
  return text.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + s) % 26) + base);
  });
}

export function rot13(text: string): string {
  return caesar(text, 13);
}

// ---------- 单位换算 ----------

export type UnitKind = "length" | "weight" | "temperature";

const LENGTH_TO_M: Record<string, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  mi: 1609.344,
};
const WEIGHT_TO_G: Record<string, number> = {
  mg: 0.001,
  g: 1,
  kg: 1000,
  t: 1_000_000,
  oz: 28.349523125,
  lb: 453.59237,
};

export function convertUnit(
  kind: UnitKind,
  value: number,
  from: string,
  to: string,
): number {
  if (!isFinite(value)) throw new Error("请输入数值");
  if (kind === "temperature") {
    // 先转摄氏，再转目标
    let c: number;
    if (from === "C") c = value;
    else if (from === "F") c = (value - 32) / 1.8;
    else if (from === "K") c = value - 273.15;
    else throw new Error("未知温度单位");
    if (to === "C") return c;
    if (to === "F") return c * 1.8 + 32;
    if (to === "K") return c + 273.15;
    throw new Error("未知温度单位");
  }
  const table = kind === "length" ? LENGTH_TO_M : WEIGHT_TO_G;
  const f = table[from];
  const tt = table[to];
  if (f === undefined || tt === undefined) throw new Error("未知单位");
  return (value * f) / tt;
}

export const UNIT_OPTIONS: Record<UnitKind, string[]> = {
  length: Object.keys(LENGTH_TO_M),
  weight: Object.keys(WEIGHT_TO_G),
  temperature: ["C", "F", "K"],
};

// ---------- 随机数 ----------

/** 生成 count 个 [min, max] 闭区间的随机整数（crypto 安全，去偏置）。 */
export function randomInts(min: number, max: number, count: number): number[] {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  const n = Math.max(1, Math.min(1000, Math.floor(count)));
  const range = hi - lo + 1;
  if (range <= 0) throw new Error("区间非法");
  const out: number[] = [];
  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  for (let i = 0; i < n; i++) {
    let v: number;
    do {
      crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    out.push(lo + (v % range));
  }
  return out;
}

// ---------- Unicode 转义 ----------

/** 文本 → \uXXXX 转义（非 ASCII 或全部，按 asciiOnly）。 */
export function unicodeEscape(text: string, asciiOnly = true): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (asciiOnly && cp < 128) {
      out += ch;
    } else if (cp > 0xffff) {
      // 代理对
      const h = ch.charCodeAt(0);
      const l = ch.charCodeAt(1);
      out += `\\u${h.toString(16).padStart(4, "0")}\\u${l
        .toString(16)
        .padStart(4, "0")}`;
    } else {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

export function unicodeUnescape(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}
