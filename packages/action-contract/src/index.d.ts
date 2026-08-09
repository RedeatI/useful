export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ExecutionMode = "pure" | "host" | "worker" | "ui-only";

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
