import { types as utilTypes } from "node:util";
import {
  AGENT_CONNECTION_VERIFICATION_SET_TARGETS,
  createAgentConnectionVerificationSet,
} from "@useful/protocol/agent-connection-verification-set";
import { runAgentSelfProbe } from "./agent-probe.mjs";
import {
  AgentConnectionVerifyError,
  agentConnectionVerificationInternals,
} from "./agent-connection-verify.mjs";

export const AGENT_CONNECTION_VERIFY_ALL_TARGETS = AGENT_CONNECTION_VERIFICATION_SET_TARGETS;

function fail(code, message, details = {}, exitCode = 3) {
  throw new AgentConnectionVerifyError(code, message, details, exitCode);
}

function captureInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) {
    fail("AGENT_VERIFY_ALL_INPUT_INVALID", "Agent verify-all 输入必须是普通对象");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("AGENT_VERIFY_ALL_INPUT_INVALID", "Agent verify-all 输入必须是普通对象");
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    fail("AGENT_VERIFY_ALL_INPUT_INVALID", "Agent verify-all 输入不接受 symbol 字段");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors);
  const unknown = keys.filter((key) => key !== "launcher").sort();
  if (unknown.length > 0) {
    fail("AGENT_VERIFY_ALL_INPUT_INVALID", "Agent verify-all 输入包含未知字段", { keys: unknown });
  }
  if (!Object.hasOwn(descriptors, "launcher")) {
    fail("AGENT_VERIFY_ALL_INPUT_INVALID", "Agent verify-all 缺少 launcher", { field: "launcher" });
  }
  const descriptor = descriptors.launcher;
  if (!descriptor.enumerable || !("value" in descriptor)) {
    fail("AGENT_VERIFY_ALL_INPUT_INVALID", "Agent verify-all 输入只接受可枚举数据字段", { field: "launcher" });
  }
  return { launcher: descriptor.value };
}

async function executeAgentConnectionVerificationSet(input, dependencies = {}) {
  const captured = captureInput(input);
  const probe = dependencies.probe ?? runAgentSelfProbe;
  const createSet = dependencies.createSet ?? createAgentConnectionVerificationSet;
  const context = agentConnectionVerificationInternals.prepare(captured, dependencies);
  const connections = AGENT_CONNECTION_VERIFY_ALL_TARGETS.map((target) => (
    agentConnectionVerificationInternals.buildCandidate(context, {
      target,
      launcher: context.fixedLauncher,
      scope: "user",
      environment: {},
    }, dependencies)
  ));

  const probeResult = await probe();
  agentConnectionVerificationInternals.assertIdentity(context, probeResult, dependencies);
  const verifications = connections.map((connection) => (
    agentConnectionVerificationInternals.createCandidateVerification(connection, probeResult, dependencies)
  ));
  return createSet({ verifications });
}

export async function runAgentConnectionVerificationSet(input) {
  return executeAgentConnectionVerificationSet(input);
}

// Test seam only. Production accepts no dependency, process, argv, cwd,
// environment, profile, host-command, or host-config overrides.
export const agentConnectionVerificationSetTesting = Object.freeze({
  execute: executeAgentConnectionVerificationSet,
});
