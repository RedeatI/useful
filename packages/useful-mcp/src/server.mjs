import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import {
  ActionExecutionError,
  ActionExecutor,
  ActionRecipeError,
  ActionRegistry,
  ERROR_CODES,
  runActionRecipe,
  validateActionRecipe,
} from "@useful/action-runtime";

export const MCP_SERVER_INFO = Object.freeze({
  name: "useful-actions",
  version: "0.1.0",
});

export const DISCOVERY_TOOL_NAMES = Object.freeze({
  SEARCH: "useful.actions.search",
  DESCRIBE: "useful.actions.describe",
  SUGGEST: "useful.actions.suggest",
  RECIPE: "useful.actions.recipe",
});

const discoveryInputSchemas = Object.freeze({
  search: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", maxLength: 512 },
      sort: { type: "string", enum: ["relevance", "actionId", "title", "category"] },
      direction: { type: "string", enum: ["asc", "desc"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", maxLength: 64 },
      filters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceKinds: { type: "array", uniqueItems: true, maxItems: 3, items: { type: "string", enum: ["builtin", "plugin", "local"] } },
          categories: { type: "array", uniqueItems: true, maxItems: 32, items: { type: "string", maxLength: 128 } },
          executionModes: { type: "array", uniqueItems: true, maxItems: 4, items: { type: "string", enum: ["pure", "host", "worker", "ui-only"] } },
          readOnly: { type: "boolean" },
          idempotent: { type: "boolean" },
        },
      },
    },
  },
  describe: {
    type: "object",
    additionalProperties: false,
    required: ["actionId"],
    properties: { actionId: { type: "string", minLength: 3, maxLength: 200 } },
  },
  suggest: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: {
        type: "string",
        maxLength: 65536,
        description: "Explicit local sample; runtime enforcement is 65,536 UTF-8 bytes and the sample is never echoed.",
      },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      minimumScore: { type: "integer", minimum: 0, maximum: 1000 },
    },
  },
  recipe: {
    type: "object",
    additionalProperties: false,
    required: ["operation", "recipe"],
    properties: {
      operation: { type: "string", enum: ["validate", "run"] },
      recipe: {
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "steps", "output"],
        properties: {
          schemaVersion: { type: "string", const: "useful.action-recipe.v1" },
          input: {},
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "actionId", "input"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 32 },
                actionId: { type: "string", minLength: 3, maxLength: 200 },
                input: {},
              },
            },
          },
          output: {},
        },
      },
    },
  },
});

const noExecutionPolicy = () => undefined;

function executionOptions(decision, signal) {
  const options = { signal };
  if (decision === undefined) return options;
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) throw new TypeError("MCP_EXECUTION_POLICY_INVALID");
  const allowedKeys = new Set(["grantedPermissions", "grantedCapabilities", "confirmed"]);
  if (Object.keys(decision).some((key) => !allowedKeys.has(key))) throw new TypeError("MCP_EXECUTION_POLICY_INVALID");
  for (const name of ["grantedPermissions", "grantedCapabilities"]) {
    if (decision[name] === undefined) continue;
    if (!Array.isArray(decision[name]) || new Set(decision[name]).size !== decision[name].length || decision[name].some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new TypeError("MCP_EXECUTION_POLICY_INVALID");
    }
    options[name] = [...decision[name]];
  }
  if (decision.confirmed !== undefined) {
    if (typeof decision.confirmed !== "boolean") throw new TypeError("MCP_EXECUTION_POLICY_INVALID");
    options.confirmed = decision.confirmed;
  }
  return options;
}

function safeValidator(validator, errorCode) {
  return {
    getValidator(schema) {
      const validate = validator.getValidator(schema);
      return (input) => {
        const result = validate(input);
        return result.valid
          ? result
          : { valid: false, data: undefined, errorMessage: errorCode };
      };
    },
  };
}

export function descriptorToToolMetadata(descriptor) {
  return {
    name: descriptor.actionId,
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: structuredClone(descriptor.inputSchema),
    outputSchema: structuredClone(descriptor.outputSchema),
    annotations: {
      readOnlyHint: descriptor.behavior.readOnly,
      destructiveHint: descriptor.behavior.destructive,
      idempotentHint: descriptor.behavior.idempotent,
      openWorldHint: descriptor.behavior.openWorld,
    },
  };
}

