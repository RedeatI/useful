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

const OBJECT_PREVIEW_COUNT_LIMIT = 100;

export function escapeJsonPointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function kindOf(value: JsonValue): JsonTreeRow["kind"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as JsonTreeRow["kind"];
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function objectPreview(value: { [key: string]: JsonValue }): string {
  let count = 0;
  for (const key in value) {
    if (!hasOwn(value, key)) continue;
    count += 1;
    if (count > OBJECT_PREVIEW_COUNT_LIMIT) return `{${OBJECT_PREVIEW_COUNT_LIMIT}+}`;
  }
  return `{${count}}`;
}

function hasChildren(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || typeof value !== "object") return false;
  for (const key in value) {
    if (hasOwn(value, key)) return true;
  }
  return false;
}

function previewOf(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value !== null && typeof value === "object") return objectPreview(value);
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
    const rowHasChildren = hasChildren(value);
    rows.push({
      pointer,
      parentPointer,
      key,
      depth,
      kind: kindOf(value),
      preview: previewOf(value),
      hasChildren: rowHasChildren,
    });
    if (!rowHasChildren) return;
    if (depth >= limits.maxDepth) {
      truncated = true;
      return;
    }

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const childKey = String(index);
        const childPointer = `${pointer}/${childKey}`;
        visit(value[index]!, childKey, childPointer, pointer, depth + 1);
        if (rows.length >= limits.maxNodes) {
          truncated = true;
          return;
        }
      }
      return;
    }

    if (value !== null && typeof value === "object") {
      for (const childKey in value) {
        if (!hasOwn(value, childKey)) continue;
        const childPointer = `${pointer}/${escapeJsonPointerToken(childKey)}`;
        visit(value[childKey]!, childKey, childPointer, pointer, depth + 1);
        if (rows.length >= limits.maxNodes) {
          truncated = true;
          return;
        }
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
