export type ComputerUseEnvironment = "isolated-browser" | "isolated-vm";
export type ComputerUseActionType = "screenshot" | "click" | "double-click" | "drag" | "move" | "scroll" | "type" | "key" | "wait";
export type SafetyCheckSource = "model" | "provider" | "contract";

export interface ComputerUsePolicy {
  schemaVersion: "useful.computer-use.v1";
  environment: ComputerUseEnvironment;
  maxSteps: number;
  stepDeadlineMs: number;
  totalDeadlineMs: number;
  maxScreenshotBytes: number;
  allowDomains: string[];
  maxRedirects: number;
  developmentMode: boolean;
  allowPrivateDomains: boolean;
}

export type ComputerUseAction =
  | { type: "screenshot" }
  | { type: "click" | "double-click"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { type: "drag"; startX: number; startY: number; endX: number; endY: number; durationMs?: number }
  | { type: "move"; x: number; y: number }
  | { type: "scroll"; deltaX: number; deltaY: number; x?: number; y?: number }
  | { type: "type"; text: string }
  | { type: "key"; keys: string[] }
  | { type: "wait"; durationMs: number };

export interface SafetyCheck {
  id: string;
  description: string;
  severity: "low" | "medium" | "high";
}

export interface ProviderSafetyCheck extends SafetyCheck {
  source: SafetyCheckSource;
}

export interface ProviderObservation {
  observationDigest: string;
  screenshot?: ArrayBuffer | ArrayBufferView;
  networkEvidence?: NetworkEvidence;
}

export interface NetworkEvidence {
  complete: true;
  hops: Array<{
    url: string;
    resolvedIps: string[];
  }>;
}

export interface ComputerUseProvider<Handle = unknown> {
  createSession(request: { schemaVersion: "useful.computer-use.v1"; environment: ComputerUseEnvironment; policy: Readonly<ComputerUsePolicy> }, context: { signal: AbortSignal }): Promise<Handle>;
  observe(handle: Handle, context: { signal: AbortSignal }): Promise<ProviderObservation>;
  execute(handle: Handle, request:
    | { phase: "prepare"; step: number; observationDigest: string; action: ComputerUseAction }
    | { phase: "commit"; preparedActionId: string; step: number; observationDigest: string; actionDigest: string; action: ComputerUseAction; approvals: Array<{ safetyCheckId: string; source: SafetyCheckSource; approvalId: string; preparedActionId: string; step: number; observationDigest: string; actionDigest: string }> },
    context: { signal: AbortSignal },
  ): Promise<
    | { status: "prepared"; preparedActionId: string; safetyChecks?: SafetyCheck[]; highImpact?: boolean }
    | { status: "executed"; resultCode: string; networkEvidence?: NetworkEvidence }
  >;
  close(handle: Handle, context: { signal: AbortSignal; reason?: string }): Promise<void>;
}

export interface AuditEvent {
  schemaVersion: "useful.computer-use.v1";
  eventId: string;
  timestamp: string;
  kind: "session-created" | "observation" | "authorization" | "action" | "session-closed";
  sessionId: string;
  preparedActionId?: string;
  step?: number;
  actionType?: ComputerUseActionType;
  actionDigest?: string;
  domain?: string;
  coordinates?: Record<string, number>;
  observationDigest?: string;
  screenshotBytes?: number;
  safetyCheckIds?: string[];
  approvalIds?: string[];
  resultCode: string;
}

export interface ComputerUseController {
  readonly policy: Readonly<ComputerUsePolicy>;
  createSession(options?: { signal?: AbortSignal }): Promise<Readonly<{ schemaVersion: "useful.computer-use.v1"; sessionId: string; environment: ComputerUseEnvironment; createdAt: number; expiresAt: number; nextStep: 1 }>>;
  observe(sessionId: string, options?: { signal?: AbortSignal }): Promise<Readonly<{ schemaVersion: "useful.computer-use.v1"; sessionId: string; step: number; observationDigest: string; screenshot?: ArrayBuffer | ArrayBufferView; screenshotBytes: number; url?: string; domain?: string }>>;
  execute(sessionId: string, request: { step: number; observationDigest: string; action: ComputerUseAction; safetyChecks?: SafetyCheck[] }, options?: { signal?: AbortSignal }): Promise<Readonly<{ schemaVersion: "useful.computer-use.v1"; sessionId: string; step: number; resultCode: string; nextStep: number }>>;
  close(sessionId: string, options?: { signal?: AbortSignal; reason?: string }): Promise<boolean>;
  reap(): Promise<number>;
}

export const COMPUTER_USE_SCHEMA: "useful.computer-use.v1";
export const COMPUTER_USE_ENVIRONMENTS: readonly ComputerUseEnvironment[];
export const COMPUTER_USE_ACTION_TYPES: readonly ComputerUseActionType[];
export const COMPUTER_USE_ERROR_CODES: Readonly<Record<string, string>>;
export const DEFAULT_COMPUTER_USE_POLICY: Readonly<ComputerUsePolicy>;
export const disabledComputerUseProvider: ComputerUseProvider<never>;

export class ComputerUseError extends Error {
  readonly code: string;
  constructor(code: string, message?: string, options?: ErrorOptions);
}

export function normalizeComputerUsePolicy(policy?: Partial<ComputerUsePolicy>): Readonly<ComputerUsePolicy>;
export function assertComputerUseAction(action: unknown): asserts action is ComputerUseAction;
export function createComputerUseController<Handle = unknown>(options?: {
  provider?: ComputerUseProvider<Handle>;
  policy?: Partial<ComputerUsePolicy>;
  approval?: (request: Readonly<{ schemaVersion: "useful.computer-use.v1"; sessionId: string; preparedActionId: string; step: number; observationDigest: string; actionDigest: string; actionType: ComputerUseActionType; action: ComputerUseAction; domain?: string; safetyCheck: ProviderSafetyCheck }>, context: { signal: AbortSignal }) => Promise<{ approved: true; approvalId: string } | { approved: false }>;
  audit?: (event: Readonly<AuditEvent>) => void | Promise<void>;
  clock?: () => number;
  idFactory?: () => string;
}): ComputerUseController;
