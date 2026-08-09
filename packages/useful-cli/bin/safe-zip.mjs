import { inspectUsefulArtifact, USEFUL_LIMITS } from "@useful/plugin-actions";

export { USEFUL_LIMITS };

export function readUsefulManifest(input) {
  try {
    const { bytes, manifest, manifestBytes } = inspectUsefulArtifact(input);
    return { bytes, manifest, manifestBytes };
  } catch (error) {
    throw new Error(`不安全的 .useful: ${typeof error?.code === "string" ? error.code : "ARCHIVE_INVALID"}`);
  }
}
