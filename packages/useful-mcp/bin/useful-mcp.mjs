#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ActionRegistry } from "@useful/action-runtime";
import { loadAgentProfile } from "@useful/agent-profile/node";
import { createHostActionEntries, loadHostActionConfig } from "@useful/host-actions";
import { loadPluginConfig } from "@useful/plugin-actions";
import { buildServer } from "../src/server.mjs";

const diagnostics = process.env.USEFUL_MCP_DIAGNOSTICS === "1";
const diagnose = (message) => {
  if (diagnostics) process.stderr.write(`useful-mcp: ${message}\n`);
};

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--plugin-config", "--host-config", "--agent-profile"].includes(flag) || !value || value.startsWith("--") || result[flag] !== undefined) {
      const error = new Error("MCP_ARGUMENTS_INVALID");
      error.code = "MCP_ARGUMENTS_INVALID";
      throw error;
    }
    result[flag] = value;
  }
  if (argv.length % 2 !== 0) {
    const error = new Error("MCP_ARGUMENTS_INVALID");
    error.code = "MCP_ARGUMENTS_INVALID";
    throw error;
  }
  return result;
}

let registry;
let executionPolicy;
try {
  const args = parseArguments(process.argv.slice(2));
  registry = new ActionRegistry();
  if (args["--plugin-config"]) {
    for (const entry of await loadPluginConfig(args["--plugin-config"])) registry.register(entry);
  }
  const readOnlyHostGrants = new Map();
  if (args["--host-config"]) {
    const entries = createHostActionEntries(await loadHostActionConfig(args["--host-config"]));
    for (const entry of entries) {
      registry.register(entry);
      const descriptor = entry.descriptor;
      if (descriptor.behavior.readOnly === true
        && descriptor.behavior.destructive === false
        && descriptor.behavior.requiresConfirmation === false) {
        readOnlyHostGrants.set(descriptor.actionId, Object.freeze({
          grantedPermissions: Object.freeze([...descriptor.permissions.required]),
          grantedCapabilities: Object.freeze([...descriptor.permissions.capabilities]),
        }));
      }
    }
  }
  executionPolicy = ({ actionId }) => readOnlyHostGrants.get(actionId);
  if (args["--agent-profile"]) {
    const exposure = await loadAgentProfile(args["--agent-profile"], registry);
    const filtered = new ActionRegistry([], { listOrder: "registration" });
    for (const descriptor of exposure.list("mcp")) {
      const entry = registry.resolve(descriptor.actionId);
      if (!entry) {
        const error = new Error("AGENT_PROFILE_UNKNOWN_ACTION");
        error.code = "AGENT_PROFILE_UNKNOWN_ACTION";
        throw error;
      }
      filtered.register({ descriptor, handler: entry.handler });
    }
    registry = filtered;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: typeof error?.code === "string" ? error.code : "PLUGIN_CONFIG_INVALID" } })}\n`);
  process.exit(4);
}

const handle = serveStdio(() => buildServer({ registry, executionPolicy }), {
  onerror: () => diagnose("stdio transport error"),
});

diagnose("ready");

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await handle.close();
  } catch {
    diagnose("shutdown error");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
