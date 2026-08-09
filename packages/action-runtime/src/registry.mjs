import { assertActionDescriptor } from "@useful/action-contract";
import { BUILTIN_ACTIONS } from "./builtins.mjs";
import { suggestActions } from "./action-suggest.mjs";
import { compareCodePoints } from "./utility-actions.mjs";

const QUERY_SORTS = new Set(["relevance", "actionId", "title", "category"]);
const QUERY_DIRECTIONS = new Set(["asc", "desc"]);
const SOURCE_KINDS = new Set(["builtin", "plugin", "local"]);
const EXECUTION_MODES = new Set(["pure", "host", "worker", "ui-only"]);

function queryError() {
  const error = new TypeError("Action query 无效");
  error.code = "ACTION_QUERY_INVALID";
  throw error;
}

function normalizeSearchText(value) {
  return String(value).normalize("NFKC").toLowerCase();
}

function validateStringFilter(value, allowed, maxItems = 32) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value)
    || value.length > maxItems
    || new Set(value).size !== value.length
    || value.some((entry) => typeof entry !== "string" || entry.length === 0 || (allowed && !allowed.has(entry)))
  ) queryError();
  return new Set(value);
}

function tokenRelevance(descriptor, query) {
  const actionId = normalizeSearchText(descriptor.actionId);
  const aliases = descriptor.aliases.map(normalizeSearchText);
  const title = normalizeSearchText(descriptor.title);
  const keywords = descriptor.keywords.map(normalizeSearchText);
  const description = normalizeSearchText(descriptor.description);
  if (actionId === query) return 1000;
  if (aliases.includes(query)) return 900;
  if (actionId.startsWith(query)) return 800;
  if (aliases.some((entry) => entry.startsWith(query))) return 700;
  if (title === query) return 650;
  if (keywords.includes(query)) return 600;
  if (title.includes(query)) return 500;
  if (keywords.some((entry) => entry.includes(query))) return 450;
  if (actionId.includes(query) || aliases.some((entry) => entry.includes(query))) return 400;
  if (description.includes(query)) return 100;
  return -1;
}

function relevance(descriptor, query, tokens) {
  if (!tokens.length) return 0;
  const scores = tokens.map((token) => tokenRelevance(descriptor, token));
  if (scores.some((score) => score < 0)) return -1;
  const title = normalizeSearchText(descriptor.title);
  const description = normalizeSearchText(descriptor.description);
  const phraseBonus = title.includes(query) ? 75 : description.includes(query) ? 25 : 0;
  return scores.reduce((total, score) => total + score, 0) + phraseBonus;
}

export class ActionRegistry {
  #entries = new Map();
  #names = new Map();
  #listOrder;

