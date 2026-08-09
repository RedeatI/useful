import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import AdmZip from "adm-zip";
import { isReservedActionName } from "@useful/action-contract";
import { createPipelineHandler, derivePluginAction, isValidActionId, PluginActionError, verifyTestVectors } from "./pipeline.mjs";

export const USEFUL_LIMITS = Object.freeze({
  entries: 4096,
  entryBytes: 64 * 1024 * 1024,
  totalUncompressedBytes: 256 * 1024 * 1024,
  archiveBytes: 128 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  actionSpecBytes: 1024 * 1024,
  sidecarBytes: 64 * 1024,
  configBytes: 1024 * 1024,
  plugins: 32,
});

const SHA256 = /^[a-f0-9]{64}$/;
const KEY_ID = /^ed25519:[a-f0-9]{64}$/;
const PLUGIN_ID = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const KNOWN_PERMISSIONS = new Set(["process.launch.declared"]);

function usesReservedBuiltinNamespace(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return normalized === "builtin" || normalized.startsWith("builtin.");
}

function fail(code) { throw new PluginActionError(code); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, required, allowed, code) {
  if (!isObject(value)) fail(code);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(code);
  for (const key of Object.keys(value)) if (!allowed.includes(key) || ["__proto__", "prototype", "constructor"].includes(key)) fail(code);
}

function regularFileBytes(file, maxBytes, code) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(code); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail(code);
  try { return fs.readFileSync(file); } catch { fail(code); }
}

export function safeArchivePath(name) {
  if (typeof name !== "string") fail("ARCHIVE_PATH_INVALID");
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.includes("\0")) fail("ARCHIVE_PATH_INVALID");
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === ".")) fail("ARCHIVE_PATH_INVALID");
  return normalized;
}

function parseJson(bytes, code) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail(code); }
}

function validateRuntimeManifest(manifest) {
  exact(manifest,
    ["schemaVersion", "id", "name", "version", "entry"],
    ["schemaVersion", "id", "name", "version", "description", "icon", "entry", "contributes", "permissions", "platforms", "minHostVersion"],
    "MANIFEST_MISSING_OR_INVALID",
  );
  if (manifest.schemaVersion !== 1 || typeof manifest.id !== "string" || manifest.id.length > 128 || !PLUGIN_ID.test(manifest.id) || usesReservedBuiltinNamespace(manifest.id) || typeof manifest.name !== "string" || !manifest.name.length || manifest.name.length > 128 || /[\0-\x1f\x7f]/.test(manifest.name) || typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) fail("MANIFEST_MISSING_OR_INVALID");
  if (manifest.description !== undefined && (typeof manifest.description !== "string" || manifest.description.length > 1024 || /[\0\x7f]/.test(manifest.description))) fail("MANIFEST_MISSING_OR_INVALID");
  exact(manifest.entry, ["type", "path"], ["type", "path", "args"], "MANIFEST_MISSING_OR_INVALID");
  if (!["web", "launcher", "worker"].includes(manifest.entry.type) || typeof manifest.entry.path !== "string" || !manifest.entry.path.length || manifest.entry.path.length > 1024 || manifest.entry.path.includes("\0")) fail("MANIFEST_MISSING_OR_INVALID");
  if (manifest.entry.type !== "launcher") safeArchivePath(manifest.entry.path);
  if (manifest.entry.args !== undefined && (!Array.isArray(manifest.entry.args) || manifest.entry.args.some((item) => typeof item !== "string"))) fail("MANIFEST_MISSING_OR_INVALID");
  if (manifest.icon !== undefined && (typeof manifest.icon !== "string" || manifest.icon.length > 512)) fail("MANIFEST_MISSING_OR_INVALID");
  if (manifest.icon !== undefined) safeArchivePath(manifest.icon);
  if (manifest.permissions !== undefined && (!Array.isArray(manifest.permissions) || manifest.permissions.length > 128 || new Set(manifest.permissions).size !== manifest.permissions.length || manifest.permissions.some((item) => typeof item !== "string" || !KNOWN_PERMISSIONS.has(item)))) fail("MANIFEST_MISSING_OR_INVALID");
  if (manifest.platforms !== undefined && (!Array.isArray(manifest.platforms) || manifest.platforms.some((item) => !["windows-x64", "windows-arm64"].includes(item)))) fail("MANIFEST_MISSING_OR_INVALID");
  if (manifest.minHostVersion !== undefined && (typeof manifest.minHostVersion !== "string" || !SEMVER.test(manifest.minHostVersion))) fail("MANIFEST_MISSING_OR_INVALID");
  if (manifest.entry.type === "launcher" && !(manifest.permissions ?? []).includes("process.launch.declared")) fail("MANIFEST_MISSING_OR_INVALID");
  if (manifest.entry.type !== "launcher" && (manifest.permissions ?? []).length !== 0) fail("MANIFEST_MISSING_OR_INVALID");
  if (manifest.contributes !== undefined) {
    exact(manifest.contributes, [], ["sidebar", "actions"], "MANIFEST_MISSING_OR_INVALID");
    if (manifest.contributes.sidebar !== undefined && !Array.isArray(manifest.contributes.sidebar)) fail("MANIFEST_MISSING_OR_INVALID");
    for (const sidebar of manifest.contributes.sidebar ?? []) {
      exact(sidebar, ["id", "title"], ["id", "title", "group", "order"], "MANIFEST_MISSING_OR_INVALID");
      if (typeof sidebar.id !== "string" || !sidebar.id.length || typeof sidebar.title !== "string" || !sidebar.title.length) fail("MANIFEST_MISSING_OR_INVALID");
      if (sidebar.group !== undefined && !["installed", "builtin"].includes(sidebar.group)) fail("MANIFEST_MISSING_OR_INVALID");
      if (sidebar.order !== undefined && !Number.isInteger(sidebar.order)) fail("MANIFEST_MISSING_OR_INVALID");
    }
  }
}

