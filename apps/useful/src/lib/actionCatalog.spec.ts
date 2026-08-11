import { describe, expect, it } from "vitest";
import { BUILTIN_ACTION_CATALOG } from "@useful/action-runtime/catalog";
import { actionRoute, BUILTIN_GUI_ACTIONS, findBuiltinAction } from "./actionCatalog";

describe("built-in GUI action catalog", () => {
  it("contains the 31 utility and five Office actions in explicit order", () => {
    expect(BUILTIN_GUI_ACTIONS).toHaveLength(36);
    expect(new Set(BUILTIN_GUI_ACTIONS.map((action) => action.id)).size).toBe(36);
    expect(BUILTIN_GUI_ACTIONS.map((action) => action.order)).toEqual(
      [...BUILTIN_GUI_ACTIONS.map((action) => action.order)].sort((left, right) => left - right),
    );
  });

  it("covers exactly the lightweight runtime catalog without loading handlers", () => {
    expect(BUILTIN_GUI_ACTIONS.map((action) => action.id)).toEqual(
      BUILTIN_ACTION_CATALOG.map((action) => action.actionId),
    );
    for (const metadata of BUILTIN_ACTION_CATALOG) {
      const guiAction = findBuiltinAction(metadata.actionId);
      expect(guiAction?.id).toBe(metadata.actionId);
      expect(guiAction?.automation).toEqual({
        contractVersion: metadata.contractVersion,
        executionMode: metadata.execution.mode,
        surfaces: ["gui", "runtime-cli", "mcp"],
        actionId: metadata.actionId,
      });
      expect(actionRoute(metadata.actionId)).toBe(metadata.presentation.route);
    }
  });

  it("resolves canonical and unambiguous short IDs without guessing unknown routes", () => {
    expect(findBuiltinAction("builtin.office.docx")?.parentToolId).toBe("builtin.office");
    expect(findBuiltinAction("docx")?.id).toBe("builtin.office.docx");
    expect(actionRoute("builtin.utilities.hash")).toBe("/tools/utilities/hash");
    expect(actionRoute("missing")).toBeUndefined();
  });
});
