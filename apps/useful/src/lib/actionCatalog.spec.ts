import { describe, expect, it } from "vitest";
import { actionRoute, BUILTIN_GUI_ACTIONS, findBuiltinAction } from "./actionCatalog";

describe("built-in GUI action catalog", () => {
  it("contains the 31 utility and five Office actions in explicit order", () => {
    expect(BUILTIN_GUI_ACTIONS).toHaveLength(36);
    expect(new Set(BUILTIN_GUI_ACTIONS.map((action) => action.id)).size).toBe(36);
    expect(BUILTIN_GUI_ACTIONS.map((action) => action.order)).toEqual(
      [...BUILTIN_GUI_ACTIONS.map((action) => action.order)].sort((left, right) => left - right),
    );
  });

  it("resolves canonical and unambiguous short IDs without guessing unknown routes", () => {
    expect(findBuiltinAction("builtin.office.docx")?.parentToolId).toBe("builtin.office");
    expect(findBuiltinAction("docx")?.id).toBe("builtin.office.docx");
    expect(actionRoute("builtin.utilities.hash")).toBe("/tools/utilities/hash");
    expect(actionRoute("missing")).toBeUndefined();
  });
});
