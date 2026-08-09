#!/usr/bin/env node
// 兼容入口：复用 useful create 的唯一 scaffold 实现。
import process from "node:process";
import path from "node:path";
import { createToolScaffold } from "./agent-workflow.mjs";
import {
  CliError,
  exitCodeFor,
  failureEnvelope,
  successEnvelope,
  usageError,
  writeJson,
} from "./cli-contract.mjs";

function parseArguments(args) {
  const allowed = new Set(["id", "name", "display-name", "description", "template", "json"]);
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
    if (!allowed.has(name)) throw usageError("UNKNOWN_FLAG", `未知选项: --${name}`, { option: name });
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
  if (positional.length !== 1) {
    throw usageError("INVALID_ARGUMENTS", "用法: create-useful-tool <目录> [typed options] [--json]", { positionalCount: positional.length });
  }
  return { options, directory: positional[0] };
}

const jsonMode = process.argv.slice(2).includes("--json");
try {
  const { options, directory } = parseArguments(process.argv.slice(2));
  const legacySlug = path.basename(directory).replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "tool";
  const result = createToolScaffold(directory, {
    // 保持旧入口 `my-tool` -> `com.example.mytool` 的默认 ID；显式 --id 优先。
    id: options.id ?? `com.example.${legacySlug}`,
    displayName: options["display-name"] ?? options.name,
    description: options.description,
    // 旧入口不传 --template 时仍生成 starter，但首发安全策略下 starter 不申请 native 权限。
    template: options.template ?? "starter-web",
  });
  if (jsonMode) writeJson(successEnvelope("create", result));
  else {
    console.log(`✓ 已创建工具: ${result.directory}`);
    console.log(`  下一步: useful doctor "${result.directory}" && useful validate "${result.directory}"`);
  }
} catch (error) {
  if (jsonMode) writeJson(failureEnvelope("create", error));
  else {
    const prefix = error instanceof CliError ? error.code : "INTERNAL_ERROR";
    console.error(`✗ ${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = exitCodeFor(error);
}
