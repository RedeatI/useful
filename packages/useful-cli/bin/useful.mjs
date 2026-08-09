#!/usr/bin/env node
// Useful CLI 主入口：Agent-first create/doctor/validate/pack 与既有管理命令。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createServer } from "node:http";
// 注意：adm-zip 仅 pack 命令需要，改为 cmdPack 内动态 import，
// 使 key/app-update 等命令在未安装重依赖时也能运行（干净 clone 验证发现）。
import {
  createToolScaffold,
  doctorDataOrThrow,
  packToolDirectory,
  templateCatalog,
  validateToolDirectory,
} from "./agent-workflow.mjs";
import {
  CliError,
  exitCodeFor,
  failureEnvelope,
  successEnvelope,
  usageError,
  validationError,
  writeJson,
} from "./cli-contract.mjs";
import { agentContractData } from "./agent-contract-data.mjs";
import {
  AgentIntegrationError,
  doctorAgentIntegration,
  parseEnvironmentAssignments,
  planAgentIntegration,
} from "@useful/agent-integrations";
import {
  appUpdateCreate,
  appUpdateSign,
  appUpdateVerify,
  keyGenerateRole,
  keyInitRoot,
  keyInspect,
  keyRevoke,
  keyRotateRoot,
  keySignRoot,
  keyVerifyCeremony,
} from "./appupdate/appupdate.mjs";
// 注意：source.mjs 静态依赖 adm-zip/yaml，改为 sourceMain 内动态 import，
// 使 key/app-update 命令在仅装 node 时即可运行（干净 clone 验证发现）。

function readManifest(dir) {
  const p = path.join(dir, "manifest.json");
  if (!fs.existsSync(p)) {
    throw new Error(`未找到 manifest.json: ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function cmdDev(dir) {
  const manifest = readManifest(dir);
  const port = Number(process.env.PORT ?? 5178);
  const server = createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(dir, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
    if (!filePath.startsWith(dir)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { "content-type": guessMime(filePath) });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(port, () => {
    console.log(`✓ 开发服务器: http://localhost:${port} （工具 ${manifest.id}）`);
    console.log("  按 Ctrl+C 停止。");
  });
}

function guessMime(f) {
  const ext = path.extname(f).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    }[ext] ?? "application/octet-stream"
  );
}

function parseStrictArgs(args, allowedOptions) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    const name = value.slice(2, equals >= 0 ? equals : undefined);
    if (!allowedOptions.has(name)) throw usageError("UNKNOWN_FLAG", `未知选项: --${name}`, { option: name });
    if (name === "json") {
      if (equals >= 0) throw usageError("INVALID_FLAG_VALUE", "--json 不接受值", { option: "json" });
      options.json = true;
      continue;
    }
    const optionValue = equals >= 0 ? value.slice(equals + 1) : args[++index];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError("MISSING_OPTION_VALUE", `--${name} 需要值`, { option: name });
    }
    options[name] = optionValue;
  }
  return { options, positional };
}

function requirePositionals(positional, min, max, usage) {
  if (positional.length < min || positional.length > max) {
    throw usageError("INVALID_ARGUMENTS", usage, { positionalCount: positional.length });
  }
}

function printHumanChecks(result) {
  for (const check of result.checks) {
    const marker = check.status === "pass" ? "✓" : check.status === "warning" ? "!" : "✗";
    const stream = check.status === "fail" ? console.error : console.log;
    stream(`${marker} ${check.id}: ${check.message}`);
  }
}

async function agentCommand(cmd, rest, jsonMode) {
  if (cmd === "agent-contract") {
    const { options, positional } = parseStrictArgs(rest, new Set(["json"]));
    requirePositionals(positional, 0, 0, "用法: useful agent-contract --json");
    if (!options.json) throw usageError("JSON_REQUIRED", "agent-contract 仅提供 --json 输出");
    return agentContractData(templateCatalog());
  }
  if (cmd === "create") {
    const { options, positional } = parseStrictArgs(rest, new Set(["id", "name", "display-name", "description", "template", "json"]));
    requirePositionals(positional, 1, 1, "用法: useful create <目录> [typed options] [--json]");
    const result = createToolScaffold(positional[0], {
      id: options.id,
      displayName: options["display-name"] ?? options.name,
      description: options.description,
      template: options.template ?? "minimal-web",
    });
    if (!jsonMode) console.log(`✓ 已创建工具: ${result.directory}`);
    return result;
  }
  if (cmd === "doctor" || cmd === "validate") {
    const { positional } = parseStrictArgs(rest, new Set(["json"]));
    requirePositionals(positional, 1, 1, `用法: useful ${cmd} <目录> [--json]`);
    try {
      const result = cmd === "doctor" ? await doctorDataOrThrow(positional[0]) : await validateToolDirectory(positional[0]);
      if (!jsonMode) printHumanChecks(result);
      return result;
    } catch (error) {
      if (!jsonMode && error instanceof CliError && error.data?.checks) printHumanChecks(error.data);
      throw error;
    }
  }
  if (cmd === "pack") {
    const { positional } = parseStrictArgs(rest, new Set(["json"]));
    requirePositionals(positional, 1, 2, "用法: useful pack <目录> [输出目录] [--json]");
    const result = await packToolDirectory(positional[0], positional[1]);
    if (!jsonMode) console.log(`✓ 已打包: ${result.artifactPath}`);
    return result;
  }
  return null;
}

