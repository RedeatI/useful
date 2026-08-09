import { describe, it, expect } from "vitest";
import { hashText, HASH_ALGOS } from "@/lib/tools/hash";

describe("哈希（Web Crypto）", () => {
  it("空字符串已知向量", async () => {
    expect(await hashText("SHA-1", "")).toBe(
      "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    );
    expect(await hashText("SHA-256", "")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it("abc 已知向量", async () => {
    expect(await hashText("SHA-256", "abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("全部算法输出小写 hex 且长度正确", async () => {
    const lens: Record<string, number> = {
      "SHA-1": 40,
      "SHA-256": 64,
      "SHA-384": 96,
      "SHA-512": 128,
    };
    for (const algo of HASH_ALGOS) {
      const h = await hashText(algo, "useful");
      expect(h).toMatch(/^[0-9a-f]+$/);
      expect(h).toHaveLength(lens[algo]);
    }
  });
});
