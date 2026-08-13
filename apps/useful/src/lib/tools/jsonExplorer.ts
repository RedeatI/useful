export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonTreeRow {
  pointer: string;
  parentPointer: string | null;
  key: string;
  depth: number;
  kind: "object" | "array" | "string" | "number" | "boolean" | "null";
  preview: string;
  hasChildren: boolean;
}

export interface JsonTreeBuildResult {
  rows: JsonTreeRow[];
  truncated: boolean;
}

export const JSON_TREE_LIMITS = Object.freeze({ maxNodes: 5_000, maxDepth: 64 });

export function escapeJsonPointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function kindOf(value: JsonValue): JsonTreeRow["kind"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as JsonTreeRow["kind"];
}

function previewOf(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).length}}`;
  const serialized = JSON.stringify(value);
  return serialized.length > 120 ? `${serialized.slice(0, 117)}…` : serialized;
}

export function buildJsonTreeRows(
  root: JsonValue,
  limits: Readonly<{ maxNodes: number; maxDepth: number }> = JSON_TREE_LIMITS,
): JsonTreeBuildResult {
  const rows: JsonTreeRow[] = [];
  let truncated = false;

  function visit(value: JsonValue, key: string, pointer: string, parentPointer: string | null, depth: number): void {
    if (rows.length >= limits.maxNodes) {
      truncated = true;
      return;
    }
    const entries: Array<[string, JsonValue]> = Array.isArray(value)
      ? value.map((entry, index) => [String(index), entry])
      : value !== null && typeof value === "object"
        ? Object.entries(value)
        : [];
    rows.push({
      pointer,
      parentPointer,
      key,
      depth,
      kind: kindOf(value),
      preview: previewOf(value),
      hasChildren: entries.length > 0,
    });
    if (entries.length === 0) return;
    if (depth >= limits.maxDepth) {
      truncated = true;
      return;
    }
    for (const [childKey, child] of entries) {
      const childPointer = `${pointer}/${escapeJsonPointerToken(childKey)}`;
      visit(child, childKey, childPointer, pointer, depth + 1);
      if (rows.length >= limits.maxNodes) {
        truncated = true;
        return;
      }
    }
  }

  visit(root, "$", "", null, 0);
  return { rows, truncated };
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

export function visibleJsonTreeRows(
  rows: readonly JsonTreeRow[],
  collapsed: ReadonlySet<string>,
  search: string,
): JsonTreeRow[] {
  const needle = normalized(search.trim());
  if (needle) {
    const byPointer = new Map(rows.map((row) => [row.pointer, row]));
    const visible = new Set<string>();
    for (const row of rows) {
      const haystack = normalized(`${row.key}\n${row.pointer}\n${row.kind}\n${row.preview}`);
      if (!haystack.includes(needle)) continue;
      let current: JsonTreeRow | undefined = row;
      while (current) {
        visible.add(current.pointer);
        current = current.parentPointer === null ? undefined : byPointer.get(current.parentPointer);
      }
    }
    return rows.filter((row) => visible.has(row.pointer));
  }

  const hiddenDepths: number[] = [];
  return rows.filter((row) => {
    while (hiddenDepths.length && hiddenDepths.at(-1)! >= row.depth) hiddenDepths.pop();
    const hidden = hiddenDepths.length > 0;
    if (!hidden && row.hasChildren && collapsed.has(row.pointer)) hiddenDepths.push(row.depth);
    return !hidden;
  });
}
