import type { ToolDefinition } from "@/lib/types";
import { BUILTIN_ACTION_CATALOG } from "@useful/action-runtime/catalog";
import { BUILTIN_GUI_ACTIONS } from "@/lib/actionCatalog";
import { discoverItems, type DiscoverySort } from "@/lib/toolDiscovery";

export type LibraryFilter = "all" | "gui" | "agent" | "installed" | "favorites";
export type LibrarySource = "builtin" | "plugin";
export type LibrarySurface = "gui" | "cli" | "mcp";
export type LibraryFunctionalCategory = "all" | "encode" | "convert" | "generate" | "text" | "web" | "office" | "media" | "system" | "plugin" | "other";
export type LibrarySort = DiscoverySort;

export interface LibraryItem {
  id: string;
  kind: "tool" | "action";
  name: string;
  description: string;
  translated: boolean;
  icon: string;
  route: string;
  source: LibrarySource;
  publisherId: string | null;
  surfaces: LibrarySurface[];
  readOnly: boolean | null;
  permissions: string[];
  installed: boolean;
  favorite: boolean;
  pinned: boolean;
  agentConfigurable: boolean;
  agentResolution: "builtin" | "runtime-required" | "none";
  keywords: string[];
  aliases: string[];
  functionalCategory: Exclude<LibraryFunctionalCategory, "all">;
  order: number;
}

export interface LibraryStateInput {
  tools: ToolDefinition[];
  toolFavorites: string[];
  actionFavorites: string[];
  pins: string[];
}

const builtinIcon: Record<string, string> = {
  "builtin.office": "office",
  "builtin.video-trim": "video",
  "builtin.process-monitor": "process",
};

const builtinFunctionalCategory: Record<string, LibraryItem["functionalCategory"]> = {
  "builtin.office": "office",
  "builtin.video-trim": "media",
  "builtin.process-monitor": "system",
};

export function buildLibraryItems(input: LibraryStateInput): LibraryItem[] {
  const descriptors = new Map(BUILTIN_ACTION_CATALOG.map((descriptor) => [descriptor.actionId, descriptor]));
  const actionItems = BUILTIN_GUI_ACTIONS.map<LibraryItem>((action) => {
    const descriptor = descriptors.get(action.id);
    return {
      id: action.id,
      kind: "action",
      name: action.nameKey,
      description: action.descKey,
      translated: true,
      icon: action.icon,
      route: action.route,
      source: "builtin",
      publisherId: descriptor?.source.publisher.id ?? null,
      surfaces: descriptor ? ["gui", "cli", "mcp"] : ["gui"],
      readOnly: descriptor ? descriptor.behavior.readOnly : null,
      permissions: descriptor ? [...descriptor.permissions.required, ...descriptor.permissions.capabilities] : [],
      installed: false,
      favorite: input.actionFavorites.includes(action.id),
      pinned: input.pins.includes(action.id),
      agentConfigurable: Boolean(descriptor),
      agentResolution: descriptor ? "builtin" : "none",
      keywords: [action.id, ...action.keywords, ...action.aliases],
      aliases: [...action.aliases],
      functionalCategory: action.category,
      order: action.order,
    };
  });

  const toolItems = input.tools
    .filter((tool) => !["builtin.utilities", "builtin.office"].includes(tool.id))
    .map<LibraryItem>((tool) => ({
      id: tool.id,
      kind: "tool",
      name: tool.name,
      description: tool.description,
      translated: tool.category === "builtin",
      icon: tool.category === "builtin" ? builtinIcon[tool.id] ?? "puzzle" : "puzzle",
      route: tool.route,
      source: tool.category === "installed" ? "plugin" : "builtin",
      publisherId: null,
      surfaces: ["gui"],
      readOnly: null,
      permissions: [...tool.requiredCapabilities],
      installed: tool.category === "installed",
      favorite: input.toolFavorites.includes(tool.id),
      pinned: input.pins.includes(tool.id),
      agentConfigurable: false,
      agentResolution: tool.category === "installed" ? "runtime-required" : "none",
      keywords: [tool.id, tool.name, tool.description],
      aliases: [],
      functionalCategory: tool.category === "installed"
        ? "plugin"
        : builtinFunctionalCategory[tool.id] ?? "other",
      // Top-level tools follow the backend registry's explicit order after utility actions.
      order: 10_000 + tool.order,
    }));

  return discoverItems([...actionItems, ...toolItems], "", libraryDocument);
}

function libraryDocument(item: LibraryItem, translate?: (key: string) => string) {
  return {
    id: item.id,
    name: item.translated && translate ? translate(item.name) : item.name,
    description: item.translated && translate ? translate(item.description) : item.description,
    keywords: item.keywords,
    aliases: item.aliases,
    category: item.functionalCategory,
    source: item.source,
    order: item.order,
  };
}

export function filterLibraryItems(
  items: LibraryItem[],
  filter: LibraryFilter,
  query: string,
  translate: (key: string) => string,
  category: LibraryFunctionalCategory = "all",
  sort: LibrarySort = "recommended",
): LibraryItem[] {
  const filtered = items.filter((item) => {
    if (filter === "gui" && !item.surfaces.includes("gui")) return false;
    if (filter === "agent" && !item.surfaces.some((surface) => surface === "cli" || surface === "mcp")) return false;
    if (filter === "installed" && !item.installed) return false;
    if (filter === "favorites" && !item.favorite) return false;
    if (category !== "all" && item.functionalCategory !== category) return false;
    return true;
  });
  return discoverItems(filtered, query, (item) => libraryDocument(item, translate), sort);
}
