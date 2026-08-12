import { describe, expect, it, vi } from "vitest";

const parserMock = vi.hoisted(() => vi.fn((text: string) => ({ text })));
vi.mock("@useful/protocol/useful-cli-verify-all-browser", () => ({
  USEFUL_CLI_VERIFY_ALL_MAX_UTF8_BYTES: 1048576,
  parseUsefulCliVerifyAllJson: parserMock,
}));

import { connectionOutputText, inspectAgentConnectionJson } from "./agentConnectionInspector";

describe("agentConnectionInspector", () => {
  it("delegates the untouched full CLI envelope text to the browser-only parser", () => {
    expect(inspectAgentConnectionJson("  envelope\n")).toEqual({ text: "  envelope\n" });
    expect(parserMock).toHaveBeenCalledWith("  envelope\n");
  });

  it("formats only the explicit connection output", () => {
    expect(connectionOutputText({ kind: "host-command", powershellCommand: "& 'useful'" })).toBe("& 'useful'");
    expect(connectionOutputText({ kind: "merge-fragment", format: "toml", mergeFragment: "[mcp_servers.useful]" })).toBe("[mcp_servers.useful]");
    expect(connectionOutputText({ kind: "merge-fragment", format: "json", mergeFragment: { safe: true } })).toBe('{\n  "safe": true\n}');
  });
});