function parseAgentIntegrationArgs(args) {
  const options = { environment: [] };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      throw usageError("INVALID_ARGUMENTS", "agent 子命令不接受位置参数", { value });
    }
    const equals = value.indexOf("=");
    const name = value.slice(2, equals >= 0 ? equals : undefined);
    if (name === "apply" || name === "install") {
      throw usageError("APPLY_NOT_SUPPORTED", "V1 只生成和诊断配置，拒绝写入或安装", { option: name });
    }
    if (name !== "env" && seen.has(name)) {
      throw usageError("DUPLICATE_FLAG", `--${name} 只能提供一次`, { option: name });
    }
    if (name !== "env") seen.add(name);
    if (name === "json") {
      if (equals >= 0) throw usageError("INVALID_FLAG_VALUE", "--json 不接受值", { option: name });
      options.json = true;
      continue;
    }
    if (!new Set(["target", "launcher", "scope", "project-dir", "env"]).has(name)) {
      throw usageError("UNKNOWN_FLAG", `未知选项: --${name}`, { option: name });
    }
    const optionValue = equals >= 0 ? value.slice(equals + 1) : args[++index];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError("MISSING_OPTION_VALUE", `--${name} 需要值`, { option: name });
    }
    if (name === "env") options.environment.push(optionValue);
    else options[name] = optionValue;
  }
  return options;
}

function asCliIntegrationError(error) {
  if (error instanceof AgentIntegrationError) {
    return validationError(error.code, error.message, error.details);
  }
  return error;
}

