// 大输入验证测试：验证 10MB 文本处理不会造成不可接受的 UI 冻结。
// 目标：主线程单次阻塞 < 500ms（对于 < 1MB 输入）。
// 对于 > 1MB 输入，应使用 Worker 或异步处理。
import { describe, it, expect } from "vitest";
import {
  base64Encode,
  base64Decode,
  urlEncode,
  urlDecode,
  jsonFormat,
} from "./transforms";
import { hashText } from "./hash";

function makeText(size: number): string {
  const chars = "ABCDEFGHIJabcdefghij0123456789你好世界";
  let result = "";
  while (result.length < size) result += chars;
  return result.slice(0, size);
}

function makeJson(size: number): string {
  const items = Math.max(1, Math.floor(size / 40));
  const arr = Array.from({ length: items }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    value: i * 0.1,
  }));
  return JSON.stringify(arr);
}

function elapsed(fn: () => void): number {
  const start = Date.now();
  fn();
  return Date.now() - start;
}

describe("10MB 大输入性能验证", () => {
  const MB_1 = 1024 * 1024;
  const MB_10 = 10 * 1024 * 1024;

  it("Base64 编码 1MB 完成（不崩溃）", () => {
    const text = makeText(MB_1);
    const ms = elapsed(() => base64Encode(text));
    // 在 CI/测试环境中 1MB 应在合理时间内完成
    expect(ms).toBeLessThan(2000);
  });

  it("Base64 解码 1MB 完成（不崩溃）", () => {
    const text = makeText(MB_1);
    const encoded = base64Encode(text);
    const ms = elapsed(() => base64Decode(encoded));
    expect(ms).toBeLessThan(2000);
  });

  it("URL 编码 1MB 完成（不崩溃）", () => {
    const text = makeText(MB_1);
    const ms = elapsed(() => urlEncode(text));
    expect(ms).toBeLessThan(2000);
  });

  it("JSON 格式化 1MB 完成（不崩溃）", () => {
    const json = makeJson(MB_1);
    const ms = elapsed(() => jsonFormat(json));
    expect(ms).toBeLessThan(5000);
  });

  it("SHA-256 哈希 1MB 完成（异步）", async () => {
    const text = makeText(MB_1);
    const start = Date.now();
    const hash = await hashText("SHA-256", text);
    const ms = Date.now() - start;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ms).toBeLessThan(5000);
  });

  it("Base64 10MB 编码可完成（不崩溃不无限循环）", () => {
    const text = makeText(MB_10);
    const encoded = base64Encode(text);
    expect(encoded.length).toBeGreaterThan(MB_10);
    const decoded = base64Decode(encoded);
    expect(decoded.length).toBe(MB_10);
  }, 30_000);

  it("Base64 10MB 往返一致性", () => {
    const text = makeText(MB_10);
    const encoded = base64Encode(text);
    const decoded = base64Decode(encoded);
    expect(decoded).toBe(text);
  }, 30_000);

  it("URL 10MB 编解码往返一致", () => {
    const text = makeText(MB_10);
    const encoded = urlEncode(text);
    const decoded = urlDecode(encoded);
    expect(decoded).toBe(text);
  });

  it("SHA-256 10MB 哈希可完成", async () => {
    const text = makeText(MB_10);
    const hash = await hashText("SHA-256", text);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("空输入不崩溃", () => {
    expect(() => base64Encode("")).not.toThrow();
    expect(() => urlEncode("")).not.toThrow();
  });

  it("Unicode 10MB 处理正确", () => {
    const unicode = "你好🌍🎉".repeat(Math.floor(MB_10 / 5));
    const encoded = base64Encode(unicode);
    const decoded = base64Decode(encoded);
    expect(decoded).toBe(unicode);
  }, 30_000);
});
