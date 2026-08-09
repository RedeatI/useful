#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_CHANNELS,
  assertVersionForChannel,
  inferChannel,
} from "./version-policy.mjs";

export const RELEASE_METADATA_SCHEMA = "useful.release-metadata.v1";

export function parseStrictBoolean(value, name) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} 必须是 true 或 false`);
}
export function expectedTag(version) {
  return `v${version}`;
}

export function validateReleaseIdentity({ version, tag, channel, signingReady }) {
  if (!version) throw new Error("缺少 version");
  if (!tag) throw new Error("缺少 tag");
  if (!RELEASE_CHANNELS.includes(channel)) {
    throw new Error(`channel 必须是 ${RELEASE_CHANNELS.join("|")}: ${channel}`);
  }

  assertVersionForChannel(version, channel);
  const inferred = inferChannel(version);
  if (inferred !== channel) {
    throw new Error(`版本 ${version} 属于 ${inferred}，不能发布到 ${channel}`);
  }

  const requiredTag = expectedTag(version);
  if (tag !== requiredTag) {
    throw new Error(`tag 必须与版本严格一致：期望 ${requiredTag}，实际 ${tag}`);
  }

  const ready = parseStrictBoolean(signingReady, "signingReady");
  if (channel === "stable" && !ready) {
    throw new Error("stable 发布要求 repository variable USEFUL_SIGNING_READY=true");
  }

  return { version, tag, channel, signingReady: ready };
}

export function buildReleaseMetadata({
  version,
  tag,
  channel,
  signingReady,
  signingStatus,
}) {
  const identity = validateReleaseIdentity({
    version,
    tag,
    channel,
    signingReady,
  });
  if (!['signed', 'unsigned'].includes(signingStatus)) {
    throw new Error("signingStatus 必须是 signed 或 unsigned");
  }

  const signed = signingStatus === "signed";
  if (channel === "stable" && !signed) {
    throw new Error("stable 发布要求 Windows 签名与 macOS 签名/公证均已验证");
  }

  const unsignedPreview = !signed && channel !== "stable";
  const channelLabel = channel === "stable"
    ? ""
    : channel === "beta"
      ? " Beta"
      : " Nightly";
  const releaseName = unsignedPreview
    ? `Useful ${tag}${channelLabel} — UNSIGNED PREVIEW`
    : `Useful ${tag}${channelLabel}`;

  return {
    schemaVersion: RELEASE_METADATA_SCHEMA,
    ok: true,
    ...identity,
    signingStatus,
    signed,
    unsignedPreview,
    releaseName,
    prerelease: channel !== "stable",
    makeLatest: channel === "stable",
    warning: unsignedPreview
      ? "UNSIGNED PREVIEW: Windows code signing and macOS notarization were not both verified."
      : null,
  };
}

function parseCliArgs(args) {
  const valueOptions = new Set(["--package", "--tag", "--channel", "--signing-ready", "--signing-status", "--github-output"]);
  const flagOptions = new Set(["--identity-only"]);
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (flagOptions.has(name)) {
      if (flags.has(name)) throw new Error(`重复参数: ${name}`);
      flags.add(name);
      continue;
    }
    if (!valueOptions.has(name)) throw new Error(`未知参数: ${name ?? "<missing>"}`);
    if (values.has(name)) throw new Error(`重复参数: ${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`需要 ${name} <value>`);
    values.set(name, value);
    index += 1;
  }
  return { values, flags };
}

function valueOf(values, name) {
  if (!values.has(name)) throw new Error(`需要 ${name} <value>`);
  return values.get(name);
}

function outputLines(metadata) {
  const lines = [
    `version=${metadata.version}`,
    `tag=${metadata.tag}`,
    `channel=${metadata.channel}`,
  ];
  if (metadata.releaseName !== undefined) {
    lines.push(
      `release_name=${metadata.releaseName}`,
      `prerelease=${metadata.prerelease}`,
      `make_latest=${metadata.makeLatest}`,
      `signed=${metadata.signed}`,
      `unsigned_preview=${metadata.unsignedPreview}`,
    );
  }
  lines.push(`metadata_json=${JSON.stringify(metadata)}`);
  return lines;
}

export async function runCli(args, env = process.env) {
  const { values, flags } = parseCliArgs(args);
  const packagePath = valueOf(values, "--package");
  const packageJson = JSON.parse(await readFile(path.resolve(packagePath), "utf8"));
  const common = {
    version: packageJson.version,
    tag: valueOf(values, "--tag"),
    channel: valueOf(values, "--channel"),
    signingReady: valueOf(values, "--signing-ready"),
  };
  const identityOnly = flags.has("--identity-only");
  if (identityOnly && values.has("--signing-status")) throw new Error("--identity-only 不能与 --signing-status 同时使用");
  const metadata = identityOnly
    ? {
        schemaVersion: RELEASE_METADATA_SCHEMA,
        ok: true,
        ...validateReleaseIdentity(common),
        phase: "identity",
      }
    : buildReleaseMetadata({
        ...common,
        signingStatus: valueOf(values, "--signing-status"),
      });

  const githubOutput = values.has("--github-output")
    ? valueOf(values, "--github-output")
    : env.GITHUB_OUTPUT;
  if (githubOutput) {
    await appendFile(githubOutput, `${outputLines(metadata).join("\n")}\n`, "utf8");
  }
  return metadata;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const metadata = await runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
