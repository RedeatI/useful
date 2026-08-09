// 大输入性能测试：验证不同输入大小（1KB/1MB/10MB）下的处理性能。
// 使用 vitest bench 测量处理时间和主线程阻塞。
import { describe, bench } from "vitest";
import { base64Encode, base64Decode, jsonFormat, urlEncode } from "@/lib/tools/transforms";
import { hashText } from "@/lib/tools/hash";

// 生成不同大小的测试输入
function makeText(size: number): string {
  const chars = "ABCDEFGHIJabcdefghij0123456789你好世界🌍";
  let result = "";
  while (result.length < size) {
    result += chars;
  }
  return result.slice(0, size);
}

function makeJson(size: number): string {
  const items = Math.max(1, Math.floor(size / 50));
  const arr = Array.from({ length: items }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    value: Math.random(),
  }));
  return JSON.stringify(arr);
}

describe("大输入性能", () => {
  const sizes: Array<[string, number]> = [
    ["1KB", 1024],
    ["1MB", 1024 * 1024],
  ];

  for (const [label, size] of sizes) {
    const text = makeText(size);

    bench(`Base64 编码 ${label}`, () => {
      base64Encode(text);
    }, { iterations: 3 });

    bench(`URL 编码 ${label}`, () => {
      urlEncode(text);
    }, { iterations: 3 });

    bench(`SHA-256 哈希 ${label}`, async () => {
      await hashText("SHA-256", text);
    }, { iterations: 3, warmupIterations: 0 });
  }

  // JSON 格式化测试
  for (const [label, size] of [["1KB", 1024], ["100KB", 100 * 1024]] as Array<[string, number]>) {
    const json = makeJson(size);

    bench(`JSON 格式化 ${label}`, () => {
      jsonFormat(json);
    }, { iterations: 3 });
  }

  // Base64 往返
  bench("Base64 1MB 往返", () => {
    const text = makeText(1024 * 1024);
    const encoded = base64Encode(text);
    base64Decode(encoded);
  }, { iterations: 2 });
});
