import { OFFICE_ACTIONS, type OfficeActionDefinition } from "@/lib/officeRegistry";
import { UTIL_ACTIONS, type ToolActionDefinition } from "@/lib/tools/registry";

export type BuiltinGuiAction = ToolActionDefinition | OfficeActionDefinition;

const officeOrderBase = Math.max(0, ...UTIL_ACTIONS.map((action) => action.order));

/**
 * One GUI catalog for every built-in Action that can be opened, favorited,
 * pinned, and recorded as recently used. The explicit order is stable across
 * locale changes; CLI/MCP can still request their own descriptor sort.
 */
export const BUILTIN_GUI_ACTIONS: readonly BuiltinGuiAction[] = Object.freeze([
  ...UTIL_ACTIONS,
  ...OFFICE_ACTIONS.map((action) => Object.freeze({
    ...action,
    order: officeOrderBase + action.order,
  })),
]);

export function findBuiltinAction(actionId: string): BuiltinGuiAction | undefined {
  const exact = BUILTIN_GUI_ACTIONS.find((action) => action.id === actionId);
  if (exact) return exact;
  const matches = BUILTIN_GUI_ACTIONS.filter((action) => action.id.endsWith(`.${actionId}`));
  return matches.length === 1 ? matches[0] : undefined;
}

export function actionRoute(actionId: string): string | undefined {
  return findBuiltinAction(actionId)?.route;
}
