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
  securityError,
  successEnvelope,
  usageError,
  validationError,
  writeJson,
} from "./cli-contract.mjs";
import { agentContractData } from "./agent-contract-data.mjs";
import { AgentSelfProbeError, runAgentSelfProbe } from "./agent-probe.mjs";
import {
  AgentConnectionVerifyError,
  runAgentConnectionVerification,
} from "./agent-connection-verify.mjs";
import { runAgentConnectionVerificationSet } from "./agent-connection-verify-all.mjs";
import { ComputerUseProbeError, runComputerUseProbe } from "./computer-use-probe.mjs";
import {
  AgentIntegrationError,
  doctorAgentIntegration,
  exportAgentIntegration,
  parseEnvironmentAssignments,
  planAgentIntegration,
} from "@useful/agent-integrations";
import { AgentConnectionError } from "@useful/protocol/agent-connection";
import { AgentConnectionVerificationError } from "@useful/protocol/agent-connection-verification";
import { AgentConnectionVerificationSetError } from "@useful/protocol/agent-connection-verification-set";
import { AgentProbeProtocolError } from "@useful/protocol/agent-probe";
import { ComputerUseProbeProtocolError } from "@useful/protocol/computer-use-probe";
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
  const unsupportedWriteOptions = new Set([
    "apply",
    "install",
    "out",
    "output",
    "output-file",
    "output-path",
    "config-file",
    "config-path",
    "config",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      throw usageError("INVALID_ARGUMENTS", "agent 子命令不接受位置参数", { value });
    }
    const equals = value.indexOf("=");
    const name = value.slice(2, equals >= 0 ? equals : undefined);
    if (unsupportedWriteOptions.has(name)) {
      const code = name === "apply" || name === "install" ? "APPLY_NOT_SUPPORTED" : "OUTPUT_PATH_NOT_SUPPORTED";
      throw usageError(code, "V1 只向 stdout 生成配置，拒绝写入、安装或接受输出路径", { option: name });
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

function parseAgentVerifyAllArgs(args) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      throw usageError("INVALID_ARGUMENTS", "agent verify-all 不接受位置参数", { value });
    }
    const equals = value.indexOf("=");
    const name = value.slice(2, equals >= 0 ? equals : undefined);
    if (name !== "launcher" && name !== "json") {
      throw usageError("UNKNOWN_FLAG", `未知选项: --${name}`, { option: name });
    }
    if (seen.has(name)) {
      throw usageError("DUPLICATE_FLAG", `--${name} 只能提供一次`, { option: name });
    }
    seen.add(name);
    if (name === "json") {
      if (equals >= 0) throw usageError("INVALID_FLAG_VALUE", "--json 不接受值", { option: name });
      options.json = true;
      continue;
    }
    const optionValue = equals >= 0 ? value.slice(equals + 1) : args[++index];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError("MISSING_OPTION_VALUE", `--${name} 需要值`, { option: name });
    }
    options.launcher = optionValue;
  }
  if (!Object.hasOwn(options, "launcher")) {
    throw usageError("MISSING_REQUIRED_OPTION", "agent verify-all 要求显式 --launcher", { option: "launcher" });
  }
  return options;
}

function asCliIntegrationError(error) {
  if (error instanceof AgentIntegrationError || error instanceof AgentConnectionError) {
    return validationError(error.code, error.message, error.details);
  }
  return error;
}

function asCliProbeError(error) {
  if (error instanceof AgentSelfProbeError) {
    const factory = error.exitCode === 4 ? securityError : validationError;
    return factory(error.code, error.message, error.details);
  }
  if (error instanceof AgentProbeProtocolError) {
    return validationError(error.code, error.message, error.details);
  }
  return error;
}

function asCliConnectionVerificationError(error) {
  if (error instanceof AgentConnectionVerifyError) {
    const factory = error.exitCode === 4 ? securityError : validationError;
    return factory(error.code, error.message, error.details);
  }
  if (error instanceof AgentConnectionVerificationError || error instanceof AgentConnectionVerificationSetError) {
    return validationError(error.code, error.message, error.details);
  }
  const probeError = asCliProbeError(error);
  if (probeError !== error) return probeError;
  return asCliIntegrationError(error);
}

function asCliComputerUseProbeError(error) {
  if (error instanceof ComputerUseProbeError || error instanceof ComputerUseProbeProtocolError) {
    return validationError(error.code, error.message, error.details);
  }
  return asCliProbeError(error);
}

