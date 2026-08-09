#!/usr/bin/env node
import { stat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ActionExecutionError,
  ActionExecutor,
  ActionRecipeError,
  ActionRegistry,
  runActionRecipe,
  validateActionRecipe,
} from "@useful/action-runtime";
import { AgentProfileError, loadAgentProfile } from "@useful/agent-profile/node";
import { createHostActionEntries, HostActionError, loadHostActionConfig } from "@useful/host-actions";
import { loadPluginConfig, PluginActionError } from "@useful/plugin-actions";

export const CLI_PROTOCOL_VERSION = "1.0";
export const EXIT_CODES = Object.freeze({
  OK: 0,
  USAGE_OR_INPUT: 2,
  UNKNOWN_ACTION: 3,
  POLICY_DENIED: 4,
  INTERRUPTED: 5,
  SIZE_LIMIT: 6,
  RUNTIME_FAILURE: 70,
});

const MAX_CLI_INPUT_BYTES = 16777216;

class CliError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function writeJson(value, stdout) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function usage(message = "用法: useful-runtime [--plugin-config <file>] [--host-config <file>] [--agent-profile <file>] actions <list|search|suggest|describe|run|recipe> ...") {
  throw new CliError("USAGE", message, EXIT_CODES.USAGE_OR_INPUT);
}

function exactFlags(args, flags) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!(name in flags)) usage(`未知参数: ${name}`);
    if (flags[name] === "boolean") {
      if (result[name]) usage(`重复参数: ${name}`);
      result[name] = true;
    } else {
      if (result[name] !== undefined) usage(`重复参数: ${name}`);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) usage(`参数 ${name} 缺少值`);
      result[name] = value;
      index += 1;
    }
  }
  return result;
}

function commaList(value, flag) {
  if (value === undefined) return undefined;
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.length || new Set(values).size !== values.length) usage(`${flag} 必须是无重复的逗号分隔值`);
  return values;
}

function booleanFlag(value, flag) {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  usage(`${flag} 只接受 true 或 false`);
}

function positiveInteger(value, flag) {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) usage(`${flag} 必须是正整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) usage(`${flag} 超出整数范围`);
  return parsed;
}

function boundedInteger(value, flag, minimum, maximum) {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) usage(`${flag} 必须是整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) usage(`${flag} 必须在 ${minimum}..${maximum} 范围内`);
  return parsed;
}

function searchOptions(flags) {
  const sort = ({ relevance: "relevance", "action-id": "actionId", title: "title", category: "category" })[flags["--sort"] ?? "relevance"];
  if (!sort) usage("--sort 只接受 relevance、action-id、title 或 category");
  const direction = flags["--direction"];
  if (direction !== undefined && !["asc", "desc"].includes(direction)) usage("--direction 只接受 asc 或 desc");
  return {
    query: flags["--query"] ?? "",
    filters: {
      ...(flags["--source"] ? { sourceKinds: commaList(flags["--source"], "--source") } : {}),
      ...(flags["--category"] ? { categories: commaList(flags["--category"], "--category") } : {}),
      ...(flags["--execution"] ? { executionModes: commaList(flags["--execution"], "--execution") } : {}),
      ...(flags["--read-only"] !== undefined ? { readOnly: booleanFlag(flags["--read-only"], "--read-only") } : {}),
      ...(flags["--idempotent"] !== undefined ? { idempotent: booleanFlag(flags["--idempotent"], "--idempotent") } : {}),
    },
    sort,
    ...(direction ? { direction } : {}),
    ...(flags["--limit"] ? { limit: positiveInteger(flags["--limit"], "--limit") } : {}),
    ...(flags["--cursor"] ? { cursor: flags["--cursor"] } : {}),
  };
}

