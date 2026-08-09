import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { AgentProfileError, PROFILE_ERROR_CODES, PROFILE_LIMITS, validateProfileAgainstRegistry } from "./browser.mjs";

export * from "./browser.mjs";

export async function loadAgentProfile(profilePath, registry) {
  const resolved = path.resolve(profilePath);
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch {
    throw new AgentProfileError(PROFILE_ERROR_CODES.INVALID, [{ path: "", code: "PROFILE_UNREADABLE" }]);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new AgentProfileError(PROFILE_ERROR_CODES.INVALID, [{ path: "", code: "PROFILE_NOT_REGULAR_FILE" }]);
  }
  if (metadata.size > PROFILE_LIMITS.bytes) throw new AgentProfileError(PROFILE_ERROR_CODES.TOO_LARGE);
  let text;
  try {
    text = await readFile(resolved, "utf8");
  } catch {
    throw new AgentProfileError(PROFILE_ERROR_CODES.INVALID, [{ path: "", code: "PROFILE_UNREADABLE" }]);
  }
  let profile;
  try {
    profile = JSON.parse(text.replace(/^\uFEFF+/, ""));
  } catch {
    throw new AgentProfileError(PROFILE_ERROR_CODES.INVALID, [{ path: "", code: "PROFILE_JSON_INVALID" }]);
  }
  return validateProfileAgainstRegistry(profile, registry);
}