async function agentIntegrationCommand(rest) {
  const [subcommand, ...args] = rest;
  if (subcommand === "probe") {
    const { options, positional } = parseStrictArgs(args, new Set(["json"]));
    requirePositionals(positional, 0, 0, "用法: useful agent probe --json");
    if (args.filter((value) => value === "--json").length > 1) {
      throw usageError("DUPLICATE_FLAG", "--json 只能提供一次", { option: "json" });
    }
    if (!options.json) throw usageError("JSON_REQUIRED", "agent probe 仅提供 --json 输出", { subcommand });
    try {
      return await runAgentSelfProbe();
    } catch (error) {
      throw asCliProbeError(error);
    }
  }
  if (subcommand === "verify-all") {
    const options = parseAgentVerifyAllArgs(args);
    if (!options.json) {
      throw usageError("JSON_REQUIRED", "agent verify-all 仅提供 --json 输出", { subcommand });
    }
    try {
      return await runAgentConnectionVerificationSet({ launcher: options.launcher });
    } catch (error) {
      throw asCliConnectionVerificationError(error);
    }
  }
  if (subcommand !== "plan" && subcommand !== "doctor" && subcommand !== "export" && subcommand !== "verify") {
    throw usageError("UNKNOWN_AGENT_COMMAND", "用法: useful agent <plan|doctor|export|verify|verify-all|probe> ...；probe 与 verify-all 使用各自严格参数闭集", { subcommand: subcommand ?? null });
  }
  const options = parseAgentIntegrationArgs(args);
  if (!options.json) {
    throw usageError("JSON_REQUIRED", "agent plan/doctor/export/verify 仅提供 --json 输出", { subcommand });
  }
  try {
    const input = {
      target: options.target,
      launcher: options.launcher,
      scope: options.scope ?? "user",
      ...(options["project-dir"] === undefined ? {} : { projectDirectory: options["project-dir"] }),
      environment: parseEnvironmentAssignments(options.environment),
    };
    if (subcommand === "plan") return planAgentIntegration(input);
    if (subcommand === "export") return exportAgentIntegration(input);
    if (subcommand === "verify") return await runAgentConnectionVerification(input);
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
    if (subcommand === "verify") throw asCliConnectionVerificationError(error);
    throw asCliIntegrationError(error);
  }
}

async function computerUseCommand(rest) {
  const [subcommand, ...args] = rest;
  if (subcommand !== "probe") {
    throw usageError("UNKNOWN_COMPUTER_USE_COMMAND", "用法: useful computer-use probe --json", {
      subcommand: subcommand ?? null,
    });
  }
  const { options, positional } = parseStrictArgs(args, new Set(["json"]));
  requirePositionals(positional, 0, 0, "用法: useful computer-use probe --json");
  if (args.filter((value) => value === "--json").length > 1) {
    throw usageError("DUPLICATE_FLAG", "--json 只能提供一次", { option: "json" });
  }
  if (!options.json) {
    throw usageError("JSON_REQUIRED", "computer-use probe 仅提供 --json 输出", { subcommand });
  }
  try {
    return await runComputerUseProbe();
  } catch (error) {
    throw asCliComputerUseProbeError(error);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const jsonMode = process.argv.slice(2).includes("--json");
  const agentCommands = new Set(["create", "doctor", "validate", "pack", "agent-contract"]);
  // source storage supports --json; other source subcommands ignore it or print text.
  if (
    jsonMode
    && !agentCommands.has(cmd)
    && cmd !== "publisher"
    && cmd !== "agent"
    && cmd !== "computer-use"
    && cmd !== "source"
  ) {
    throw usageError("JSON_UNSUPPORTED", `命令 ${cmd ?? "<none>"} 不支持 --json`, { command: cmd ?? null });
  }
  if (cmd === "agent") {
    const data = await agentIntegrationCommand(rest);
    writeJson(successEnvelope(`agent ${rest[0]}`, data));
    return;
  }
  if (cmd === "computer-use") {
    const data = await computerUseCommand(rest);
    writeJson(successEnvelope(`computer-use ${rest[0]}`, data));
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
      console.log("用法: useful <create|doctor|dev|validate|pack|agent-contract|agent|computer-use> ...，或 useful <source|publisher|key|app-update> <子命令>");
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

  // useful source storage <doctor|dry-run|push|verify> ...
  if (sub === "storage") {
    await sourceStorageMain(args);
    return;
  }

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
          "用法: useful source <init|add-package|remove-package|publish|rotate-root|export-static|validate|serve|storage> [目录] [参数]",
        );
        process.exit(sub ? 1 : 0);
    }
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

async function sourceStorageMain(rest) {
  const {
    StorageError,
    doctorStorage,
    dryRunStorage,
    pushStorage,
    verifyStorage,
    printHuman,
  } = await import("./source/storage.mjs");
  const [action, ...args] = rest;
  const { opts, positional } = parseOpts(args);
  const asJson = Boolean(opts.json);
  const sourceDir = path.resolve(positional[0] ?? ".");
  const exportDir = opts.export ? path.resolve(String(opts.export)) : undefined;

  function emit(result) {
    if (asJson) {
      writeJson(result);
      if (!result.ok) process.exit(1);
      return;
    }
    printHuman(result);
    if (!result.ok) process.exit(1);
  }

  try {
    switch (action) {
      case "doctor":
        emit(await doctorStorage());
        break;
      case "dry-run":
        emit(await dryRunStorage(sourceDir, { exportDir }));
        break;
      case "push":
        emit(await pushStorage(sourceDir, { exportDir }));
        break;
      case "verify":
        emit(await verifyStorage(sourceDir, { exportDir }));
        break;
      default:
        console.log(
          "用法: useful source storage <doctor|dry-run|push|verify> [源目录] [--export <静态导出目录>] [--json]",
        );
        console.log("环境变量: USEFUL_STORAGE_BACKEND=fs|s3, USEFUL_STORAGE_ROOT (fs),");
        console.log(
          "  USEFUL_STORAGE_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY/PUBLIC_BASE_URL (s3)",
        );
        process.exit(action ? 1 : 0);
    }
  } catch (e) {
    if (asJson) {
      writeJson({
        schemaVersion: "useful.source-storage.v1",
        ok: false,
        error: {
          code: e instanceof StorageError ? e.code : "storage_error",
          message: e instanceof Error ? e.message : String(e),
        },
      });
    } else {
      console.error(`✗ ${e instanceof Error ? e.message : e}`);
    }
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
const compoundCommand = (rawArguments[0] === "publisher"
  || rawArguments[0] === "agent"
  || rawArguments[0] === "computer-use") && rawArguments[1];
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
