import { describe, expect, it } from "vitest";
import {
  isOfficeWorkerRequest,
  isOfficeWorkerResponse,
  officeRequestTransferables,
  officeResponseTransferables,
  type OfficeWorkerResponse,
} from "./officeWorkerProtocol";

describe("office Worker protocol", () => {
  it("accepts only the closed request and response shapes", () => {
    expect(isOfficeWorkerRequest({ operation: "markdown.parse", markdown: "# Local" })).toBe(true);
    expect(isOfficeWorkerRequest({ operation: "markdown.parse", markdown: "# Local", remoteUrl: "https://example.com" })).toBe(false);
    expect(isOfficeWorkerRequest({ operation: "office.executeMacro", input: new Uint8Array() })).toBe(false);
    expect(isOfficeWorkerRequest({ operation: "spreadsheet.inspectCsv", text: "a,b" })).toBe(true);
    expect(isOfficeWorkerRequest({ operation: "spreadsheet.inspectCsv", text: "a,b", url: "https://example.invalid" })).toBe(false);
    expect(isOfficeWorkerRequest({ operation: "pdf.extractPages", input: new Uint8Array(), optionsJson: '{"pages":[0]}' })).toBe(true);

    expect(isOfficeWorkerResponse({
      type: "success",
      operation: "pdf.merge",
      result: { kind: "binary", bytes: new Uint8Array([1]) },
    }, "pdf.merge")).toBe(true);
    expect(isOfficeWorkerResponse({
      type: "error",
      code: "OPERATION_FAILED",
      debug: "SECRET",
    }, "pdf.merge")).toBe(false);
  });

  it("collects unique typed-array buffers for zero-copy transfer in both directions", () => {
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    expect(officeRequestTransferables({ operation: "pdf.merge", inputs: [first, second] }))
      .toEqual([first.buffer, second.buffer]);

    const response: OfficeWorkerResponse = {
      type: "success",
      operation: "pdf.split",
      result: { kind: "binaries", files: [first, second] },
    };
    expect(officeResponseTransferables(response)).toEqual([first.buffer, second.buffer]);
  });
});