async function readBoundedStdin(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CLI_INPUT_BYTES) throw new CliError("INPUT_TOO_LARGE", "stdin 超过 CLI 上限", EXIT_CODES.SIZE_LIMIT);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readInput(spec, stdin) {
  if (spec === undefined || spec === "-") return readBoundedStdin(stdin);
  if (!spec.startsWith("@") || spec.length === 1) usage("--input 只接受 @request.json 或 -（stdin）");
  const path = spec.slice(1);
  const metadata = await stat(path).catch((cause) => {
    throw new CliError("INPUT_FILE_UNREADABLE", "无法读取 input 文件", EXIT_CODES.USAGE_OR_INPUT, { cause });
  });
  if (!metadata.isFile()) throw new CliError("INPUT_FILE_UNREADABLE", "input 路径不是文件", EXIT_CODES.USAGE_OR_INPUT);
  if (metadata.size > MAX_CLI_INPUT_BYTES) throw new CliError("INPUT_TOO_LARGE", "input 文件超过 CLI 上限", EXIT_CODES.SIZE_LIMIT);
  return readFile(path, "utf8");
}

function parseJson(text) {
  try {
    // Windows PowerShell 5.1 通过管道调用原生进程时可能在开头写入一个或多个 UTF-8 BOM。
    // 只移除开头 BOM，不修复或放宽其他非法 JSON。
    return JSON.parse(text.replace(/^\uFEFF+/, ""));
  } catch (cause) {
    throw new CliError("INPUT_INVALID", "stdin/input 文件不是合法 JSON", EXIT_CODES.USAGE_OR_INPUT, { cause });
  }
}

function exitCodeFor(error) {
  if (error instanceof CliError) return error.exitCode;
  if (["ACTION_QUERY_INVALID", "ACTION_SUGGEST_INVALID"].includes(error?.code)) return EXIT_CODES.USAGE_OR_INPUT;
  if (error instanceof ActionRecipeError) {
    if (error.code === "ACTION_RECIPE_UNKNOWN_ACTION") return EXIT_CODES.UNKNOWN_ACTION;
    if (["ACTION_RECIPE_ACTION_NOT_ALLOWED", "ACTION_RECIPE_ALIAS_FORBIDDEN"].includes(error.code)) return EXIT_CODES.POLICY_DENIED;
    if ([
      "ACTION_RECIPE_TOO_LARGE",
      "ACTION_RECIPE_TEMPLATE_TOO_LARGE",
      "ACTION_RECIPE_EXPANSION_TOO_LARGE",
      "ACTION_RECIPE_INTERMEDIATE_TOO_LARGE",
    ].includes(error.code)) return EXIT_CODES.SIZE_LIMIT;
    return EXIT_CODES.USAGE_OR_INPUT;
  }
  if (error instanceof PluginActionError || error instanceof HostActionError || error instanceof AgentProfileError || error?.code === "ACTION_NAME_COLLISION") return EXIT_CODES.POLICY_DENIED;
  if (!(error instanceof ActionExecutionError)) return EXIT_CODES.RUNTIME_FAILURE;
  if (["INPUT_INVALID", "DESCRIPTOR_INVALID", "OUTPUT_INVALID"].includes(error.code)) return EXIT_CODES.USAGE_OR_INPUT;
  if (error.code === "UNKNOWN_ACTION") return EXIT_CODES.UNKNOWN_ACTION;
  if (["PERMISSION_DENIED", "CONFIRMATION_REQUIRED", "NOT_HEADLESS"].includes(error.code)) return EXIT_CODES.POLICY_DENIED;
  if (["TIMEOUT", "CANCELLED"].includes(error.code)) return EXIT_CODES.INTERRUPTED;
  if (["INPUT_TOO_LARGE", "OUTPUT_TOO_LARGE"].includes(error.code)) return EXIT_CODES.SIZE_LIMIT;
  return EXIT_CODES.RUNTIME_FAILURE;
}

function publicError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "RUNTIME_FAILURE",
    message: error instanceof ActionExecutionError || error instanceof ActionRecipeError || error instanceof CliError || error instanceof HostActionError || error instanceof AgentProfileError
      ? error.message
      : "runtime 内部错误",
    ...(Array.isArray(error?.issues) && error.issues.length ? { issues: error.issues } : {}),
  };
}

