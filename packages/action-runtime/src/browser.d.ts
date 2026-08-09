export type HashAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
export type JsonActionInput = { operation: "format" | "minify"; text: string; indent?: number };
export type Base64ActionInput = { operation: "encode" | "decode"; text: string };
export type HashActionInput = { algorithm: HashAlgorithm; text: string };
export type TextActionOutput = { text: string };
export type HashActionOutput = { algorithm: HashAlgorithm; digest: string; encoding: "hex" };

export const ACTION_IDS: Readonly<Record<string, string>>;
export const ERROR_CODES: Readonly<Record<string, string>>;
export const OFFICE_ACTION_IDS: Readonly<Record<"DOCX" | "PPTX" | "SPREADSHEET" | "PDF" | "MARKDOWN", string>>;
export const HASH_ALGORITHMS: readonly HashAlgorithm[];
export const ACTION_SUGGEST_LIMITS: Readonly<{ inputBytes: number; limit: number }>;
export interface ActionSuggestion {
  actionId: string;
  title: string;
  description: string;
  score: number;
  confidence: "low" | "medium" | "high";
  reasonCodes: string[];
}
export function suggestActions(
  descriptors: readonly BrowserActionDescriptor[],
  text: string,
  options?: { limit?: number; minimumScore?: number },
): { suggestions: ActionSuggestion[] };
export interface BrowserActionDescriptor {
  contractVersion: "1.0";
  actionId: string;
  version: string;
  source: { kind: "builtin"; publisher: { id: string; name?: string }; digest: string };
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execution: { mode: string };
  behavior: { readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld: boolean };
  permissions: { required: string[]; capabilities: string[] };
  sensitive: { input: string[]; output: string[]; redactLogs: true };
}
export const BUILTIN_ACTION_DESCRIPTORS: readonly BrowserActionDescriptor[];

export function createBuiltinDescriptors(sourceDigest: string): Readonly<{
  json: Record<string, unknown> & { actionId: string; testVectors: Array<Record<string, unknown>> };
  base64: Record<string, unknown> & { actionId: string; testVectors: Array<Record<string, unknown>> };
  hash: Record<string, unknown> & { actionId: string; testVectors: Array<Record<string, unknown>> };
}>;
export function createAdditionalBuiltinDescriptors(sourceDigest: string): Readonly<Record<string, Record<string, unknown> & { actionId: string; testVectors: Array<Record<string, unknown>> }>>;
export function createOfficeActionDescriptors(sourceDigest: string): Readonly<Record<string, Record<string, unknown> & { actionId: string; testVectors: Array<Record<string, unknown>> }>>;
export type BrowserOfficeHandler = (
  actionId: string,
  input: Record<string, unknown>,
  context?: { signal?: AbortSignal },
) => Promise<Record<string, unknown>>;
export function createBrowserActionHandlers(options?: {
  crypto?: Crypto;
  subtle?: SubtleCrypto;
  regex?: (input: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>;
  office?: BrowserOfficeHandler | { execute: BrowserOfficeHandler };
}): Readonly<Record<string, (input: Record<string, unknown>, context?: { signal?: AbortSignal }) => unknown>>;
export function runJsonAction(input: JsonActionInput): TextActionOutput;
export function runBase64Action(input: Base64ActionInput): TextActionOutput;
export function runHashAction(input: HashActionInput, options?: { subtle?: SubtleCrypto }): Promise<HashActionOutput>;
export function runBrowserAction(
  actionId: string,
  input: JsonActionInput | Base64ActionInput | HashActionInput | Record<string, unknown>,
  options?: {
    subtle?: SubtleCrypto;
    crypto?: Crypto;
    signal?: AbortSignal;
    regex?: (input: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>;
    office?: BrowserOfficeHandler | { execute: BrowserOfficeHandler };
  },
): unknown | Promise<unknown>;
