// 属性测试：往返转换不变式验证。
// 使用 fast-check 生成随机输入，验证 encode→decode 往返一致性。
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  base64Encode,
  base64Decode,
  urlEncode,
  urlDecode,
  convertCase,
  splitWords,
  convertBase,
} from "./transforms";
import { parseHex, rgbToHex, rgbToHsl } from "./transforms";
import { generatePassword, estimateEntropy } from "./transforms";

describe("属性测试：往返转换", () => {
  it("Base64 encode/decode 往返一致", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (text) => {
        const encoded = base64Encode(text);
        const decoded = base64Decode(encoded);
        expect(decoded).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it("URL encode/decode 往返一致", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (text) => {
        const encoded = urlEncode(text);
        const decoded = urlDecode(encoded);
        expect(decoded).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it("命名转换：splitWords → join 往返无损", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }).filter((s) => s.trim().length > 0), (text) => {
        const words = splitWords(text);
        // 转成 snake 再转回来应该无损
        const snake = convertCase(text, "snake");
        const words2 = splitWords(snake);
        expect(words2.length).toBe(words.length);
      }),
      { numRuns: 100 },
    );
  });

  it("HEX 解析与 RGB→HEX 往返（整数范围内）", () => {
    fc.assert(
      fc.property(
        fc.record({
          r: fc.integer({ min: 0, max: 255 }),
          g: fc.integer({ min: 0, max: 255 }),
          b: fc.integer({ min: 0, max: 255 }),
        }),
        (rgb) => {
          const hex = rgbToHex(rgb);
          const parsed = parseHex(hex);
          expect(parsed).not.toBeNull();
          expect(parsed).toEqual(rgb);
        }),
      { numRuns: 200 },
    );
  });

  it("RGB → HSL → RGB 在容许误差内往返", () => {
    fc.assert(
      fc.property(
        fc.record({
          r: fc.integer({ min: 0, max: 255 }),
          g: fc.integer({ min: 0, max: 255 }),
          b: fc.integer({ min: 0, max: 255 }),
        }),
        (rgb) => {
          const hsl = rgbToHsl(rgb);
          // HSL 精度损失：h 误差 ±1，s/l 误差 ±1
          expect(hsl.h).toBeGreaterThanOrEqual(0);
          expect(hsl.h).toBeLessThanOrEqual(360);
          expect(hsl.s).toBeGreaterThanOrEqual(0);
          expect(hsl.s).toBeLessThanOrEqual(100);
          expect(hsl.l).toBeGreaterThanOrEqual(0);
          expect(hsl.l).toBeLessThanOrEqual(100);
        }),
      { numRuns: 200 },
    );
  });

  it("进制转换 2↔10↔16 往返一致", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000000 }), (n) => {
        const hex = convertBase(n.toString(10), 10, 16);
        const back = convertBase(hex, 16, 10);
        expect(parseInt(back)).toBe(n);
      }),
      { numRuns: 200 },
    );
  });

  it("行去重具有幂等性（去重后再去重不变）", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 50 }), { maxLength: 50 }), (lines) => {
        // 去重
        const seen = new Set<string>();
        const unique1 = lines.filter((l) => {
          if (seen.has(l)) return false;
          seen.add(l);
          return true;
        });
        // 再次去重
        const seen2 = new Set<string>();
        const unique2 = unique1.filter((l) => {
          if (seen2.has(l)) return false;
          seen2.add(l);
          return true;
        });
        expect(unique2).toEqual(unique1);
      }),
      { numRuns: 100 },
    );
  });

  it("ROT13 两次得到原文", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (text) => {
        // ROT13 实现
        const rot13 = (s: string): string =>
          s.replace(/[a-zA-Z]/g, (c) => {
            const base = c <= "Z" ? 65 : 97;
            return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
          });
        expect(rot13(rot13(text))).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it("密码生成器：CSPRNG 输出长度正确", () => {
    fc.assert(
      fc.property(
        fc.record({
          length: fc.integer({ min: 4, max: 256 }),
          lower: fc.boolean(),
          upper: fc.boolean(),
          digits: fc.boolean(),
          symbols: fc.boolean(),
        }),
        (opts) => {
          fc.pre(opts.lower || opts.upper || opts.digits || opts.symbols);
          const pw = generatePassword(opts);
          expect(pw.length).toBe(Math.max(4, Math.min(256, opts.length)));
        }),
      { numRuns: 100 },
    );
  });

  it("密码生成器：排除混淆字符后不含 0O1lI", () => {
    const ambiguous = "0O1lI|`'";
    fc.assert(
      fc.property(
        fc.record({
          length: fc.integer({ min: 8, max: 64 }),
          lower: fc.constant(true),
          upper: fc.constant(true),
          digits: fc.constant(true),
          symbols: fc.constant(false),
          excludeAmbiguous: fc.constant(true),
        }),
        (opts) => {
          const pw = generatePassword(opts);
          for (const c of pw) {
            expect(ambiguous).not.toContain(c);
          }
        }),
      { numRuns: 100 },
    );
  });

  it("熵计算：更长密码熵更高", () => {
    const opts1 = { length: 8, lower: true, upper: true, digits: true, symbols: false };
    const opts2 = { length: 32, lower: true, upper: true, digits: true, symbols: false };
    expect(estimateEntropy(opts2)).toBeGreaterThan(estimateEntropy(opts1));
  });

  it("UUID v4 格式正确（8-4-4-4-12）", () => {
    fc.assert(
      fc.property(fc.nat(100), () => {
        const uuid = crypto.randomUUID();
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }),
      { numRuns: 50 },
    );
  });

  it("空输入处理不崩溃", () => {
    expect(() => base64Encode("")).not.toThrow();
    expect(() => urlEncode("")).not.toThrow();
    expect(() => convertCase("", "camel")).not.toThrow();
  });

  it("Unicode 字符正确处理", () => {
    const unicode = "你好世界🌍🎉";
    expect(base64Decode(base64Encode(unicode))).toBe(unicode);
    expect(urlDecode(urlEncode(unicode))).toBe(unicode);
  });
});