export async function main(argv = process.argv.slice(2), io = process) {
  try {
    let pluginConfig;
    let hostConfig;
    let agentProfile;
    while (argv[0]?.startsWith("--")) {
      const flag = argv[0];
      if (!["--plugin-config", "--host-config", "--agent-profile"].includes(flag)) usage(`未知全局参数: ${flag}`);
      if (!argv[1] || argv[1].startsWith("--")) usage(`${flag} 需要文件路径`);
      if (flag === "--plugin-config") {
        if (pluginConfig !== undefined) usage("重复参数: --plugin-config");
        pluginConfig = argv[1];
      } else if (flag === "--host-config") {
        if (hostConfig !== undefined) usage("重复参数: --host-config");
        hostConfig = argv[1];
      } else {
        if (agentProfile !== undefined) usage("重复参数: --agent-profile");
        agentProfile = argv[1];
      }
      argv = argv.slice(2);
    }
    const registry = new ActionRegistry();
    if (pluginConfig) {
      for (const entry of await loadPluginConfig(pluginConfig)) registry.register(entry);
    }
    const hostExecutionGrants = new Map();
    if (hostConfig) {
      const entries = createHostActionEntries(await loadHostActionConfig(hostConfig));
      for (const entry of entries) {
        registry.register(entry);
        hostExecutionGrants.set(entry.descriptor.actionId, Object.freeze({
          grantedPermissions: Object.freeze([...entry.descriptor.permissions.required]),
          grantedCapabilities: Object.freeze([...entry.descriptor.permissions.capabilities]),
        }));
      }
    }
    const exposure = agentProfile ? await loadAgentProfile(agentProfile, registry) : undefined;
    let cliRegistry = registry;
    if (exposure) {
      cliRegistry = new ActionRegistry([], { listOrder: "registration" });
      for (const descriptor of exposure.list("cli")) {
        const entry = registry.resolve(descriptor.actionId);
        if (!entry) throw new AgentProfileError("AGENT_PROFILE_UNKNOWN_ACTION");
        cliRegistry.register({ descriptor, handler: entry.handler });
      }
    }
    const executor = new ActionExecutor(registry);
    const [namespace, command, ...rest] = argv;
    if (namespace !== "actions") usage();

    if (command === "list") {
      const flags = exactFlags(rest, { "--json": "boolean" });
      if (!flags["--json"]) usage("actions list 要求 --json");
      writeJson({
        protocolVersion: CLI_PROTOCOL_VERSION,
        operation: "actions.list",
        actions: cliRegistry.list().map((descriptor) => ({
          actionId: descriptor.actionId,
          version: descriptor.version,
          title: descriptor.title,
          description: descriptor.description,
          aliases: descriptor.aliases,
          execution: descriptor.execution,
          behavior: descriptor.behavior,
        })),
      }, io.stdout);
      return EXIT_CODES.OK;
    }

    if (command === "search") {
      const flags = exactFlags(rest, {
        "--query": "value",
        "--sort": "value",
        "--direction": "value",
        "--source": "value",
        "--category": "value",
        "--execution": "value",
        "--read-only": "value",
        "--idempotent": "value",
        "--limit": "value",
        "--cursor": "value",
        "--json": "boolean",
      });
      if (!flags["--json"]) usage("actions search 要求 --json");
      const result = cliRegistry.query(searchOptions(flags));
      writeJson({
        protocolVersion: CLI_PROTOCOL_VERSION,
        operation: "actions.search",
        actions: result.actions.map((descriptor) => ({
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
        })),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      }, io.stdout);
      return EXIT_CODES.OK;
    }

    if (command === "suggest") {
      const flags = exactFlags(rest, {
        "--input": "value",
        "--limit": "value",
        "--minimum-score": "value",
        "--json": "boolean",
      });
      if (!flags["--json"]) usage("actions suggest 要求 --json");
      const text = await readInput(flags["--input"], io.stdin);
      const payload = cliRegistry.suggest(text, {
        ...(flags["--limit"] === undefined ? {} : { limit: boundedInteger(flags["--limit"], "--limit", 1, 20) }),
        ...(flags["--minimum-score"] === undefined ? {} : { minimumScore: boundedInteger(flags["--minimum-score"], "--minimum-score", 0, 1000) }),
      });
      writeJson({
        protocolVersion: CLI_PROTOCOL_VERSION,
        operation: "actions.suggest",
        ...payload,
      }, io.stdout);
      return EXIT_CODES.OK;
    }

    if (command === "describe") {
      const actionId = rest[0];
      if (!actionId || actionId.startsWith("--")) usage("actions describe <id> --json");
      const flags = exactFlags(rest.slice(1), { "--json": "boolean" });
      if (!flags["--json"]) usage("actions describe 要求 --json");
      const descriptor = exposure ? exposure.describe(actionId, "cli") : registry.describe(actionId);
      if (!descriptor) throw new ActionExecutionError("UNKNOWN_ACTION");
      writeJson({ protocolVersion: CLI_PROTOCOL_VERSION, operation: "actions.describe", action: descriptor }, io.stdout);
      return EXIT_CODES.OK;
    }

    if (command === "run") {
      const actionId = rest[0];
      if (!actionId || actionId.startsWith("--")) usage("actions run <id> [--input @file|-] [--confirm] --output json");
      const flags = exactFlags(rest.slice(1), { "--input": "value", "--output": "value", "--preset": "value", "--confirm": "boolean" });
      if ((flags["--output"] ?? "json") !== "json") usage("--output 目前只支持 json");
      if (flags["--preset"] !== undefined && !exposure) usage("--preset 要求显式 --agent-profile");
      const resolved = exposure ? exposure.resolve(actionId, "cli") : { actionId };
      const input = parseJson(await readInput(flags["--input"], io.stdin));
      const mergedInput = exposure ? exposure.applyPreset(resolved.actionId, flags["--preset"], input) : input;
      const canonicalActionId = registry.resolve(resolved.actionId)?.descriptor.actionId ?? resolved.actionId;
      const trustedGrants = hostExecutionGrants.get(canonicalActionId);
      const result = await executor.execute(resolved.actionId, mergedInput, {
        ...(trustedGrants ?? {}),
        confirmed: flags["--confirm"] === true,
      });
      writeJson({
        protocolVersion: CLI_PROTOCOL_VERSION,
        operation: "actions.run",
        ok: true,
        actionId: resolved.actionId,
        output: result.output,
        receipt: result.receipt,
      }, io.stdout);
      return EXIT_CODES.OK;
    }

    if (command === "recipe") {
      const flags = exactFlags(rest, {
        "--input": "value",
        "--output": "value",
        "--validate-only": "boolean",
      });
      if ((flags["--output"] ?? "json") !== "json") usage("--output 目前只支持 json");
      const recipe = parseJson(await readInput(flags["--input"], io.stdin));
      const payload = flags["--validate-only"]
        ? validateActionRecipe(recipe, cliRegistry)
        : await runActionRecipe(recipe, { registry: cliRegistry, executor });
      writeJson({
        protocolVersion: CLI_PROTOCOL_VERSION,
        operation: flags["--validate-only"] ? "actions.recipe.validate" : "actions.recipe.run",
        ok: true,
        ...payload,
      }, io.stdout);
      return EXIT_CODES.OK;
    }

    usage();
  } catch (error) {
    writeJson({
      protocolVersion: CLI_PROTOCOL_VERSION,
      operation: "error",
      ok: false,
      error: publicError(error),
      ...(error?.receipt ? { receipt: error.receipt } : {}),
    }, io.stdout);
    return exitCodeFor(error);
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) process.exitCode = await main();
