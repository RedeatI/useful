import { describe, expect, it } from "vitest";
import { buildLibraryItems, filterLibraryItems } from "./toolLibrary";
import { BUILTIN_ACTION_CATALOG } from "@useful/action-runtime/catalog";
import { BUILTIN_GUI_ACTIONS } from "@/lib/actionCatalog";

const tools = [{
  id: "com.example.plugin",
  name: "示例插件",
  description: "第三方工具",
  icon: "plugin",
  route: "/plugin/com.example.plugin",
  category: "installed" as const,
  kind: "web" as const,
  order: 100,
  supportsShortcut: true,
  requiredCapabilities: ["clipboard.read"],
}];

describe("Tool Library unified view-model", () => {
  it("derives GUI tools and every shared Agent action without duplicating utility logic", () => {
    const items = buildLibraryItems({
      tools,
      toolFavorites: ["com.example.plugin"],
      actionFavorites: ["builtin.utilities.base64"],
      pins: ["builtin.utilities.base64"],
    });
    expect(items.filter((item) => item.agentConfigurable).map((item) => item.id)).toEqual(
      BUILTIN_GUI_ACTIONS.filter((action) => BUILTIN_ACTION_CATALOG.some((descriptor) => descriptor.actionId === action.id))
        .map((action) => action.id),
    );
    expect(items.find((item) => item.id === "builtin.utilities.base64")).toMatchObject({
      favorite: true, pinned: true, surfaces: ["gui", "cli", "mcp"], readOnly: true,
    });
    for (const descriptor of BUILTIN_ACTION_CATALOG) {
      const item = items.find((candidate) => candidate.id === descriptor.actionId);
      expect(item?.readOnly).toBe(descriptor.behavior.readOnly);
      expect(item?.publisherId).toBe(descriptor.source.publisher.id);
      expect(item?.permissions).toEqual([
        ...descriptor.permissions.required,
        ...descriptor.permissions.capabilities,
      ]);
      expect(item?.surfaces).toEqual(["gui", "cli", "mcp"]);
    }
    expect(items.find((item) => item.id === "com.example.plugin")).toMatchObject({
      source: "plugin", permissions: ["clipboard.read"], agentResolution: "runtime-required",
    });
  });

  it("filters Agent/favorites and searches translated labels", () => {
    const items = buildLibraryItems({ tools, toolFavorites: [], actionFavorites: [], pins: [] });
    const translate = (key: string) => key === "util.base64.name" ? "Base64 编解码" : key;
    expect(filterLibraryItems(items, "agent", "", translate)).toHaveLength(BUILTIN_ACTION_CATALOG.length);
    expect(filterLibraryItems(items, "favorites", "", translate)).toHaveLength(0);
    expect(filterLibraryItems(items, "all", "编解码", translate).map((item) => item.id)).toEqual([
      "builtin.utilities.base64",
    ]);
  });

  it("filters functional categories and applies every stable sort option", () => {
    const items = buildLibraryItems({ tools, toolFavorites: [], actionFavorites: [], pins: [] });
    const translate = (key: string) => ({
      "util.json.name": "JSON 格式化",
      "util.base64.name": "A Base64 编解码",
      "util.hash.name": "B 哈希计算",
    }[key] ?? `Z ${key}`);

    expect(filterLibraryItems(items, "all", "", translate, "plugin").map((item) => item.id)).toEqual([
      "com.example.plugin",
    ]);
    expect(filterLibraryItems(items, "all", "", translate, "encode", "name").slice(0, 2).map((item) => item.id)).toEqual([
      "builtin.utilities.base64",
      "builtin.utilities.hash",
    ]);
    for (const sort of ["recommended", "name", "category", "source"] as const) {
      const once = filterLibraryItems(items, "all", "", translate, "all", sort).map((item) => item.id);
      const twice = filterLibraryItems([...items].reverse(), "all", "", translate, "all", sort).map((item) => item.id);
      expect(twice).toEqual(once);
    }
  });

  it("uses NFKC multi-token search across aliases and translated text", () => {
    const items = buildLibraryItems({ tools, toolFavorites: [], actionFavorites: [], pins: [] });
    const translate = (key: string) => key === "util.base64.name" ? "Base64 编解码" : key;
    expect(filterLibraryItems(items, "all", "Ｂ６４ 编解码", translate).map((item) => item.id)).toEqual([
      "builtin.utilities.base64",
    ]);
    expect(filterLibraryItems(items, "all", "word markdown", translate).map((item) => item.id)).toEqual([
      "builtin.office.docx",
    ]);
  });
});
