export type AgentSurface = "cli" | "mcp";
export interface AgentPreset {
  presetId: string;
  name: string;
  defaults: Record<string, unknown>;
}
export interface AgentProfileAction {
  actionId: string;
  expectedContractVersion: "1.0";
  expectedActionVersion: string;
  expectedSourceKind: "builtin" | "plugin" | "local";
  expectedPublisherId: string;
  enabled: Record<AgentSurface, boolean>;
  aliases: string[];
  presets: AgentPreset[];
}
export interface AgentProfileV1 {
  schemaVersion: "useful.agent-profile.v1";
  profileId: string;
  name: string;
  actions: AgentProfileAction[];
}
export interface ProfileIssue { path: string; code: string }
export class AgentProfileError extends Error { code: string; issues: ProfileIssue[] }
export const PROFILE_SCHEMA_VERSION: "useful.agent-profile.v1";
export const PROFILE_ERROR_CODES: Readonly<Record<string, string>>;
export const PROFILE_LIMITS: Readonly<Record<string, number>>;
export function assertProfileDocument(profile: unknown): AgentProfileV1;
export function canonicalProfileJson(profile: unknown): string;
export function createDefaultBuiltinProfile(descriptors: Array<Record<string, any>>, name?: string): AgentProfileV1;
export function validateProfileAgainstRegistry(profile: unknown, registry: unknown): unknown;
export const validateProfileSchema: ((profile: unknown) => boolean) & { errors?: Array<Record<string, unknown>> };
