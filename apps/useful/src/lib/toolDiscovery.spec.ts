import { describe, expect, it } from "vitest";
import {
  compareCodePoints,
  discoverItems,
  discoveryTokens,
  normalizeDiscoveryText,
  type DiscoverySort,
  type DiscoveryDocument,
} from "./toolDiscovery";

const documents: DiscoveryDocument[] = [
  { id: "builtin.utilities.hash", name: "Hash calculator", description: "Local digest", aliases: ["checksum"], keywords: ["sha256"], category: "encode", source: "builtin", order: 20 },
  { id: "builtin.utilities.base64", name: "Base64 编解码", description: "UTF-8 文本转换", aliases: ["b64"], keywords: ["编码"], category: "encode", source: "builtin", order: 10 },
  { id: "com.example.plugin", name: "Example plugin", description: "Third party digest and checksum helper", keywords: ["extension"], category: "plugin", source: "plugin", order: 100 },
];

const discover = (query: string, sort: DiscoverySort = "recommended") =>
  discoverItems(documents, query, (document) => document, sort);

describe("tool discovery", () => {
  it("normalizes NFKC, case, and whitespace before tokenizing", () => {
    expect(normalizeDiscoveryText("  Ｂ６４\t编码  ")).toBe("b64 编码");
    expect(discoveryTokens("  Ｂ６４\t编码  ")).toEqual(["b64", "编码"]);
  });

  it("requires every token and ranks exact aliases above descriptions", () => {
    expect(discover("Ｂ６４ 编码").map((item) => item.id)).toEqual(["builtin.utilities.base64"]);
    expect(discover("digest").map((item) => item.id)).toEqual([
      "builtin.utilities.hash",
      "com.example.plugin",
    ]);
    expect(discover("checksum").map((item) => item.id)).toEqual([
      "builtin.utilities.hash",
      "com.example.plugin",
    ]);
  });

  it("supports deterministic recommended, name, category, and source order", () => {
    expect(discover("").map((item) => item.id)).toEqual([
      "builtin.utilities.base64",
      "builtin.utilities.hash",
      "com.example.plugin",
    ]);
    expect(discover("", "name").map((item) => item.id)).toEqual([
      "builtin.utilities.base64",
      "com.example.plugin",
      "builtin.utilities.hash",
    ]);
    expect(discover("", "category").map((item) => item.id)).toEqual([
      "builtin.utilities.base64",
      "builtin.utilities.hash",
      "com.example.plugin",
    ]);
    expect(discover("", "source").map((item) => item.id)).toEqual([
      "builtin.utilities.base64",
      "builtin.utilities.hash",
      "com.example.plugin",
    ]);
  });

  it("uses locale-independent code-point ordering as the final tie-break", () => {
    expect(compareCodePoints("a", "b")).toBeLessThan(0);
    expect(compareCodePoints("😀", "😁")).toBeLessThan(0);
    const tied = [
      { id: "tool.b", name: "same", order: 1 },
      { id: "tool.a", name: "same", order: 1 },
    ];
    expect(discoverItems(tied, "", (item) => item).map((item) => item.id)).toEqual(["tool.a", "tool.b"]);
  });
});
