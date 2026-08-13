import { describe, expect, it } from "vitest";
import {
  buildJsonTreeRows,
  escapeJsonPointerToken,
  visibleJsonTreeRows,
  type JsonValue,
} from "./jsonExplorer";

describe("JSON explorer", () => {
  const document: JsonValue = { "a/b": { "~key": [1, { ok: true }] }, other: "value" };

  it("builds deterministic RFC 6901 paths", () => {
    const result = buildJsonTreeRows(document);
    expect(escapeJsonPointerToken("a/b~c")).toBe("a~1b~0c");
    expect(result.truncated).toBe(false);
    expect(result.rows.map((row) => row.pointer)).toContain("/a~1b/~0key/1/ok");
    expect(result.rows.find((row) => row.pointer === "/a~1b")?.preview).toBe("{1}");
  });

  it("hides collapsed descendants and search reveals matches with ancestors", () => {
    const rows = buildJsonTreeRows(document).rows;
    expect(visibleJsonTreeRows(rows, new Set(["/a~1b"]), "").some((row) => row.pointer.includes("~0key"))).toBe(false);
    const searched = visibleJsonTreeRows(rows, new Set(["/a~1b"]), "ok");
    expect(searched.map((row) => row.pointer)).toEqual(["", "/a~1b", "/a~1b/~0key", "/a~1b/~0key/1", "/a~1b/~0key/1/ok"]);
  });

  it("truncates deterministically at node and depth bounds", () => {
    const nodeLimited = buildJsonTreeRows([1, 2, 3], { maxNodes: 2, maxDepth: 64 });
    expect(nodeLimited.rows).toHaveLength(2);
    expect(nodeLimited.truncated).toBe(true);
    const depthLimited = buildJsonTreeRows({ a: { b: 1 } }, { maxNodes: 10, maxDepth: 1 });
    expect(depthLimited.rows.map((row) => row.pointer)).toEqual(["", "/a"]);
    expect(depthLimited.truncated).toBe(true);
  });

  it("does not read array entries beyond the node limit", () => {
    const document = [1, 2] as JsonValue[];
    Object.defineProperty(document, 1, {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error("unbounded array enumeration");
      },
    });

    const result = buildJsonTreeRows(document, { maxNodes: 2, maxDepth: 64 });
    expect(result.rows.map((row) => row.pointer)).toEqual(["", "/0"]);
    expect(result.truncated).toBe(true);
  });

  it("does not read object values beyond the node limit", () => {
    const document = { first: 1 } as { [key: string]: JsonValue };
    Object.defineProperty(document, "unreached", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error("unbounded object enumeration");
      },
    });

    const result = buildJsonTreeRows(document, { maxNodes: 2, maxDepth: 64 });
    expect(result.rows.map((row) => row.pointer)).toEqual(["", "/first"]);
    expect(result.truncated).toBe(true);
  });
});
