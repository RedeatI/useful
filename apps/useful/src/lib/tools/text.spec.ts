import { describe, it, expect } from "vitest";
import {
  htmlEncode,
  htmlDecode,
  stripHtmlTags,
  textToHex,
  hexToText,
  textStats,
  processLines,
  slugify,
  toMorse,
  fromMorse,
  humanizeBytes,
  loremIpsum,
} from "@/lib/tools/text";

describe("HTML 实体", () => {
  it("编码与解码 round-trip", () => {
    const s = `<a href="x">Tom & Jerry's</a>`;
    expect(htmlDecode(htmlEncode(s))).toBe(s);
  });
  it("数字实体解码", () => {
    expect(htmlDecode("&#65;&#x42;")).toBe("AB");
  });
  it("去标签", () => {
    expect(stripHtmlTags("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });
});

describe("十六进制 ↔ 文本", () => {
  it("round-trip 含中文", () => {
    for (const s of ["hi", "你好", "A B"]) {
      expect(hexToText(textToHex(s))).toBe(s);
    }
  });
  it("已知向量", () => {
    expect(textToHex("Hi", "")).toBe("4869");
    expect(hexToText("48 69")).toBe("Hi");
  });
  it("非法输入抛错", () => {
    expect(() => hexToText("abc")).toThrow(/偶数/);
    expect(() => hexToText("zz")).toThrow(/非十六进制/);
    expect(() => hexToText("ff")).toThrow();
  });
});

describe("文本统计", () => {
  it("字符/词/行/字节", () => {
    const s = textStats("hello world\n你好");
    expect(s.words).toBe(3);
    expect(s.lines).toBe(2);
    expect(s.chars).toBe(14);
    expect(s.bytes).toBe(18); // "hello world\n"=12 + 你好 6
  });
  it("空文本", () => {
    expect(textStats("")).toMatchObject({ chars: 0, words: 0, lines: 0, bytes: 0 });
  });
});

describe("行处理", () => {
  const base = { trim: false, dropEmpty: false, dedupe: false, sort: "none" as const, reverse: false };
  it("去重 + 升序", () => {
    expect(processLines("b\na\nb\nc", { ...base, dedupe: true, sort: "asc" })).toBe(
      "a\nb\nc",
    );
  });
  it("去空行 + trim", () => {
    expect(processLines(" a \n\n b ", { ...base, trim: true, dropEmpty: true })).toBe(
      "a\nb",
    );
  });
  it("反转", () => {
    expect(processLines("1\n2\n3", { ...base, reverse: true })).toBe("3\n2\n1");
  });
});

describe("Slug", () => {
  it("常见转换", () => {
    expect(slugify("Hello, World! Foo")).toBe("hello-world-foo");
    expect(slugify("  多个   空格 test ")).toBe("test");
    expect(slugify("a_b__c")).toBe("a-b-c");
  });
});

describe("摩尔斯电码", () => {
  it("round-trip", () => {
    expect(toMorse("SOS")).toBe("... --- ...");
    expect(toMorse("SOS!")).toBe("... --- ... -.-.--");
    expect(fromMorse("... --- ...")).toBe("sos");
    expect(fromMorse(toMorse("hello world"))).toBe("hello world");
  });
  it("拒绝不支持的字符与符号，避免静默丢失", () => {
    expect(() => toMorse("你好")).toThrow(/不支持/);
    expect(() => fromMorse("... --- invalid")).toThrow(/不支持/);
  });
});

describe("字节大小", () => {
  it("人类可读", () => {
    expect(humanizeBytes(0)).toBe("0 B");
    expect(humanizeBytes(1024)).toBe("1 KiB");
    expect(humanizeBytes(1536)).toBe("1.5 KiB");
    expect(humanizeBytes(1048576)).toBe("1 MiB");
  });
  it("负数抛错", () => {
    expect(() => humanizeBytes(-1)).toThrow();
  });
});

describe("Lorem Ipsum", () => {
  it("段数可控且确定（同输入同输出）", () => {
    const a = loremIpsum(3);
    const b = loremIpsum(3);
    expect(a).toBe(b); // 确定性种子
    expect(a.split("\n\n")).toHaveLength(3);
    expect(a.startsWith("Lorem") || /^[A-Z]/.test(a)).toBe(true);
  });
  it("段数下限 1", () => {
    expect(loremIpsum(0).split("\n\n")).toHaveLength(1);
  });
});
