#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_VERSION_FILES,
  RELEASE_CHANNELS,
  assertVersionForChannel,
  inferChannel,
} from "./version-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const version = valueOf("--version");
const requestedChannel = valueOf("--channel");
const dryRun = args.includes("--dry-run");
const jsonMode = args.includes("--json");

if (!version) throw new Error("需要 --version <SemVer>");
const channel = requestedChannel ?? inferChannel(version);
if (!RELEASE_CHANNELS.includes(channel)) throw new Error(`未知 channel: ${channel}`);
assertVersionForChannel(version, channel);

const changed = [];
for (const relative of PRODUCT_VERSION_FILES) {
  const absolute = path.join(repoRoot, relative);
  const raw = await readFile(absolute, "utf8");
  const data = JSON.parse(raw);
  if (data.version === version) continue;
  data.version = version;
  changed.push(relative);
  if (!dryRun) await writeFile(absolute, `${JSON.stringify(data, null, 2)}\n`);
}

const cargoTomlPath = path.join(repoRoot, "Cargo.toml");
const cargoToml = await readFile(cargoTomlPath, "utf8");
const nextCargoToml = cargoToml.replace(
  /(\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m,
  `$1${version}$2`,
);
if (nextCargoToml === cargoToml && !cargoToml.includes(`version = "${version}"`)) {
  throw new Error("无法定位 Cargo.toml [workspace.package].version");
}
if (nextCargoToml !== cargoToml) {
  changed.push("Cargo.toml#[workspace.package]");
  if (!dryRun) await writeFile(cargoTomlPath, nextCargoToml);
}

const lockPath = path.join(repoRoot, "Cargo.lock");
const cargoLock = await readFile(lockPath, "utf8");
let lockChanged = false;
const nextLock = cargoLock
  .split(/(?=\[\[package\]\])/g)
  .map((block) => {
    if (!block.startsWith("[[package]]") || /^source\s*=/m.test(block)) return block;
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (!name?.startsWith("useful-")) return block;
    const next = block.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
    lockChanged ||= next !== block;
    return next;
  })
  .join("");
if (lockChanged) {
  changed.push("Cargo.lock#workspace-packages");
  if (!dryRun) await writeFile(lockPath, nextLock);
}

const result = {
  schemaVersion: "useful.set-version.v1",
  ok: true,
  version,
  channel,
  dryRun,
  changed,
};
if (jsonMode) process.stdout.write(`${JSON.stringify(result)}\n`);
else process.stdout.write(`Useful ${version} (${channel})${dryRun ? " dry-run" : ""}: ${changed.length} 项变化\n`);
