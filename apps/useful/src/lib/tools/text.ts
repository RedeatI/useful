// 第二批实用工具的纯逻辑：文本/编码/换算类。全部无副作用、可测试。

// ---------- HTML 实体 ----------

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const HTML_UNESCAPE: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function htmlEncode(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

export function htmlDecode(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => HTML_UNESCAPE[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripTagLikeSegments(text: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start < 0) return result + text.slice(cursor);
    const end = text.indexOf(">", start + 1);
    if (end < 0) return result + text.slice(cursor);
    result += text.slice(cursor, start);
    cursor = end + 1;
  }
  return result;
}

/** 去除所有 HTML 标签，保留文本（折叠空白）。 */
export function stripHtmlTags(html: string): string {
  return stripTagLikeSegments(htmlDecode(html)).replace(/\s+/g, " ").trim();
}

// ---------- 十六进制 ↔ 文本 ----------

export function textToHex(text: string, sep = " "): string {
  const bytes = new TextEncoder().encode(text);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(sep);
}

export function hexToText(hex: string): string {
  const cleaned = hex.replace(/0x/gi, "").replace(/[\s,]+/g, "");
  if (cleaned === "") return "";
  if (cleaned.length % 2 !== 0) throw new Error("十六进制长度必须为偶数");
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error("包含非十六进制字符");
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// ---------- 文本统计 ----------

export interface TextStats {
  chars: number;
  charsNoSpaces: number;
  words: number;
  lines: number;
  bytes: number;
}

export function textStats(text: string): TextStats {
  return {
    chars: [...text].length,
    charsNoSpaces: [...text.replace(/\s/g, "")].length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    lines: text === "" ? 0 : text.split(/\r\n|\r|\n/).length,
    bytes: new TextEncoder().encode(text).length,
  };
}

// ---------- 行处理 ----------

export interface LineOps {
  trim: boolean;
  dropEmpty: boolean;
  dedupe: boolean;
  sort: "none" | "asc" | "desc";
  reverse: boolean;
}

export function processLines(text: string, ops: LineOps): string {
  let lines = text.split(/\r\n|\r|\n/);
  if (ops.trim) lines = lines.map((l) => l.trim());
  if (ops.dropEmpty) lines = lines.filter((l) => l !== "");
  if (ops.dedupe) lines = [...new Set(lines)];
  const compareCodePoints = (left: string, right: string): number => {
    const a = Array.from(left);
    const b = Array.from(right);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
      if (difference !== 0) return difference;
    }
    return a.length - b.length;
  };
  if (ops.sort === "asc") lines.sort(compareCodePoints);
  else if (ops.sort === "desc") lines.sort((a, b) => compareCodePoints(b, a));
  if (ops.reverse) lines.reverse();
  return lines.join("\n");
}

// ---------- Slug ----------

/** 生成 URL slug（ASCII 字母数字 + 连字符）。中文等非 ASCII 被去除。 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_]+/g, "-") // 空白与下划线先转为连字符（先于剔除）
    .replace(/[^a-z0-9-]/g, "") // 再剔除其余非 ASCII 字母数字
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------- 摩尔斯电码 ----------

const MORSE: Record<string, string> = {
  a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.",
  h: "....", i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.",
  o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-", u: "..-",
  v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
  "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "!": "-.-.--", "/": "-..-.",
  "@": ".--.-.", "-": "-....-", "(": "-.--.", ")": "-.--.-",
};
const MORSE_REV: Record<string, string> = Object.fromEntries(
  Object.entries(MORSE).map(([k, v]) => [v, k]),
);

export function toMorse(text: string): string {
  const characters = [...text.toLowerCase()];
  if (characters.some((character) => character !== " " && !Object.prototype.hasOwnProperty.call(MORSE, character))) {
    throw new Error("包含不支持的 Morse 字符");
  }
  return characters.map((character) => character === " " ? "/" : MORSE[character]).join(" ");
}

export function fromMorse(code: string): string {
  if (code === "") return "";
  const symbols = code.trim().split(/\s+/);
  if (symbols.some((symbol) => symbol !== "/" && !Object.prototype.hasOwnProperty.call(MORSE_REV, symbol))) {
    throw new Error("包含不支持的 Morse 符号");
  }
  return symbols.map((symbol) => symbol === "/" ? " " : MORSE_REV[symbol]).join("");
}

// ---------- 字节大小换算 ----------

/** 人类可读字节大小（二进制单位 KiB/MiB…）。 */
export function humanizeBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes < 0) throw new Error("请输入非负数值");
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const rounded = i === 0 ? v : Math.round(v * 100) / 100;
  return `${rounded} ${units[i]}`;
}

/** 各单位下的数值明细（十进制与二进制）。 */
export function byteBreakdown(bytes: number): { unit: string; value: string }[] {
  if (!isFinite(bytes) || bytes < 0) throw new Error("请输入非负数值");
  const bin = [
    { unit: "B", div: 1 },
    { unit: "KiB", div: 1024 },
    { unit: "MiB", div: 1024 ** 2 },
    { unit: "GiB", div: 1024 ** 3 },
  ];
  return bin.map(({ unit, div }) => ({
    unit,
    value: (Math.round((bytes / div) * 1e6) / 1e6).toString(),
  }));
}

// ---------- Lorem Ipsum ----------

const LOREM_WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(
    " ",
  );

/** 生成指定段数的 Lorem Ipsum（每段 sentences 句，每句若干词）。 */
export function loremIpsum(paragraphs: number, sentencesPer = 4): string {
  const p = Math.max(1, Math.min(50, Math.floor(paragraphs)));
  const out: string[] = [];
  let seed = 1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < p; i++) {
    const sentences: string[] = [];
    for (let s = 0; s < sentencesPer; s++) {
      const len = 6 + Math.floor(rnd() * 8);
      const words: string[] = [];
      for (let w = 0; w < len; w++) {
        words.push(LOREM_WORDS[Math.floor(rnd() * LOREM_WORDS.length)]);
      }
      const sentence = words.join(" ");
      sentences.push(sentence[0].toUpperCase() + sentence.slice(1) + ".");
    }
    out.push(sentences.join(" "));
  }
  return out.join("\n\n");
}
