export type ComputerUseProbeInstallationMode = "source" | "agent-kit";
export type ComputerUseProbeEnvironment = "isolated-browser" | "isolated-vm";
export type ComputerUseProbeActionType = "screenshot" | "click" | "double-click" | "drag" | "move" | "scroll" | "type" | "key" | "wait";

export interface ComputerUseProbeInstallation {
  readonly mode: ComputerUseProbeInstallationMode;
  /**
   * True only for an Agent Kit MANIFEST closed-set hash/size integrity
   * self-check. It does not attest signature, origin, sidecar, or publishing
   * authorization.
   */
  readonly artifactVerified: boolean;
  readonly sourceRevision: string;
  readonly version: string;
}

export interface ComputerUseProbeContract {
  readonly schemaVersion: "useful.computer-use.v1";
  readonly environments: readonly ["isolated-browser", "isolated-vm"];
  readonly actionTypes: readonly ["screenshot", "click", "double-click", "drag", "move", "scroll", "type", "key", "wait"];
  readonly actionTypesSha256: "a9bce07e51d533f830833d94ddc5fd53ae7f0b837da31edc8b68f64394a10cf7";
  readonly defaultPolicy: Readonly<{
    environment: "isolated-browser";
    allowDomainsCount: 0;
    maxRedirects: 0;
    developmentMode: false;
    allowPrivateDomains: false;
  }>;
}

export interface ComputerUseProbeCapabilities {
  readonly cliProbeAvailable: true;
  readonly cliExecutionAvailable: false;
  readonly defaultProviderEnabled: false;
  readonly executableBrowserProviderPresent: false;
  readonly isolatedVmAdapterPresent: false;
  readonly modelAdapterPresent: false;
  readonly actionRegistered: false;
  readonly mcpRegistered: false;
  readonly guiRegistered: false;
  readonly browserAdapterInterfacePresent: true;
}

export interface ComputerUseProbeClaims {
  readonly documentAuthenticated: false;
  readonly defaultControllerDisabledObserved: true;
  readonly hostDesktopRejectedObserved: true;
  readonly networkUsedByProbe: false;
  readonly userInputPerformed: false;
  readonly hostDesktopTouched: false;
  readonly realBrowserAttested: false;
  readonly networkEnforcementAttested: false;
}

export interface ComputerUseProbe {
  readonly schemaVersion: "useful.computer-use-probe.v1";
  readonly status: "success";
  readonly claimScope: "useful-computer-use-capability-local-self-reported";
  readonly installation: ComputerUseProbeInstallation;
  readonly contract: ComputerUseProbeContract;
  readonly capabilities: ComputerUseProbeCapabilities;
  readonly claims: ComputerUseProbeClaims;
}

export interface CreateComputerUseProbeInput {
  readonly installation: ComputerUseProbeInstallation;
}

export class ComputerUseProbeProtocolError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export const COMPUTER_USE_PROBE_SCHEMA_VERSION: "useful.computer-use-probe.v1";
export const COMPUTER_USE_PROBE_SCHEMA_FILE: "computer-use-probe.schema.json";
export const COMPUTER_USE_PROBE_SCHEMA_ID: "https://schemas.useful.example/agent/useful.computer-use-probe.v1.schema.json";
export const COMPUTER_USE_PROBE_CLAIM_SCOPE: "useful-computer-use-capability-local-self-reported";
export const COMPUTER_USE_PROBE_INSTALLATION_MODES: readonly ComputerUseProbeInstallationMode[];
export const COMPUTER_USE_PROBE_MAX_DEPTH: 64;
export const COMPUTER_USE_PROBE_MAX_NODES: 4096;
export const COMPUTER_USE_PROBE_ENVIRONMENTS: readonly ComputerUseProbeEnvironment[];
export const COMPUTER_USE_PROBE_ACTION_TYPES: readonly ComputerUseProbeActionType[];
export const COMPUTER_USE_PROBE_ACTION_TYPES_SHA256: "a9bce07e51d533f830833d94ddc5fd53ae7f0b837da31edc8b68f64394a10cf7";

export function parseComputerUseProbe(document: unknown): Readonly<ComputerUseProbe>;
export function validateComputerUseProbe(document: unknown): Readonly<ComputerUseProbe>;
export function createComputerUseProbe(input: CreateComputerUseProbeInput): Readonly<ComputerUseProbe>;
