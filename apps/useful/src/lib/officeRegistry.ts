import type { Component } from "vue";
import { defineAsyncComponent } from "vue";

export type OfficeToolId = "docx" | "pptx" | "spreadsheet" | "pdf" | "markdown";
export type OfficeActionId = `builtin.office.${OfficeToolId}`;

export interface OfficeToolDefinition {
  id: OfficeToolId;
  nameKey: string;
  descKey: string;
  icon: string;
  order: number;
  route: string;
  component: Component;
  keywords: readonly string[];
  aliases: readonly string[];
}

export interface OfficeActionDefinition {
  id: OfficeActionId;
  parentToolId: "builtin.office";
  nameKey: string;
  descKey: string;
  icon: string;
  category: "office";
  keywords: readonly string[];
  aliases: readonly string[];
  route: string;
  component: Component;
  sensitiveInput: true;
  expectedInputSize: "large";
  supportsShortcut: false;
  supportsFavorite: true;
  supportsRecent: true;
  order: number;
  automation: {
    contractVersion: "1.0";
    executionMode: "worker";
    surfaces: readonly ["gui", "runtime-cli", "mcp"];
    actionId: OfficeActionId;
  };
}

const lazy = (loader: () => Promise<unknown>): Component => defineAsyncComponent(loader as never);

const officeTools: OfficeToolDefinition[] = [
  {
    id: "docx",
    nameKey: "office.tools.docx.name",
    descKey: "office.tools.docx.description",
    icon: "document",
    order: 10,
    route: "/tools/office/docx",
    component: lazy(() => import("@/views/tools/office/DocxTool.vue")),
    keywords: ["docx", "word", "document", "markdown"],
    aliases: ["word"],
  },
  {
    id: "pptx",
    nameKey: "office.tools.pptx.name",
    descKey: "office.tools.pptx.description",
    icon: "presentation",
    order: 20,
    route: "/tools/office/pptx",
    component: lazy(() => import("@/views/tools/office/PptxTool.vue")),
    keywords: ["pptx", "powerpoint", "slides", "presentation", "markdown"],
    aliases: ["powerpoint", "slides"],
  },
  {
    id: "spreadsheet",
    nameKey: "office.tools.spreadsheet.name",
    descKey: "office.tools.spreadsheet.description",
    icon: "spreadsheet",
    order: 30,
    route: "/tools/office/spreadsheet",
    component: lazy(() => import("@/views/tools/office/SpreadsheetTool.vue")),
    keywords: ["xlsx", "excel", "csv", "spreadsheet", "table", "inspect", "markdown"],
    aliases: ["excel", "csv"],
  },
  {
    id: "pdf",
    nameKey: "office.tools.pdf.name",
    descKey: "office.tools.pdf.description",
    icon: "pdf",
    order: 40,
    route: "/tools/office/pdf",
    component: lazy(() => import("@/views/tools/office/PdfTool.vue")),
    keywords: ["pdf", "merge", "split", "extract", "delete", "inspect", "reorder", "rotate", "metadata"],
    aliases: ["pdf-pages"],
  },
  {
    id: "markdown",
    nameKey: "office.tools.markdown.name",
    descKey: "office.tools.markdown.description",
    icon: "markdown",
    order: 50,
    route: "/tools/office/markdown",
    component: lazy(() => import("@/views/tools/office/MarkdownTool.vue")),
    keywords: ["markdown", "md", "outline", "docx", "pptx"],
    aliases: ["md"],
  },
];

export const OFFICE_TOOLS: readonly OfficeToolDefinition[] = Object.freeze(
  officeTools.map((tool) => Object.freeze({
    ...tool,
    keywords: Object.freeze([...tool.keywords]),
    aliases: Object.freeze([...tool.aliases]),
  })),
);

export const OFFICE_ACTIONS: readonly OfficeActionDefinition[] = Object.freeze(
  OFFICE_TOOLS.map((tool) => {
    const actionId = `builtin.office.${tool.id}` as OfficeActionId;
    return Object.freeze({
      id: actionId,
      parentToolId: "builtin.office" as const,
      nameKey: tool.nameKey,
      descKey: tool.descKey,
      icon: tool.icon,
      category: "office" as const,
      keywords: tool.keywords,
      aliases: tool.aliases,
      route: tool.route,
      component: tool.component,
      sensitiveInput: true as const,
      expectedInputSize: "large" as const,
      supportsShortcut: false as const,
      supportsFavorite: true as const,
      supportsRecent: true as const,
      order: tool.order,
      automation: Object.freeze({
        contractVersion: "1.0" as const,
        executionMode: "worker" as const,
        surfaces: ["gui", "runtime-cli", "mcp"] as const,
        actionId,
      }),
    });
  }),
);

export function findOfficeTool(id: string): OfficeToolDefinition | undefined {
  return OFFICE_TOOLS.find((tool) => tool.id === id);
}

export function findOfficeAction(actionId: string): OfficeActionDefinition | undefined {
  const fullId = actionId.startsWith("builtin.office.") ? actionId : `builtin.office.${actionId}`;
  return OFFICE_ACTIONS.find((action) => action.id === fullId);
}
