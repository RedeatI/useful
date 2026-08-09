import { describe, expect, it } from "vitest";
import { findOfficeAction, findOfficeTool, OFFICE_ACTIONS, OFFICE_TOOLS } from "./officeRegistry";

describe("office registry", () => {
  it("declares exactly five stable local office tools in explicit order", () => {
    expect(Object.isFrozen(OFFICE_TOOLS)).toBe(true);
    expect(OFFICE_TOOLS.map((tool) => tool.id)).toEqual([
      "docx", "pptx", "spreadsheet", "pdf", "markdown",
    ]);
    expect(OFFICE_TOOLS.map((tool) => tool.order)).toEqual([10, 20, 30, 40, 50]);
    expect(new Set(OFFICE_TOOLS.map((tool) => tool.route)).size).toBe(OFFICE_TOOLS.length);
    for (const tool of OFFICE_TOOLS) {
      expect(Object.isFrozen(tool)).toBe(true);
      expect(Object.isFrozen(tool.keywords)).toBe(true);
      expect(tool.route).toBe(`/tools/office/${tool.id}`);
      expect(tool.nameKey).toBe(`office.tools.${tool.id}.name`);
      expect(tool.descKey).toBe(`office.tools.${tool.id}.description`);
      expect(tool.component).toBeTruthy();
    }
  });

  it("projects every GUI tool into a stable multi-surface office action", () => {
    expect(Object.isFrozen(OFFICE_ACTIONS)).toBe(true);
    expect(OFFICE_ACTIONS.map((action) => action.id)).toEqual([
      "builtin.office.docx",
      "builtin.office.pptx",
      "builtin.office.spreadsheet",
      "builtin.office.pdf",
      "builtin.office.markdown",
    ]);
    for (const action of OFFICE_ACTIONS) {
      expect(Object.isFrozen(action)).toBe(true);
      expect(Object.isFrozen(action.automation)).toBe(true);
      expect(action.parentToolId).toBe("builtin.office");
      expect(action.route).toBe(`/tools/office/${action.id.split(".")[2]}`);
      expect(action.supportsShortcut).toBe(false);
      expect(action.automation).toMatchObject({
        actionId: action.id,
        contractVersion: "1.0",
        executionMode: "worker",
        surfaces: ["gui", "runtime-cli", "mcp"],
      });
    }
  });

  it("finds known tools without accepting unknown IDs", () => {
    expect(findOfficeTool("pdf")?.icon).toBe("pdf");
    expect(findOfficeAction("pdf")?.id).toBe("builtin.office.pdf");
    expect(findOfficeAction("builtin.office.pdf")?.route).toBe("/tools/office/pdf");
    expect(findOfficeTool("unknown")).toBeUndefined();
    expect(findOfficeAction("unknown")).toBeUndefined();
  });
});