function errorResult(error) {
  const safeError = error instanceof ActionExecutionError
    ? error
    : new ActionExecutionError(ERROR_CODES.ACTION_FAILED);
  const payload = {
    error: {
      code: safeError.code,
      message: safeError.message,
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function discoveryError(code) {
  const payload = { error: { code, message: code } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function actionSummary(descriptor) {
  return {
    actionId: descriptor.actionId,
    version: descriptor.version,
    title: descriptor.title,
    description: descriptor.description,
    keywords: descriptor.keywords,
    aliases: descriptor.aliases,
    source: descriptor.source,
    presentation: descriptor.presentation,
    execution: descriptor.execution,
    behavior: descriptor.behavior,
  };
}

function registerDiscoveryTools(server, registry, executor, validator, seenNames) {
  const register = (name, definition, handler) => {
    if (seenNames.has(name) || registry.describe(name)) throw new TypeError("MCP tool name collision");
    seenNames.add(name);
    server.registerTool(name, definition, handler);
  };
  register(
    DISCOVERY_TOOL_NAMES.SEARCH,
    {
      title: "Search Useful actions",
      description: "Search only the actions exposed by this Useful runtime/profile, with deterministic ranking, filters, ordering, and pagination.",
      inputSchema: fromJsonSchema(discoveryInputSchemas.search, safeValidator(validator, ERROR_CODES.INPUT_INVALID)),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const result = registry.query(input);
        const payload = {
          actions: result.actions.map(actionSummary),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
        return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (error) {
        return discoveryError(error?.code === "ACTION_QUERY_INVALID" ? error.code : ERROR_CODES.ACTION_FAILED);
      }
    },
  );
  register(
    DISCOVERY_TOOL_NAMES.DESCRIBE,
    {
      title: "Describe a Useful action",
      description: "Return the complete descriptor for one action exposed by this Useful runtime/profile.",
      inputSchema: fromJsonSchema(discoveryInputSchemas.describe, safeValidator(validator, ERROR_CODES.INPUT_INVALID)),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ actionId }) => {
      const descriptor = registry.describe(actionId);
      if (!descriptor) return discoveryError(ERROR_CODES.UNKNOWN_ACTION);
      const payload = { action: descriptor };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  );
  register(
    DISCOVERY_TOOL_NAMES.SUGGEST,
    {
      title: "Suggest Useful actions",
      description: "Inspect an explicit bounded text sample locally and suggest actions exposed by this runtime/profile. The sample is never returned in the result.",
      inputSchema: fromJsonSchema(discoveryInputSchemas.suggest, safeValidator(validator, ERROR_CODES.INPUT_INVALID)),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ text, limit, minimumScore }) => {
      try {
        const payload = registry.suggest(text, {
          ...(limit === undefined ? {} : { limit }),
          ...(minimumScore === undefined ? {} : { minimumScore }),
        });
        return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (error) {
        return discoveryError(error?.code === "ACTION_SUGGEST_INVALID" ? error.code : ERROR_CODES.ACTION_FAILED);
      }
    },
  );
  register(
    DISCOVERY_TOOL_NAMES.RECIPE,
    {
      title: "Validate or run a Useful action recipe",
      description: "Validate or run a bounded, ordered recipe using only currently exposed deterministic, no-permission actions. Recipes support JSON Pointer references, not scripts or string interpolation.",
      inputSchema: fromJsonSchema(discoveryInputSchemas.recipe, safeValidator(validator, ERROR_CODES.INPUT_INVALID)),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation, recipe }, context) => {
      try {
        const payload = operation === "validate"
          ? validateActionRecipe(recipe, registry)
          : await runActionRecipe(recipe, { registry, executor, signal: context?.mcpReq?.signal });
        return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (error) {
        if (error instanceof ActionExecutionError) return errorResult(error);
        return discoveryError(error instanceof ActionRecipeError ? error.code : ERROR_CODES.ACTION_FAILED);
      }
    },
  );
}

export function createActionToolHandler(actionId, executor, executionPolicy = noExecutionPolicy, descriptor) {
  return async (input, context) => {
    try {
      const decision = await executionPolicy(Object.freeze({
        actionId,
        surface: "mcp",
        ...(descriptor ? { descriptor: structuredClone(descriptor) } : {}),
      }));
      const result = await executor.execute(actionId, input, executionOptions(
        decision,
        context?.mcpReq?.signal,
      ));
      return {
        structuredContent: result.output,
        content: [{ type: "text", text: JSON.stringify(result.output) }],
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function buildServer(options = {}) {
  const registry = options.registry ?? new ActionRegistry();
  const executor = options.executor ?? new ActionExecutor(registry);
  const validator = options.validator ?? new AjvJsonSchemaValidator();
  const executionPolicy = options.executionPolicy ?? noExecutionPolicy;
  if (typeof executionPolicy !== "function") throw new TypeError("MCP_EXECUTION_POLICY_INVALID");
  const server = new McpServer(MCP_SERVER_INFO, {
    jsonSchemaValidator: validator,
  });
  const seenNames = new Set();

  for (const descriptor of registry.listAgentEligible()) {
    const tool = descriptorToToolMetadata(descriptor);
    if (seenNames.has(tool.name)) {
      throw new TypeError("MCP tool name collision");
    }
    seenNames.add(tool.name);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(
          tool.inputSchema,
          safeValidator(validator, ERROR_CODES.INPUT_INVALID),
        ),
        outputSchema: fromJsonSchema(
          tool.outputSchema,
          safeValidator(validator, ERROR_CODES.OUTPUT_INVALID),
        ),
        annotations: tool.annotations,
      },
      createActionToolHandler(tool.name, executor, executionPolicy, descriptor),
    );
  }

  registerDiscoveryTools(server, registry, executor, validator, seenNames);

  return server;
}