function configRelative(value) {
  if (typeof value !== "string" || !value.length || value.includes("\0") || path.isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.replace(/\\/g, "/").split("/").some((part) => part === "..")) fail("PLUGIN_CONFIG_INVALID");
  return value;
}

export function inspectUsefulArtifact(input) {
  const bytes = Buffer.isBuffer(input) ? input : regularFileBytes(path.resolve(input), USEFUL_LIMITS.archiveBytes, "ARTIFACT_UNREADABLE");
  if (bytes.length > USEFUL_LIMITS.archiveBytes) fail("ARCHIVE_TOO_LARGE");
  let entries;
  try { entries = new AdmZip(bytes).getEntries(); } catch { fail("ARCHIVE_INVALID"); }
  if (entries.length > USEFUL_LIMITS.entries) fail("ARCHIVE_ENTRY_LIMIT");
  const byName = new Map();
  let total = 0;
  for (const entry of entries) {
    const name = safeArchivePath(entry.entryName);
    if (byName.has(name)) fail("ARCHIVE_DUPLICATE_ENTRY");
    const unixType = (Number(entry.header?.attr) >>> 16) & 0xf000;
    if (unixType === 0xa000) fail("ARCHIVE_LINK_FORBIDDEN");
    if (unixType !== 0 && unixType !== 0x4000 && unixType !== 0x8000) fail("ARCHIVE_SPECIAL_ENTRY");
    const size = Number(entry.header?.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > USEFUL_LIMITS.entryBytes) fail("ARCHIVE_ENTRY_TOO_LARGE");
    total += size;
    if (!Number.isSafeInteger(total) || total > USEFUL_LIMITS.totalUncompressedBytes) fail("ARCHIVE_EXPANDED_TOO_LARGE");
    byName.set(name, entry);
  }
  const manifestEntry = byName.get("manifest.json");
  if (!manifestEntry || manifestEntry.isDirectory || manifestEntry.header.size > USEFUL_LIMITS.manifestBytes) fail("MANIFEST_MISSING_OR_INVALID");
  let manifestBytes;
  try { manifestBytes = manifestEntry.getData(); } catch { fail("MANIFEST_MISSING_OR_INVALID"); }
  if (manifestBytes.length > USEFUL_LIMITS.manifestBytes) fail("MANIFEST_MISSING_OR_INVALID");
  const manifest = parseJson(manifestBytes, "MANIFEST_MISSING_OR_INVALID");
  validateRuntimeManifest(manifest);
  return { bytes, manifest, manifestBytes, byName, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function signaturePayload(toolId, version, sha256) {
  return Buffer.from(`useful-artifact-v1\n${toolId}\n${version}\n${sha256}`);
}

export function verifyPublisherSidecar(artifact, signatureFile) {
  const receipt = parseJson(regularFileBytes(path.resolve(signatureFile), USEFUL_LIMITS.sidecarBytes, "SIGNATURE_UNREADABLE"), "SIGNATURE_INVALID");
  exact(receipt,
    ["schemaVersion", "signatureDomain", "publisherKeyId", "toolId", "version", "artifactSha256", "artifactBytes", "signature"],
    ["schemaVersion", "signatureDomain", "publisherKeyId", "toolId", "version", "artifactSha256", "artifactBytes", "signature"],
    "SIGNATURE_INVALID",
  );
  if (receipt.schemaVersion !== 1 || receipt.signatureDomain !== "useful-artifact-v1") fail("SIGNATURE_DOMAIN_INVALID");
  if (receipt.toolId !== artifact.manifest.id || receipt.version !== artifact.manifest.version) fail("SIGNATURE_IDENTITY_MISMATCH");
  if (receipt.artifactSha256 !== artifact.sha256 || receipt.artifactBytes !== artifact.bytes.length) fail("SIGNATURE_ARTIFACT_MISMATCH");
  if (!KEY_ID.test(receipt.publisherKeyId) || typeof receipt.signature !== "string" || !/^[a-f0-9]{128}$/i.test(receipt.signature)) fail("SIGNATURE_INVALID");
  const publicHex = receipt.publisherKeyId.slice("ed25519:".length);
  let valid = false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicHex, "hex").toString("base64url") }, format: "jwk" });
    valid = verify(null, signaturePayload(receipt.toolId, receipt.version, receipt.artifactSha256), key, Buffer.from(receipt.signature, "hex"));
  } catch { fail("SIGNATURE_INVALID"); }
  if (!valid) fail("SIGNATURE_INVALID");
  return receipt;
}

