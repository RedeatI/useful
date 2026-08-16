export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ExecutionMode = "pure" | "host" | "worker" | "ui-only";
export type ExecutionReceiptStatus = "queued" | "running" | "success" | "error" | "cancelled";

export interface ExecutionReceiptV2 {
  receiptVersion: "2.0";
  actionId: string;
  actionVersion: string;
  contractVersion: string;
  source: {
    kind: "builtin" | "plugin" | "local";
    toolId: string;
    publisher: { id: string; name?: string };
    digest: string;
  };
  permissions: { required: string[]; capabilities: string[] };
  status: ExecutionReceiptStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: { code: string };
}

export interface ActionDescriptor {
  contractVersion: "1.0";
  actionId: string;
  version: string;
  source: {
    kind: "builtin" | "plugin" | "local";
    toolId: string;
    publisher: { id: string; name?: string };
    digest: string;
  };
  title: string;
  description: string;
  keywords: string[];
  aliases: string[];
  inputSchema: Record<string, JsonValue>;
  outputSchema: Record<string, JsonValue>;
  examples: Array<{ name: string; input: JsonValue; output: JsonValue }>;
  testVectors: Array<{
    name: string;
    input: JsonValue;
    expectedOutput?: JsonValue;
    expectedErrorCode?: string;
  }>;
  execution: {
    mode: ExecutionMode;
    handler?: string;
    timeoutMs: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    supportsCancellation: boolean;
  };
  behavior: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;
    sideEffects: string[];
    requiresConfirmation: boolean;
  };
  permissions: { required: string[]; capabilities: string[] };
  sensitive: { input: string[]; output: string[]; redactLogs: true };
  presentation?: { route?: string; icon?: string; category?: string };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export const RESERVED_ACTION_NAMES: readonly [
  "useful.actions.search",
  "useful.actions.describe",
  "useful.actions.suggest",
  "useful.actions.recipe",
];
export function isReservedActionName(value: unknown): boolean;
export function validateActionDescriptor(value: unknown): ValidationIssue[];
export function assertActionDescriptor(value: unknown): asserts value is ActionDescriptor;
export function validateValue(schema: Record<string, unknown>, value: unknown): ValidationIssue[];
export function utf8JsonBytes(value: unknown): number;
export const EXECUTION_RECEIPT_VERSION: "2.0";
export const EXECUTION_RECEIPT_MAX_BYTES: 65536;
export const EXECUTION_RECEIPT_STATUSES: readonly ["queued", "running", "success", "error", "cancelled"];
export class ExecutionReceiptError extends Error {
  code: "RECEIPT_INVALID" | "RECEIPT_TOO_LARGE" | "RECEIPT_VERSION_UNSUPPORTED";
  issues: ValidationIssue[];
}
export function validateExecutionReceipt(value: unknown): ValidationIssue[];
export function assertExecutionReceipt(value: unknown): asserts value is ExecutionReceiptV2;
export function upgradeExecutionReceipt(value: unknown): ExecutionReceiptV2;
export function parseExecutionReceipt(value: string | Uint8Array | unknown, options?: { maxBytes?: number }): ExecutionReceiptV2;