async function agentIntegrationCommand(rest) {
  const [subcommand, ...args] = rest;
  if (subcommand !== "plan" && subcommand !== "doctor") {
    throw usageError("UNKNOWN_AGENT_COMMAND", "用法: useful agent <plan|doctor> --target <target> --launcher <绝对路径> [--scope user|project] [--project-dir <绝对目录>] [--env NAME=VALUE] --json", { subcommand: subcommand ?? null });
  }
  const options = parseAgentIntegrationArgs(args);
  if (!options.json) {
    throw usageError("JSON_REQUIRED", "agent plan/doctor 仅提供 --json 输出", { subcommand });
  }
  try {
    const input = {
      target: options.target,
      launcher: options.launcher,
      scope: options.scope ?? "user",
      projectDirectory: options["project-dir"],
      environment: parseEnvironmentAssignments(options.environment),
    };
    if (subcommand === "plan") return planAgentIntegration(input);
    const result = doctorAgentIntegration(input);
    if (!result.ok) {
      throw validationError(
        "AGENT_INTEGRATION_DOCTOR_FAILED",
        "Agent 集成诊断未通过",
        { failedChecks: result.checks.filter((check) => check.status === "fail").map((check) => check.id) },
        { schemaVersion: result.schemaVersion, ok: false, checks: result.checks },
      );
    }
    return result;
  } catch (error) {
    throw asCliIntegrationError(error);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const jsonMode = process.argv.slice(2).includes("--json");
  const agentCommands = new Set(["create", "doctor", "validate", "pack", "agent-contract"]);
  if (jsonMode && !agentCommands.has(cmd) && cmd !== "publisher" && cmd !== "agent") {
    throw usageError("JSON_UNSUPPORTED", `命令 ${cmd ?? "<none>"} 不支持 --json`, { command: cmd ?? null });
  }
  if (cmd === "agent") {
    const data = await agentIntegrationCommand(rest);
    writeJson(successEnvelope(`agent ${rest[0]}`, data));
    return;
  }
  if (agentCommands.has(cmd)) {
    const data = await agentCommand(cmd, rest, jsonMode);
    if (jsonMode) writeJson(successEnvelope(cmd, data));
    return;
  }
  if (cmd === "source") {
    return sourceMain(rest);
  }
  if (cmd === "key") {
    return keyMain(rest);
  }
  if (cmd === "app-update") {
    return appUpdateMain(rest);
  }
  if (cmd === "publisher") {
    return import("./publisher/publisher.mjs").then(({ publisherMain }) => publisherMain(rest));
  }
  const dir = path.resolve(rest[0] ?? ".");
  switch (cmd) {
    case "dev":
      cmdDev(dir);
      break;
    default:
      if (cmd) throw usageError("UNKNOWN_COMMAND", `未知命令: ${cmd}`, { command: cmd });
      console.log("用法: useful <create|doctor|dev|validate|pack|agent-contract|agent> ...，或 useful <source|publisher|key|app-update> <子命令>");
  }
}

/** 解析 --key value / --key=value 选项。 */
function parseOpts(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        // 布尔标志：后面无值或下一个也是 --flag 时视为 true
        if (next === undefined || next.startsWith("--")) {
          opts[a.slice(2)] = true;
        } else {
          opts[a.slice(2)] = next;
          i += 1;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

async function sourceMain(rest) {
  const {
    cmdAddPackage,
    cmdExportStatic,
    cmdInit,
    cmdPublish,
    cmdRemovePackage,
    cmdRotateRoot,
    cmdServe,
    cmdValidate: cmdSourceValidate,
  } = await import("./source/source.mjs");
  const [sub, ...args] = rest;
  const { opts, positional } = parseOpts(args);
  const dir = path.resolve(positional[0] ?? ".");
  try {
    switch (sub) {
      case "init":
        cmdInit(dir, opts);
        break;
      case "add-package":
        cmdAddPackage(dir, path.resolve(positional[1] ?? ""), opts);
        break;
      case "remove-package":
        cmdRemovePackage(dir, positional[1], positional[2]);
        break;
      case "publish":
        cmdPublish(dir);
        break;
      case "rotate-root":
        cmdRotateRoot(dir);
        break;
      case "export-static":
        cmdExportStatic(dir, path.resolve(positional[1] ?? "./dist-source"));
        break;
      case "validate":
        await cmdSourceValidate(dir);
        break;
      case "serve":
        cmdServe(dir, opts.port ? Number(opts.port) : undefined);
        break;
      default:
        console.log(
          "用法: useful source <init|add-package|remove-package|publish|rotate-root|export-static|validate|serve> [目录] [参数]",
        );
        process.exit(sub ? 1 : 0);
    }
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

// ---------- key / app-update 子命令 ----------
function keyMain(rest) {
  const [sub, ...args] = rest;
  const { opts, positional } = parseOpts(args);
  const dir = path.resolve(positional[0] ?? ".");
  try {
    switch (sub) {
      case "init-root":
        keyInitRoot(dir, opts);
        break;
      case "generate-role":
        keyGenerateRole(dir, opts);
        break;
      case "sign-root":
        keySignRoot(dir, opts);
        break;
      case "rotate-root":
        keyRotateRoot(dir);
        break;
      case "revoke":
        keyRevoke(dir, opts);
        break;
      case "inspect":
        keyInspect(dir);
        break;
      case "verify-ceremony":
        process.exit(keyVerifyCeremony(dir, opts));
        break;
      default:
        console.log(
          "用法: useful key <init-root|generate-role|sign-root|rotate-root|revoke|inspect|verify-ceremony> [目录] [参数]",
        );
        process.exit(sub ? 1 : 0);
    }
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

function appUpdateMain(rest) {
  const [sub, ...args] = rest;
  const { opts, positional } = parseOpts(args);
  const file = path.resolve(positional[0] ?? "./update.json");
  try {
    switch (sub) {
      case "create":
        appUpdateCreate(file, opts);
        break;
      case "sign":
        appUpdateSign(file, opts);
        break;
      case "verify":
        process.exit(appUpdateVerify(file, opts));
        break;
      default:
        console.log("用法: useful app-update <create|sign|verify> [manifest 路径] [参数]");
        process.exit(sub ? 1 : 0);
    }
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

const rawArguments = process.argv.slice(2);
const jsonMode = rawArguments.includes("--json");
const compoundCommand = (rawArguments[0] === "publisher" || rawArguments[0] === "agent") && rawArguments[1];
const commandLabel = compoundCommand
  ? `${rawArguments[0]} ${rawArguments[1]}`
  : rawArguments[0] ?? "help";

try {
  await main();
} catch (error) {
  if (jsonMode) {
    writeJson(failureEnvelope(commandLabel, error));
  } else {
    const prefix = error instanceof CliError ? error.code : "INTERNAL_ERROR";
    console.error(`✗ ${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = exitCodeFor(error);
}