export function validateManifestActionContributions(manifest) {
  const actions = manifest?.contributes?.actions;
  if (actions === undefined) return [];
  if (!Array.isArray(actions) || actions.length > 32) fail("MANIFEST_ACTIONS_INVALID");
  const ids = new Set();
  const paths = new Set();
  return actions.map((item) => {
    exact(item, ["actionId", "path"], ["actionId", "path"], "MANIFEST_ACTIONS_INVALID");
    if (isReservedActionName(item.actionId)) fail("PLUGIN_ACTION_RESERVED_NAME");
    if (!isValidActionId(item.actionId) || !item.actionId.startsWith(`${manifest.id}.`) || ids.has(item.actionId)) fail("PLUGIN_ACTION_NAMESPACE_INVALID");
    if (typeof item.path !== "string" || item.path.length > 1024) fail("MANIFEST_ACTIONS_INVALID");
    const actionPath = safeArchivePath(item.path);
    if (paths.has(actionPath)) fail("MANIFEST_ACTIONS_INVALID");
    ids.add(item.actionId); paths.add(actionPath);
    return { actionId: item.actionId, path: actionPath };
  });
}

export async function loadLocalPluginActions(root, manifest, publisherKeyId = `ed25519:${"0".repeat(64)}`) {
  const actions = [];
  for (const contribution of validateManifestActionContributions(manifest)) {
    const target = path.resolve(root, contribution.path);
    const relative = path.relative(path.resolve(root), target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("ACTION_SPEC_PATH_INVALID");
    const bytes = regularFileBytes(target, USEFUL_LIMITS.actionSpecBytes, "ACTION_SPEC_MISSING");
    const spec = parseJson(bytes, "ACTION_SPEC_INVALID");
    const descriptor = derivePluginAction({
      actionId: contribution.actionId,
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      publisherKeyId,
      spec,
    });
    const handler = createPipelineHandler(spec);
    await verifyTestVectors(descriptor, handler);
    actions.push({ descriptor, handler });
  }
  return actions;
}

export async function loadSignedPlugin(entry, configDirectory) {
  exact(entry,
    ["artifactPath", "signaturePath", "expectedPublisherKeyId", "expectedArtifactSha256"],
    ["artifactPath", "signaturePath", "expectedPublisherKeyId", "expectedArtifactSha256"],
    "PLUGIN_CONFIG_INVALID",
  );
  if (!KEY_ID.test(entry.expectedPublisherKeyId) || !SHA256.test(entry.expectedArtifactSha256)) fail("PLUGIN_CONFIG_INVALID");
  const artifact = inspectUsefulArtifact(path.resolve(configDirectory, configRelative(entry.artifactPath)));
  if (artifact.sha256 !== entry.expectedArtifactSha256) fail("ARTIFACT_PIN_MISMATCH");
  const receipt = verifyPublisherSidecar(artifact, path.resolve(configDirectory, configRelative(entry.signaturePath)));
  if (receipt.publisherKeyId !== entry.expectedPublisherKeyId) fail("PUBLISHER_PIN_MISMATCH");
  const contributions = validateManifestActionContributions(artifact.manifest);
  const actions = [];
  for (const contribution of contributions) {
    const archiveEntry = artifact.byName.get(contribution.path);
    if (!archiveEntry || archiveEntry.isDirectory || archiveEntry.header.size > USEFUL_LIMITS.actionSpecBytes) fail("ACTION_SPEC_MISSING");
    let bytes;
    try { bytes = archiveEntry.getData(); } catch { fail("ACTION_SPEC_INVALID"); }
    if (bytes.length > USEFUL_LIMITS.actionSpecBytes) fail("ACTION_SPEC_TOO_LARGE");
    const spec = parseJson(bytes, "ACTION_SPEC_INVALID");
    const descriptor = derivePluginAction({
      actionId: contribution.actionId,
      pluginId: artifact.manifest.id,
      pluginVersion: artifact.manifest.version,
      publisherKeyId: receipt.publisherKeyId,
      spec,
    });
    const handler = createPipelineHandler(spec);
    await verifyTestVectors(descriptor, handler);
    actions.push({ descriptor, handler });
  }
  return actions;
}

export async function loadPluginConfig(configPath) {
  const resolved = path.resolve(configPath);
  const config = parseJson(regularFileBytes(resolved, USEFUL_LIMITS.configBytes, "PLUGIN_CONFIG_UNREADABLE"), "PLUGIN_CONFIG_INVALID");
  exact(config, ["schemaVersion", "plugins"], ["schemaVersion", "plugins"], "PLUGIN_CONFIG_INVALID");
  if (config.schemaVersion !== "useful.plugin-set.v1" || !Array.isArray(config.plugins) || config.plugins.length > USEFUL_LIMITS.plugins) fail("PLUGIN_CONFIG_INVALID");
  const actions = [];
  for (const entry of config.plugins) actions.push(...await loadSignedPlugin(entry, path.dirname(resolved)));
  return actions;
}
