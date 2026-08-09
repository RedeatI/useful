import { EXIT_CODES } from "./cli-contract.mjs";

export const AGENT_DOC_COMMANDS = Object.freeze([
  "useful create \"<TOOL_DIR>\" --id com.example.agent-tool --name \"Agent Tool\" --template minimal-action --json",
  "useful doctor \"<TOOL_DIR>\" --json",
  "useful validate \"<TOOL_DIR>\" --json",
  "useful pack \"<TOOL_DIR>\" \"<OUT_DIR>\" --json",
  "useful publisher init \"<PUBLISHER_DIR>\" --id com.example.agent-publisher --name \"Agent Publisher\" --json",
  "useful publisher sign \"<ARTIFACT_PATH>\" --key \"<PUBLISHER_DIR>/publisher.private.pem\" --json",
  "useful publisher verify \"<ARTIFACT_PATH>\" \"<ARTIFACT_PATH>.publisher-signature.json\" --json",
  "useful-runtime --plugin-config \"<PLUGIN_CONFIG>\" actions list --json",
  "useful-runtime actions search --query office --category office --sort relevance --json",
  "useful-runtime actions suggest --input @sample.txt --limit 5 --json",
  "useful-runtime actions recipe --input @recipe.json --validate-only --output json",
  "useful-runtime --plugin-config \"<PLUGIN_CONFIG>\" actions describe com.example.agent-tool.base64-sha256 --json",
  "useful-runtime --plugin-config \"<PLUGIN_CONFIG>\" actions run com.example.agent-tool.base64-sha256 --input @request.json --output json",
  "useful-mcp --plugin-config \"<PLUGIN_CONFIG>\"",
  "useful-runtime --plugin-config \"<PLUGIN_CONFIG>\" --agent-profile \"<AGENT_PROFILE>\" actions list --json",
  "useful-runtime --agent-profile \"<AGENT_PROFILE>\" actions run builtin.utilities.base64 --preset encode --input @request.json --output json",
  "useful-mcp --plugin-config \"<PLUGIN_CONFIG>\" --agent-profile \"<AGENT_PROFILE>\"",
  "useful-runtime --host-config \"<HOST_CONFIG>\" actions list --json",
  "useful-runtime --host-config \"<HOST_CONFIG>\" actions run builtin.video-trim.export --confirm --input @request.json --output json",
  "useful-mcp --host-config \"<HOST_CONFIG>\"",
]);

export function agentContractData(templates) {
  return {
    commandSequence: AGENT_DOC_COMMANDS,
    commands: {
      create: "useful create <dir> [--id <id>] [--name <name>] [--description <text>] [--template minimal-web|minimal-action|starter-web] --json",
      doctor: "useful doctor <dir> --json",
      validate: "useful validate <dir> --json",
      pack: "useful pack <dir> [outDir] --json",
      publisherInit: "useful publisher init <dir> [--id <id>] [--name <name>] --json",
      publisherSign: "useful publisher sign <artifact.useful> --key <private.pem> [--out <sidecar.json>] --json",
      publisherVerify: "useful publisher verify <artifact.useful> <sidecar.json> --json",
      runtimeList: "useful-runtime [--plugin-config <file>] [--host-config <file>] [--agent-profile <file>] actions list --json",
      runtimeSearch: "useful-runtime [--plugin-config <file>] [--host-config <file>] [--agent-profile <file>] actions search [--query <text>] [--sort relevance|action-id|title|category] [--direction asc|desc] [--source <kinds>] [--category <categories>] [--execution <modes>] [--read-only true|false] [--idempotent true|false] [--limit 1..100] [--cursor <cursor>] --json",
      runtimeSuggest: "useful-runtime [--plugin-config <file>] [--host-config <file>] [--agent-profile <file>] actions suggest [--input @file|-] [--limit 1..20] [--minimum-score 0..1000] --json",
      runtimeRecipe: "useful-runtime [--plugin-config <file>] [--agent-profile <file>] actions recipe [--input @file|-] [--validate-only] --output json",
      runtimeDescribe: "useful-runtime [--plugin-config <file>] [--host-config <file>] [--agent-profile <file>] actions describe <id-or-profile-alias> --json",
      runtimeRun: "useful-runtime [--plugin-config <file>] [--host-config <file>] [--agent-profile <file>] actions run <id-or-profile-alias> [--preset <id>] [--input @file|-] [--confirm] --output json",
      mcp: "useful-mcp [--plugin-config <file>] [--host-config <file>] [--agent-profile <file>]",
    },
    discovery: {
      defaultActionCount: 36,
      mcpTools: ["useful.actions.search", "useful.actions.describe", "useful.actions.suggest", "useful.actions.recipe"],
      ordering: "Action list order is deterministic; an Agent Profile preserves its explicit per-surface order; search and suggestions use explicit deterministic scores and actionId tie-breaks",
    },
    pluginConfig: {
      schemaVersion: "useful.plugin-set.v1",
      pathResolution: "artifactPath and signaturePath are safe relative paths resolved from the config file directory",
      requiredPins: ["expectedPublisherKeyId", "expectedArtifactSha256"],
      discovery: "explicit-only",
    },
    agentProfile: {
      schemaVersion: "useful.agent-profile.v1",
      mode: "explicit allowlist; absent keeps legacy runtime/MCP exposure unchanged",
      trustOrder: "signed plugin registry first, profile identity/version/publisher pins second",
      aliases: "CLI-only and profile-controlled; MCP remains canonical actionId-only",
      presets: "top-level schema-known non-sensitive defaults; invocation input wins and ActionExecutor revalidates",
      export: "canonical JSON at the GUI-managed fixed app-data path; no runtime input history or tokens",
    },
    hostActions: {
      schemaVersion: "useful.host-actions.v1",
      discovery: "explicit --host-config only; absent host config exposes no host actions",
      confirmation: "CLI --confirm is per invocation; MCP never fabricates confirmation and exposes grants only for configured read-only actions",
      actionIds: [
        "builtin.video-trim.probe",
        "builtin.video-trim.export",
        "builtin.process-monitor.snapshot",
        "builtin.process-monitor.terminate",
      ],
    },
    exitCodes: EXIT_CODES,
    templates,
  };
}
