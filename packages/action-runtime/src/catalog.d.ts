export type BuiltinExecutionMode = "pure" | "worker";

export interface BuiltinActionMetadata {
  readonly contractVersion: "1.0";
  readonly actionId: string;
  readonly version: "1.0.0";
  readonly source: {
    readonly kind: "builtin";
    readonly toolId: "builtin.utilities" | "builtin.office";
    readonly publisher: { readonly id: string; readonly name: string };
  };
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly aliases: readonly string[];
  readonly execution: { readonly mode: BuiltinExecutionMode };
  readonly behavior: {
    readonly readOnly: boolean;
    readonly destructive: boolean;
    readonly idempotent: boolean;
    readonly openWorld: boolean;
    readonly sideEffects: readonly string[];
    readonly requiresConfirmation: boolean;
  };
  readonly permissions: {
    readonly required: readonly string[];
    readonly capabilities: readonly string[];
  };
  readonly presentation: {
    readonly route: string;
    readonly icon?: string;
    readonly category: string;
  };
}

export const ACTION_IDS: Readonly<Record<string, string>>;
export const OFFICE_ACTION_IDS: Readonly<Record<"DOCX" | "PPTX" | "SPREADSHEET" | "PDF" | "MARKDOWN", string>>;
export const BUILTIN_ACTION_CATALOG: readonly BuiltinActionMetadata[];
export function findBuiltinActionMetadata(actionId: string): BuiltinActionMetadata | undefined;
export function createBuiltinDescriptorMetadata(actionId: string, sourceDigest: string): Record<string, unknown>;
