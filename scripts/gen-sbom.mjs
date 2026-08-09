#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMediaRuntimeLock } from "./release-metadata-media.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function defaultExecFile(command, args, options) {
  return execFileSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
  });
}

function run(execFile, rootPath, command, args) {
  return execFile(command, args, { cwd: rootPath, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

function uuidBytes(value) {
  const compact = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) throw new Error("UUID namespace 无效");
  return Buffer.from(compact, "hex");
}

export function deterministicUuid(name, namespace = UUID_NAMESPACE) {
  const bytes = createHash("sha1").update(uuidBytes(namespace)).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedLicenses(values) {
  return [...new Set(values.filter(Boolean))].sort().map((name) => ({ license: { name } }));
}

function normalizedReferences(values) {
  const byKey = new Map();
  for (const value of values.filter(Boolean)) byKey.set(`${value.type}\0${value.url}`, value);
  return [...byKey.values()].sort((a, b) => `${a.type}\0${a.url}`.localeCompare(`${b.type}\0${b.url}`));
}

function normalizeComponents(input) {
  const byPurl = new Map();
  for (const component of input) {
    const existing = byPurl.get(component.purl);
    if (!existing) {
      byPurl.set(component.purl, component);
      continue;
    }
    existing.licenses = normalizedLicenses([
      ...existing.licenses.map((entry) => entry.license.name),
      ...component.licenses.map((entry) => entry.license.name),
    ]);
    existing.externalReferences = normalizedReferences([...existing.externalReferences, ...component.externalReferences]);
  }
  return [...byPurl.values()].sort((a, b) => a.purl.localeCompare(b.purl));
}

function parseSourceEpoch(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value ?? "")) throw new Error("SOURCE_DATE_EPOCH/git commit timestamp 必须是非负整数秒");
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch)) throw new Error("SOURCE_DATE_EPOCH 超出安全整数范围");
  return epoch;
}

function rustComponents(cargoMeta) {
  if (!Array.isArray(cargoMeta.packages) || !Array.isArray(cargoMeta.workspace_members)) throw new Error("cargo metadata 结构不完整");
  const workspaceIds = new Set(cargoMeta.workspace_members);
  return cargoMeta.packages.filter((pkg) => !workspaceIds.has(pkg.id)).map((pkg) => {
    if (!pkg.name || !pkg.version) throw new Error("cargo dependency 缺少 name/version");
    const purl = `pkg:cargo/${pkg.name}@${pkg.version}`;
    return {
      type: "library",
      "bom-ref": purl,
      purl,
      name: pkg.name,
      version: pkg.version,
      licenses: normalizedLicenses([pkg.license]),
      externalReferences: normalizedReferences([pkg.repository ? { type: "vcs", url: pkg.repository } : null]),
    };
  });
}

function npmComponents(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("pnpm licenses 输出结构无效");
  const result = [];
  for (const license of Object.keys(parsed).sort()) {
    const packages = parsed[license];
    if (!Array.isArray(packages)) throw new Error(`pnpm licenses ${license} 必须是 array`);
    for (const pkg of packages) {
      if (!pkg?.name) throw new Error("pnpm dependency 缺少 name");
      const versions = [...new Set(pkg.versions ?? (pkg.version ? [pkg.version] : []))].sort();
      if (versions.length === 0) throw new Error(`pnpm dependency ${pkg.name} 缺少 version`);
      for (const version of versions) {
        const purl = `pkg:npm/${pkg.name}@${version}`;
        result.push({
          type: "library",
          "bom-ref": purl,
          purl,
          name: pkg.name,
          version,
          licenses: normalizedLicenses([license]),
          externalReferences: normalizedReferences([pkg.homepage ? { type: "website", url: pkg.homepage } : null]),
        });
      }
    }
  }
  return result;
}

function mediaComponents(lock) {
  return lock.components.map((component) => {
    const purl = `pkg:generic/${component.name}@${component.version}?arch=x64&os=windows`;
    return {
      type: "library",
      "bom-ref": purl,
      purl,
      name: component.name,
      version: component.version,
      licenses: normalizedLicenses([component.license]),
      externalReferences: [{ type: "distribution", url: component.sourceUrl }],
      properties: [
        { name: "useful:media:archiveSha256", value: component.archiveSha256 },
        { name: "useful:media:targetName", value: component.targetName },
        { name: "useful:media:releaseEdition", value: "windows-x64-portable-full" },
      ],
    };
  });
}

export async function generateSbom({
  rootPath = defaultRoot,
  outputPath = path.join(rootPath, "dist-sbom", "sbom.cdx.json"),
  lockPath = path.join(rootPath, "scripts", "media-runtimes.lock.json"),
  env = process.env,
  execFile = defaultExecFile,
} = {}) {
  const cargoMeta = JSON.parse(run(execFile, rootPath, "cargo", ["metadata", "--format-version", "1", "--locked"]));
  const pnpmLicenses = JSON.parse(run(execFile, rootPath, "pnpm", ["licenses", "list", "--json", "--long"]));
  const sourceRevision = run(execFile, rootPath, "git", ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/i.test(sourceRevision)) throw new Error("git source revision 无效");
  const sourceEpoch = parseSourceEpoch(env.SOURCE_DATE_EPOCH ?? run(execFile, rootPath, "git", ["show", "-s", "--format=%ct", "HEAD"]));
  const appPackage = cargoMeta.packages.find((pkg) => pkg.name === "useful-app");
  if (!appPackage?.version) throw new Error("cargo metadata 缺少 useful-app 精确版本");
  const mediaLock = await readMediaRuntimeLock(lockPath);
  const components = normalizeComponents([
    ...rustComponents(cargoMeta),
    ...npmComponents(pnpmLicenses),
    ...mediaComponents(mediaLock),
  ]);
  const serialIdentity = JSON.stringify({
    sourceRevision: sourceRevision.toLowerCase(),
    version: appPackage.version,
    components,
  });
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${deterministicUuid(serialIdentity)}`,
    version: 1,
    metadata: {
      timestamp: new Date(sourceEpoch * 1000).toISOString(),
      tools: [{ vendor: "Useful", name: "Useful SBOM Generator", version: "1.0.0" }],
      component: {
        type: "application",
        "bom-ref": `pkg:generic/useful@${appPackage.version}`,
        name: "Useful",
        version: appPackage.version,
      },
      properties: [{ name: "useful:sourceRevision", value: sourceRevision.toLowerCase() }],
    },
    components,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
  return { bom, outputPath };
}

export async function runCli(options = {}) {
  try {
    const result = await generateSbom(options);
    (options.stdout ?? process.stdout).write(`Generated deterministic Useful SBOM: ${result.outputPath}\n`);
    return 0;
  } catch (error) {
    (options.stderr ?? process.stderr).write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await runCli();
