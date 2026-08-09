#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_VERSION_FILES,
  assertVersionForChannel,
  inferChannel,
} from "./version-policy.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "..");
export const EXPECTED_BUNDLE_IDENTIFIER = "io.github.redeati.useful";
const TAURI_BASE_CONFIG = "apps/useful/src-tauri/tauri.conf.json";
const TAURI_PLATFORM_CONFIGS = Object.freeze([
  { platform: "windows", path: "apps/useful/src-tauri/tauri.windows.conf.json" },
  { platform: "macos", path: "apps/useful/src-tauri/tauri.macos.conf.json" },
  { platform: "linux", path: "apps/useful/src-tauri/tauri.linux.conf.json" },
]);

async function readJson(repoRoot, relative) {
  return JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"));
}

function hasOwn(value, key) {
  return value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

export function evaluateBundleIdentifierConfiguration({ baseConfig, platformConfigs }) {
  const identifier = baseConfig?.identifier;
  const base = {
    path: TAURI_BASE_CONFIG,
    identifier,
    matchesExpected: identifier === EXPECTED_BUNDLE_IDENTIFIER,
    endsWithAppSuffix: typeof identifier === "string" && identifier.endsWith(".app"),
  };
  const platformOverrides = TAURI_PLATFORM_CONFIGS.map(({ platform, path: relative }) => {
    const config = platformConfigs[platform];
    return {
      platform,
      path: relative,
      declaresIdentifier: hasOwn(config, "identifier"),
      ...(hasOwn(config, "identifier") ? { identifier: config.identifier } : {}),
    };
  });
  const failures = [];
  if (!base.matchesExpected) {
    failures.push({
      code: "bundle-identifier-mismatch",
      path: `${TAURI_BASE_CONFIG}#identifier`,
      expected: EXPECTED_BUNDLE_IDENTIFIER,
      actual: identifier,
    });
  }
  if (base.endsWithAppSuffix) {
    failures.push({
      code: "bundle-identifier-app-suffix",
      path: `${TAURI_BASE_CONFIG}#identifier`,
      actual: identifier,
    });
  }
  for (const entry of platformOverrides.filter((candidate) => candidate.declaresIdentifier)) {
    failures.push({
      code: "bundle-identifier-platform-override",
      path: `${entry.path}#identifier`,
      actual: entry.identifier,
    });
  }
  return {
    expected: EXPECTED_BUNDLE_IDENTIFIER,
    ok: failures.length === 0,
    base,
    platformOverrides,
    failures,
  };
}

function cargoWorkspaceVersion(raw) {
  const section = raw.match(/\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
  return section.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

function localCargoLockVersions(raw) {
  return raw
    .split(/(?=\[\[package\]\])/g)
    .filter((block) => block.startsWith("[[package]]") && !/^source\s*=/m.test(block))
    .map((block) => ({
      name: block.match(/^name\s*=\s*"([^"]+)"/m)?.[1],
      version: block.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    }))
    .filter((entry) => entry.name?.startsWith("useful-") && entry.version);
}

export async function evaluateVersionDrift({ repoRoot = defaultRepoRoot } = {}) {
  const rootPackage = await readJson(repoRoot, "package.json");
  const expected = rootPackage.version;
  const channel = inferChannel(expected);
  assertVersionForChannel(expected, channel);

  const observations = [];
  for (const relative of PRODUCT_VERSION_FILES) {
    const value = (await readJson(repoRoot, relative)).version;
    observations.push({ path: relative, version: value, matches: value === expected });
  }

  const cargoToml = await readFile(path.join(repoRoot, "Cargo.toml"), "utf8");
  const cargoVersion = cargoWorkspaceVersion(cargoToml);
  observations.push({
    path: "Cargo.toml#[workspace.package]",
    version: cargoVersion,
    matches: cargoVersion === expected,
  });

  const cargoLock = await readFile(path.join(repoRoot, "Cargo.lock"), "utf8");
  for (const entry of localCargoLockVersions(cargoLock)) {
    observations.push({
      path: `Cargo.lock#${entry.name}`,
      version: entry.version,
      matches: entry.version === expected,
    });
  }

  const baseConfig = await readJson(repoRoot, TAURI_BASE_CONFIG);
  const platformConfigs = {};
  for (const { platform, path: relative } of TAURI_PLATFORM_CONFIGS) {
    platformConfigs[platform] = await readJson(repoRoot, relative);
  }
  const bundleIdentifier = evaluateBundleIdentifierConfiguration({ baseConfig, platformConfigs });
  const mismatches = observations.filter((entry) => !entry.matches);
  return {
    schemaVersion: "useful.version-drift.v1",
    ok: mismatches.length === 0 && bundleIdentifier.ok,
    version: expected,
    channel,
    checked: observations.length,
    bundleIdentifier,
    mismatches,
  };
}

export function parseArguments(argv) {
  let json = false;
  let repoRoot = defaultRepoRoot;
  let repoRootSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json" && !json) {
      json = true;
      continue;
    }
    if (token === "--repo-root" && !repoRootSet) {
      const value = argv[index + 1];
      if (!value) throw new Error("--repo-root requires a path");
      repoRoot = path.resolve(value);
      repoRootSet = true;
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${token}`);
  }
  return { json, repoRoot };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await evaluateVersionDrift({ repoRoot: options.repoRoot });
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.ok) process.stdout.write(`Useful ${result.version} (${result.channel})：版本一致\n`);
  else {
    process.stderr.write(`版本漂移：期望 ${result.version}\n`);
    for (const item of result.mismatches) {
      process.stderr.write(`- ${item.path}: ${item.version ?? "missing"}\n`);
    }
    for (const failure of result.bundleIdentifier.failures) {
      process.stderr.write(`- ${failure.path}: ${failure.code}\n`);
    }
  }
  process.exitCode = result.ok ? 0 : 1;
}

const directEntry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directEntry === modulePath) await main();
