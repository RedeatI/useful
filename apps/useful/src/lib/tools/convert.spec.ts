import { describe, it, expect } from "vitest";
import {
  durationBetween,
  luhnValidate,
  luhnCheckDigit,
  contrastRatio,
  formatNumber,
  toScientific,
  caesar,
  rot13,
  convertUnit,
  randomInts,
  unicodeEscape,
  unicodeUnescape,
} from "@/lib/tools/convert";

describe("日期间隔", () => {
  it("计算天/时/分/秒", () => {
    const d = durationBetween("2026-01-01T00:00:00Z", "2026-01-02T01:02:03Z");
    expect(d).toMatchObject({ days: 1, hours: 1, minutes: 2, seconds: 3, negative: false });
  });
  it("负向", () => {
    expect(durationBetween("2026-01-02", "2026-01-01").negative).toBe(true);
  });
  it("非法日期抛错", () => {
    expect(() => durationBetween("x", "2026-01-01")).toThrow();
  });
});

describe("Luhn", () => {
  it("已知有效卡号", () => {
    expect(luhnValidate("4539 1488 0343 6467")).toBe(true);
    expect(luhnValidate("79927398713")).toBe(true);
  });
  it("无效", () => {
    expect(luhnValidate("1234 5678 9012 3456")).toBe(false);
    expect(luhnValidate("abc")).toBe(false);
  });
  it("校验位计算后整体有效", () => {
    const partial = "7992739871";
    const cd = luhnCheckDigit(partial);
    expect(cd).toBe(3);
    expect(luhnValidate(partial + cd)).toBe(true);
  });
});

describe("WCAG 对比度", () => {
  it("黑白最大对比 21", () => {
    const r = contrastRatio("#000000", "#ffffff");
    expect(r.ratio).toBe(21);
    expect(r.aaaNormal).toBe(true);
  });
  it("相同色对比 1", () => {
    expect(contrastRatio("#777777", "#777777").ratio).toBe(1);
  });
  it("非法颜色抛错", () => {
    expect(() => contrastRatio("#zzz", "#fff")).toThrow();
  });
});

describe("数字格式化", () => {
  it("千分位与小数位", () => {
    expect(formatNumber("1234567.891", 2)).toBe("1,234,567.89");
    expect(formatNumber("1000", null)).toBe("1,000");
    expect(formatNumber("1,234", 0)).toBe("1,234");
  });
  it("科学计数", () => {
    expect(toScientific("12345")).toBe("1.2345e+4");
  });
  it("非法抛错", () => {
    expect(() => formatNumber("abc", 2)).toThrow();
    expect(() => formatNumber("1,2,3", 2)).toThrow();
    expect(() => toScientific("Infinity")).toThrow();
  });
});

describe("凯撒 / ROT13", () => {
  it("位移与回转", () => {
    expect(caesar("abc", 1)).toBe("bcd");
    expect(caesar("XYZ", 3)).toBe("ABC");
    expect(caesar("Hello, World!", 0)).toBe("Hello, World!");
  });
  it("ROT13 自反", () => {
    expect(rot13(rot13("Hello"))).toBe("Hello");
    expect(rot13("Hello")).toBe("Uryyb");
  });
});

describe("单位换算", () => {
  it("长度", () => {
    expect(convertUnit("length", 1, "km", "m")).toBe(1000);
    expect(convertUnit("length", 100, "cm", "m")).toBe(1);
  });
  it("重量", () => {
    expect(convertUnit("weight", 1, "kg", "g")).toBe(1000);
  });
  it("温度", () => {
    expect(convertUnit("temperature", 0, "C", "F")).toBe(32);
    expect(convertUnit("temperature", 100, "C", "K")).toBeCloseTo(373.15);
    expect(convertUnit("temperature", 32, "F", "C")).toBe(0);
  });
  it("未知单位抛错", () => {
    expect(() => convertUnit("length", 1, "xx", "m")).toThrow();
  });
});

describe("随机整数", () => {
  it("落在闭区间内、数量正确", () => {
    const arr = randomInts(1, 6, 200);
    expect(arr).toHaveLength(200);
    for (const v of arr) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
  it("单值区间", () => {
    expect(randomInts(5, 5, 3)).toEqual([5, 5, 5]);
  });
});

describe("Unicode 转义", () => {
  it("非 ASCII 转义与还原", () => {
    expect(unicodeEscape("A你")).toBe("A\\u4f60");
    expect(unicodeUnescape("A\\u4f60")).toBe("A你");
    expect(unicodeUnescape(unicodeEscape("héllo 世界"))).toBe("héllo 世界");
  });
});