  constructor(entries = BUILTIN_ACTIONS, options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => key !== "listOrder")
      || ![undefined, "actionId", "registration"].includes(options.listOrder)) {
      const error = new TypeError("ActionRegistry options 无效");
      error.code = "ACTION_REGISTRY_OPTIONS_INVALID";
      throw error;
    }
    this.#listOrder = options.listOrder ?? "actionId";
    for (const entry of entries) this.register(entry);
  }

  register({ descriptor, handler }) {
    assertActionDescriptor(descriptor);
    const names = [descriptor.actionId, ...descriptor.aliases];
    if (new Set(names).size !== names.length) {
      const error = new TypeError("actionId 或 alias 冲突");
      error.code = "ACTION_NAME_COLLISION";
      throw error;
    }
    for (const name of names) {
      if (this.#names.has(name)) {
        const error = new TypeError("actionId 或 alias 冲突");
        error.code = "ACTION_NAME_COLLISION";
        throw error;
      }
    }
    if (descriptor.execution.mode !== "ui-only" && typeof handler !== "function") {
      throw new TypeError(`headless action 缺少 handler: ${descriptor.actionId}`);
    }
    if (descriptor.execution.mode === "ui-only" && handler !== undefined) {
      throw new TypeError(`ui-only action 不得注册 handler: ${descriptor.actionId}`);
    }
    const entry = Object.freeze({ descriptor: structuredClone(descriptor), handler });
    this.#entries.set(descriptor.actionId, entry);
    for (const name of names) this.#names.set(name, entry);
  }

  list() {
    const descriptors = [...this.#entries.values()]
      .map((entry) => structuredClone(entry.descriptor));
    return this.#listOrder === "registration"
      ? descriptors
      : descriptors.sort((left, right) => compareCodePoints(left.actionId, right.actionId));
  }

  describe(actionId) {
    const entry = this.#names.get(actionId);
    return entry ? structuredClone(entry.descriptor) : undefined;
  }

  resolve(actionId) {
    return this.#names.get(actionId);
  }

  listAgentEligible() {
    return this.list().filter((descriptor) => descriptor.execution.mode !== "ui-only");
  }

  query(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) queryError();
    const allowedKeys = new Set(["query", "filters", "sort", "direction", "limit", "cursor"]);
    if (Object.keys(options).some((key) => !allowedKeys.has(key))) queryError();
    const searchText = options.query === undefined ? "" : typeof options.query === "string" ? normalizeSearchText(options.query.trim()) : queryError();
    if (searchText.length > 512 || searchText.includes("\0")) queryError();
    const searchTokens = searchText.split(/\s+/u).filter(Boolean);
    if (searchTokens.length > 32) queryError();
    const sort = options.sort ?? (searchText ? "relevance" : "actionId");
    const direction = options.direction ?? (sort === "relevance" ? "desc" : "asc");
    const limit = options.limit ?? 50;
    if (!QUERY_SORTS.has(sort) || !QUERY_DIRECTIONS.has(direction) || !Number.isInteger(limit) || limit < 1 || limit > 100) queryError();

    const filters = options.filters ?? {};
    if (filters === null || typeof filters !== "object" || Array.isArray(filters)) queryError();
    const filterKeys = new Set(["sourceKinds", "categories", "executionModes", "readOnly", "idempotent"]);
    if (Object.keys(filters).some((key) => !filterKeys.has(key))) queryError();
    const sourceKinds = validateStringFilter(filters.sourceKinds, SOURCE_KINDS, SOURCE_KINDS.size);
    const categories = validateStringFilter(filters.categories);
    const executionModes = validateStringFilter(filters.executionModes, EXECUTION_MODES, EXECUTION_MODES.size);
    if (filters.readOnly !== undefined && typeof filters.readOnly !== "boolean") queryError();
    if (filters.idempotent !== undefined && typeof filters.idempotent !== "boolean") queryError();

    let offset = 0;
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== "string" || !/^v1:(?:0|[1-9]\d*)$/.test(options.cursor)) queryError();
      offset = Number(options.cursor.slice(3));
      if (!Number.isSafeInteger(offset)) queryError();
    }

    const ranked = this.list().map((descriptor) => ({ descriptor, score: relevance(descriptor, searchText, searchTokens) }))
      .filter(({ descriptor, score }) => score >= 0
        && (!sourceKinds || sourceKinds.has(descriptor.source.kind))
        && (!categories || categories.has(descriptor.presentation?.category ?? ""))
        && (!executionModes || executionModes.has(descriptor.execution.mode))
        && (filters.readOnly === undefined || descriptor.behavior.readOnly === filters.readOnly)
        && (filters.idempotent === undefined || descriptor.behavior.idempotent === filters.idempotent));

    const field = (entry) => sort === "title" ? entry.descriptor.title
      : sort === "category" ? entry.descriptor.presentation?.category ?? ""
        : entry.descriptor.actionId;
    ranked.sort((left, right) => {
      let result = sort === "relevance" ? left.score - right.score : compareCodePoints(field(left), field(right));
      if (direction === "desc") result *= -1;
      return result || compareCodePoints(left.descriptor.actionId, right.descriptor.actionId);
    });

    if (offset > ranked.length) queryError();
    const page = ranked.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      actions: page.map(({ descriptor }) => structuredClone(descriptor)),
      ...(nextOffset < ranked.length ? { nextCursor: `v1:${nextOffset}` } : {}),
    };
  }

  search(query, options = {}) {
    if (typeof query !== "string" || options === null || typeof options !== "object" || Array.isArray(options)) queryError();
    return this.query({ ...options, query });
  }

  suggest(text, options = {}) {
    return suggestActions(this.listAgentEligible(), text, options);
  }
}
