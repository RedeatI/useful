import {
  BUILTIN_ACTION_CATALOG,
  type BuiltinActionMetadata,
} from "@useful/action-runtime/catalog";
import { OFFICE_ACTIONS, type OfficeActionDefinition } from "@/lib/officeRegistry";
import { UTIL_ACTIONS, type ToolActionDefinition } from "@/lib/tools/registry";

export type BuiltinGuiAction = ToolActionDefinition | OfficeActionDefinition;

const officeOrderBase = Math.max(0, ...UTIL_ACTIONS.map((action) => action.order));
const guiMetadata = [
  ...UTIL_ACTIONS,
  ...OFFICE_ACTIONS.map((action) => Object.freeze({
    ...action,
    order: officeOrderBase + action.order,
  })),
];
const guiMetadataById = new Map(guiMetadata.map((action) => [action.id, action]));
const catalogIds = new Set(BUILTIN_ACTION_CATALOG.map((metadata) => metadata.actionId));

if (
  guiMetadataById.size !== guiMetadata.length
  || guiMetadata.some((action) => !catalogIds.has(action.id))
  || BUILTIN_ACTION_CATALOG.some((metadata) => !guiMetadataById.has(metadata.actionId))
) {
  throw new Error("GUI action metadata does not exactly cover the runtime catalog");
}

function joinCatalogAction(metadata: BuiltinActionMetadata): BuiltinGuiAction {
  const gui = guiMetadataById.get(metadata.actionId);
  if (!gui) throw new Error(`Missing GUI metadata for action: ${metadata.actionId}`);
  return Object.freeze({
    ...gui,
    // Runtime catalog owns public identity and execution semantics. Routes,
    // components, icons, and i18n keys remain GUI-layer presentation facts.
    id: metadata.actionId,
    automation: Object.freeze({
      contractVersion: metadata.contractVersion,
      executionMode: metadata.execution.mode,
      surfaces: ["gui", "runtime-cli", "mcp"] as const,
      actionId: metadata.actionId,
    }),
  }) as BuiltinGuiAction;
}

/**
 * One GUI catalog for every built-in Action that can be opened, favorited,
 * pinned, and recorded as recently used. The explicit order is stable across
 * locale changes; CLI/MCP can still request their own descriptor sort.
 */
export const BUILTIN_GUI_ACTIONS: readonly BuiltinGuiAction[] = Object.freeze([
  ...BUILTIN_ACTION_CATALOG.map(joinCatalogAction),
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
