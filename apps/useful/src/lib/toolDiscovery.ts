export type DiscoverySort = "recommended" | "name" | "category" | "source";

export interface DiscoveryDocument {
  id: string;
  name: string;
  description?: string;
  keywords?: readonly string[];
  aliases?: readonly string[];
  category?: string;
  source?: string;
  order?: number;
}

interface RankedItem<T> {
  item: T;
  document: DiscoveryDocument;
  score: number;
}

export function normalizeDiscoveryText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function discoveryTokens(query: string): string[] {
  const normalized = normalizeDiscoveryText(query);
  return normalized ? normalized.split(" ") : [];
}

/** Locale-independent Unicode code-point ordering for deterministic final tie-breaks. */
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

function normalizedList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map(normalizeDiscoveryText).filter(Boolean);
}

function tokenScore(token: string, document: DiscoveryDocument): number {
  const id = normalizeDiscoveryText(document.id);
  const name = normalizeDiscoveryText(document.name);
  const description = normalizeDiscoveryText(document.description ?? "");
  const aliases = normalizedList(document.aliases);
  const keywords = normalizedList(document.keywords);

  if (id === token) return 1_000;
  if (aliases.includes(token)) return 950;
  if (id.startsWith(token)) return 850;
  if (name.startsWith(token)) return 800;
  if (name.includes(token)) return 700;
  if (aliases.some((alias) => alias.startsWith(token))) return 650;
  if (aliases.some((alias) => alias.includes(token))) return 625;
  if (keywords.includes(token)) return 600;
  if (keywords.some((keyword) => keyword.startsWith(token))) return 550;
  if (keywords.some((keyword) => keyword.includes(token))) return 500;
  if (id.includes(token)) return 450;
  if (description.includes(token)) return 200;
  return 0;
}

function relevance(query: string, document: DiscoveryDocument): number | null {
  const tokens = discoveryTokens(query);
  if (tokens.length === 0) return 0;
  let score = 0;
  for (const token of tokens) {
    const current = tokenScore(token, document);
    if (current === 0) return null;
    score += current;
  }

  const normalizedQuery = normalizeDiscoveryText(query);
  const name = normalizeDiscoveryText(document.name);
  if (name === normalizedQuery) score += 400;
  else if (name.startsWith(normalizedQuery)) score += 200;
  return score;
}

function compareText(left: string | undefined, right: string | undefined): number {
  return compareCodePoints(normalizeDiscoveryText(left ?? ""), normalizeDiscoveryText(right ?? ""));
}

function compareRecommended<T>(left: RankedItem<T>, right: RankedItem<T>): number {
  if (left.score !== right.score) return right.score - left.score;
  const order = (left.document.order ?? Number.MAX_SAFE_INTEGER)
    - (right.document.order ?? Number.MAX_SAFE_INTEGER);
  if (order !== 0) return order;
  return compareCodePoints(left.document.id, right.document.id);
}

function compareRanked<T>(sort: DiscoverySort, left: RankedItem<T>, right: RankedItem<T>): number {
  if (sort === "recommended") return compareRecommended(left, right);
  const primary = sort === "name"
    ? compareText(left.document.name, right.document.name)
    : sort === "category"
      ? compareText(left.document.category, right.document.category)
      : compareText(left.document.source, right.document.source);
  if (primary !== 0) return primary;

  const secondary = sort === "name"
    ? 0
    : compareText(left.document.name, right.document.name);
  if (secondary !== 0) return secondary;
  return compareCodePoints(left.document.id, right.document.id);
}

/** Filters with AND token matching, then returns a copied, deterministically sorted list. */
export function discoverItems<T>(
  items: readonly T[],
  query: string,
  documentFor: (item: T) => DiscoveryDocument,
  sort: DiscoverySort = "recommended",
): T[] {
  const ranked: RankedItem<T>[] = [];
  for (const item of items) {
    const document = documentFor(item);
    const score = relevance(query, document);
    if (score !== null) ranked.push({ item, document, score });
  }
  ranked.sort((left, right) => compareRanked(sort, left, right));
  return ranked.map(({ item }) => item);
}
