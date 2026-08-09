import { describe, it, expect } from "vitest";
import {
  base64Encode,
  base64Decode,
  urlEncode,
  urlDecode,
  jsonFormat,
  jsonMinify,
  uuidV4,
  uuidBatch,
  fromUnix,
  fromDateString,
  regexTest,
  regexReplace,
  jwtDecode,
  convertCase,
  splitWords,
  parseHex,
  rgbToHex,
  rgbToHsl,
  generatePassword,
  convertBase,
} from "@/lib/tools/transforms";

describe("Base64", () => {
  it("round-trips ASCII 与中文（UTF-8）", () => {
    for (const s of ["hello", "你好，世界！", "🎉 emoji", ""]) {
      expect(base64Decode(base64Encode(s))).toBe(s);
    }
  });
  it("已知向量", () => {
    expect(base64Encode("Man")).toBe("TWFu");
    expect(base64Decode("TWFu")).toBe("Man");
  });
  it("非法 Base64 抛可读错误", () => {
    expect(() => base64Decode("!!!not base64!!!")).toThrow(/Base64/);
    expect(() => base64Decode("TR==")).toThrow(/Base64/);
    expect(() => base64Decode("/w==")).toThrow(/Base64/);
  });
});

describe("URL 编解码", () => {
  it("round-trip 含特殊字符", () => {
    const s = "a b&c=中文/?#";
    expect(urlDecode(urlEncode(s))).toBe(s);
  });
  it("+ 解码为空格", () => {
    expect(urlDecode("a+b")).toBe("a b");
  });
  it("非法百分号编码抛错", () => {
    expect(() => urlDecode("%zz")).toThrow(/URL/);
  });
});

describe("JSON", () => {
  it("格式化与压缩", () => {
    expect(jsonFormat('{"a":1,"b":[2,3]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}',
    );
    expect(jsonMinify('{ "a" : 1 }')).toBe('{"a":1}');
  });
  it("非法 JSON 抛错", () => {
    expect(() => jsonFormat("{not json")).toThrow();
  });
});

describe("UUID", () => {
  it("符合 v4 格式且唯一", () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const set = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const u = uuidV4();
      expect(u).toMatch(re);
      set.add(u);
    }
    expect(set.size).toBe(200);
  });
  it("批量上限 1000、下限 1", () => {
    expect(uuidBatch(5)).toHaveLength(5);
    expect(uuidBatch(0)).toHaveLength(1);
    expect(uuidBatch(99999)).toHaveLength(1000);
  });
});

describe("时间戳", () => {
  it("秒与毫秒自动识别", () => {
    const sec = fromUnix(0);
    expect(sec.iso).toBe("1970-01-01T00:00:00.000Z");
    expect(fromUnix(1_000_000_000).unixSeconds).toBe(1_000_000_000);
    // >= 1e12 视为毫秒
    expect(fromUnix(1_700_000_000_000).unixSeconds).toBe(1_700_000_000);
  });
  it("日期字符串解析", () => {
    expect(fromDateString("1970-01-01T00:00:00Z").unixSeconds).toBe(0);
    expect(() => fromDateString("not a date")).toThrow();
  });
});

describe("正则", () => {
  it("返回全部匹配与分组", () => {
    const m = regexTest("(\\d)(\\w)", "", "1a 2b");
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ match: "1a", groups: ["1", "a"] });
  });
  it("零宽匹配不死循环", () => {
    const m = regexTest("a*", "", "aa");
    expect(m.length).toBeGreaterThan(0);
  });
  it("替换", () => {
    expect(regexReplace("\\d+", "g", "a1b22", "#")).toBe("a#b#");
  });
  it("非法正则抛可读错误", () => {
    expect(() => regexTest("(", "", "x")).toThrow(/正则非法/);
  });
});

describe("JWT 解码", () => {
  it("解码 header 与 payload（不验签）", () => {
    // {"alg":"HS256","typ":"JWT"} . {"sub":"123","name":"Ada"} . sig
    const token =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjMiLCJuYW1lIjoiQWRhIn0." +
      "sig";
    const p = jwtDecode(token);
    expect(p.header).toMatchObject({ alg: "HS256", typ: "JWT" });
    expect(p.payload).toMatchObject({ sub: "123", name: "Ada" });
    expect(p.signature).toBe("sig");
  });
  it("段数不对抛错", () => {
    expect(() => jwtDecode("a.b")).toThrow(/三段/);
  });
});

describe("大小写转换", () => {
  it("splitWords 识别多种命名", () => {
    expect(splitWords("helloWorld")).toEqual(["hello", "World"]);
    expect(splitWords("hello_world-foo bar")).toEqual([
      "hello",
      "world",
      "foo",
      "bar",
    ]);
  });
  it("各风格", () => {
    const src = "hello world foo";
    expect(convertCase(src, "camel")).toBe("helloWorldFoo");
    expect(convertCase(src, "pascal")).toBe("HelloWorldFoo");
    expect(convertCase(src, "snake")).toBe("hello_world_foo");
    expect(convertCase(src, "kebab")).toBe("hello-world-foo");
    expect(convertCase(src, "constant")).toBe("HELLO_WORLD_FOO");
    expect(convertCase(src, "title")).toBe("Hello World Foo");
    expect(convertCase("", "camel")).toBe("");
  });
});

describe("颜色转换", () => {
  it("hex 解析（3/6 位）", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("00ff80")).toEqual({ r: 0, g: 255, b: 128 });
    expect(parseHex("#zzz")).toBeNull();
  });
  it("rgb → hex", () => {
    expect(rgbToHex({ r: 0, g: 255, b: 128 })).toBe("#00ff80");
    expect(rgbToHex({ r: 300, g: -5, b: 128 })).toBe("#ff0080"); // clamp
  });
  it("rgb → hsl", () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsl({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, l: 100 });
  });
});

describe("密码生成", () => {
  it("长度与字符集约束", () => {
    const pw = generatePassword({
      length: 20,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
    });
    expect(pw).toHaveLength(20);
    expect(/[a-z]/.test(pw)).toBe(true);
    expect(/[A-Z]/.test(pw)).toBe(true);
    expect(/[0-9]/.test(pw)).toBe(true);
  });
  it("无字符集抛错；长度下限 4", () => {
    expect(() =>
      generatePassword({
        length: 10,
        lower: false,
        upper: false,
        digits: false,
        symbols: false,
      }),
    ).toThrow();
    expect(
      generatePassword({
        length: 1,
        lower: true,
        upper: false,
        digits: false,
        symbols: false,
      }),
    ).toHaveLength(4);
  });
  it("每个选中字符集至少出现一次", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword({
        length: 4,
        lower: true,
        upper: true,
        digits: true,
        symbols: true,
      });
      expect(/[a-z]/.test(pw)).toBe(true);
      expect(/[A-Z]/.test(pw)).toBe(true);
      expect(/[0-9]/.test(pw)).toBe(true);
      expect(/[^a-zA-Z0-9]/.test(pw)).toBe(true);
    }
  });
});

describe("进制转换", () => {
  it("常见转换", () => {
    expect(convertBase("255", 10, 16)).toBe("ff");
    expect(convertBase("ff", 16, 10)).toBe("255");
    expect(convertBase("1010", 2, 10)).toBe("10");
    expect(convertBase("0xFF", 16, 2)).toBe("11111111");
  });
  it("非法数值抛错", () => {
    expect(() => convertBase("2", 2, 10)).toThrow(); // 2 不是二进制
    expect(() => convertBase("xyz", 16, 10)).toThrow();
    expect(() => convertBase("", 10, 16)).toThrow();
  });
});
