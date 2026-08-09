// 网络隔离测试：验证离线实用工具操作不触发任何外发网络请求。
// 通过拦截 fetch/XMLHttpRequest/fetch 验证没有携带用户输入的外发请求。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  base64Encode,
  base64Decode,
  urlEncode,
  urlDecode,
  jsonFormat,
  jsonMinify,
  generatePassword,
  convertCase,
  convertBase,
} from "./transforms";
import { hashText } from "./hash";
import { jwtDecode } from "./transforms";

describe("网络隔离测试", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let xhrOpenSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // 拦截所有网络请求
    fetchSpy = vi.fn().mockResolvedValue(new Response("blocked", { status: 403 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => {
      throw new Error("网络请求被测试拦截：离线工具不应发送网络请求");
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    xhrOpenSpy.mockRestore();
  });

  it("Base64 编解码不发送网络请求", () => {
    const input = "Hello 世界 🌍";
    const encoded = base64Encode(input);
    const decoded = base64Decode(encoded);
    expect(decoded).toBe(input);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("URL 编解码不发送网络请求", () => {
    const input = "https://example.com/path?q=你好";
    const encoded = urlEncode(input);
    const decoded = urlDecode(encoded);
    expect(decoded).toBe(input);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("JSON 格式化/压缩不发送网络请求", () => {
    const input = '{"name":"test","value":123}';
    const formatted = jsonFormat(input);
    const minified = jsonMinify(formatted);
    expect(JSON.parse(minified)).toEqual(JSON.parse(input));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("哈希计算不发送网络请求", async () => {
    const input = "sensitive data to hash";
    const hash = await hashText("SHA-256", input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("密码生成不发送网络请求", () => {
    const pw = generatePassword({ length: 32, lower: true, upper: true, digits: true, symbols: true });
    expect(pw.length).toBe(32);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("JWT 解码不发送网络请求", () => {
    // 使用一个示例 JWT（不含敏感信息）
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const decoded = jwtDecode(token);
    expect(decoded.header).toBeDefined();
    expect(decoded.payload).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("命名转换不发送网络请求", () => {
    const result = convertCase("hello world", "camel");
    expect(result).toBe("helloWorld");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("进制转换不发送网络请求", () => {
    const result = convertBase("255", 10, 16);
    expect(result).toBe("ff");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("密码生成器不写入日志或控制台", () => {
    const consoleSpy = vi.spyOn(console, "log");
    const pw = generatePassword({ length: 16, lower: true, upper: true, digits: true, symbols: true });
    expect(pw.length).toBe(16);
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining(pw));
    consoleSpy.mockRestore();
  });
});
