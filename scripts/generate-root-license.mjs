#!/usr/bin/env node

import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_LICENSE_GENERATOR_SCHEMA = "useful.root-license-generator.v1";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_HOLDERS = new Set([
  "useful project and contributors",
  "useful project",
  "contributors",
  "todo",
  "tbd",
  "unknown",
  "example",
]);

const DEFAULT_MAPPING = Object.freeze({
  desktopRust: "MPL-2.0",
  backend: "AGPL-3.0-or-later",
  protocolSdkCliExamples: "Apache-2.0",
  docs: "CC-BY-4.0",
});

function invalidArguments(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENTS";
  error.exitCode = 2;
  return error;
}

export function parseArguments(argv) {
  const values = new Map();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (!argument.startsWith("--")) throw invalidArguments(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw invalidArguments(`${argument} requires a value`);
    if (values.has(argument)) throw invalidArguments(`duplicate option: ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  for (const required of ["--holder", "--year", "--mapping-approval"]) {
    if (!values.has(required)) throw invalidArguments(`missing ${required}`);
  }
  return {
    json,
    repoRoot: path.resolve(values.get("--repo-root") ?? defaultRepoRoot),
    holder: values.get("--holder"),
    year: values.get("--year"),
    mappingApprovalPath: path.resolve(values.get("--mapping-approval")),
    outputRelative: values.get("--output") ?? "LICENSE",
  };
}

export function validateHolder(holder) {
  const normalized = String(holder ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length < 3) {
    throw invalidArguments("copyright holder is too short to be a verifiable legal subject");
  }
  if (FORBIDDEN_HOLDERS.has(normalized.toLowerCase())) {
    throw invalidArguments(
      "copyright holder must be an exact legal subject; generic placeholders like Useful Project and contributors are rejected",
    );
  }
  if (/[<>]/.test(normalized) || /\bhttps?:\/\//i.test(normalized)) {
    throw invalidArguments("copyright holder must not contain markup or URLs");
  }
  return normalized;
}

export function validateYear(year) {
  const value = String(year ?? "").trim();
  if (!/^(?:19|20)\d{2}(?:-(?:19|20)\d{2})?$/.test(value)) {
    throw invalidArguments("year must be YYYY or YYYY-YYYY");
  }
  if (value.includes("-")) {
    const [start, end] = value.split("-").map(Number);
    if (end < start) throw invalidArguments("year range end must not precede start");
  }
  return value;
}

export async function loadMappingApproval(absolutePath) {
  let raw;
  try {
    raw = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    const wrapped = new Error(`mapping approval is not readable JSON: ${error.message}`);
    wrapped.code = "INVALID_ARGUMENTS";
    wrapped.exitCode = 2;
    throw wrapped;
  }
  if (raw?.schemaVersion !== "useful.license-mapping-approval.v1") {
    throw invalidArguments("mapping approval schemaVersion must be useful.license-mapping-approval.v1");
  }
  if (raw.approved !== true) {
    throw invalidArguments("mapping approval.approved must be true");
  }
  if (!raw.legalReviewer || typeof raw.legalReviewer !== "string" || raw.legalReviewer.trim().length < 2) {
    throw invalidArguments("mapping approval.legalReviewer is required");
  }
  const mapping = raw.mapping ?? {};
  for (const [key, expected] of Object.entries(DEFAULT_MAPPING)) {
    if (mapping[key] !== expected) {
      throw invalidArguments(
        `mapping.${key} must be exactly ${expected} for the current recommended multi-license map; revise LICENSES.md before requesting a different map`,
      );
    }
  }
  return {
    approved: true,
    legalReviewer: raw.legalReviewer.trim(),
    reviewedOn: typeof raw.reviewedOn === "string" ? raw.reviewedOn : null,
    mapping: { ...DEFAULT_MAPPING },
  };
}

export function renderRootLicense({ holder, year, mapping }) {
  return `# Useful multi-license notice

Copyright (c) ${year} ${holder}

This repository is intentionally multi-licensed. The authoritative component map is:

- Desktop client and client-side native crates: ${mapping.desktopRust}
  (see \`apps/useful\` and \`crates/useful-*\`)
- Built-in Action implementations and local host/document-processing code: ${mapping.desktopRust}
  (see \`packages/action-runtime\`, \`packages/host-actions\`, and \`packages/office-core\`)
- Source-service backend, administration UI, shared service implementation, database migrations,
  and deployment assets: ${mapping.backend} (see \`services/source-server\`,
  \`services/source-worker\`, \`services/internal\`, \`services/migrations\`, the build files directly
  under \`services/\`, \`apps/source-admin\`, and \`deploy/*\`)
- Protocols, JSON Schema, SDK, CLI, Agent integration interfaces, static repository fixtures, and
  examples: ${mapping.protocolSdkCliExamples} (see \`packages/protocol\`, \`packages/action-contract\`,
  \`packages/agent-profile\`, \`packages/plugin-actions\`, \`packages/useful-sdk\`,
  \`packages/useful-cli\`, \`packages/useful-mcp\`, \`packages/useful-runtime\`, \`repositories/*\`, and
  \`examples/*\`)
- Project documentation: ${mapping.docs} (see \`docs/*\`, \`README.md\`, \`README.zh-CN.md\`, \`AGENTS.md\`,
  \`CONTRIBUTING.md\`, \`GOVERNANCE.md\`, \`SECURITY.md\`, and \`CODE_OF_CONDUCT.md\`)
- Remaining first-party, non-component repository automation, configuration, build metadata, and
  test fixtures not covered above: ${mapping.protocolSdkCliExamples} (including \`.github/*\`, \`scripts/*\`,
  \`config/*\`, \`fixtures/*\`, \`templates/*\`, and \`binaries/*\`)

Unless a file states otherwise, use the map above. New package or service roots must be added to the
component map explicitly before public distribution. Third-party components remain under their own
licenses; THIRD_PARTY_NOTICES.md summarizes major dependencies, while exact candidate inventories
and bundled license texts come from its SBOM or artifact-specific legal closure. License texts and
notices retain their stated terms;
trademarks are governed by TRADEMARKS.md and are not licensed by this file.

The full license texts for the SPDX identifiers above must remain available from the project
documentation and package metadata. This root file is the owner-approved copyright and mapping
notice required before a public repository or public contribution intake can begin.

This file is not legal advice.
`;
}

export async function generateRootLicense(options) {
  const holder = validateHolder(options.holder);
  const year = validateYear(options.year);
  const approval = await loadMappingApproval(options.mappingApprovalPath);
  const outputRelative = String(options.outputRelative ?? "LICENSE").replaceAll("\\", "/");
  if (outputRelative !== "LICENSE") {
    throw invalidArguments("only root LICENSE generation is supported; --output must be LICENSE");
  }
  const absolute = path.join(options.repoRoot, outputRelative);
  const body = renderRootLicense({ holder, year, mapping: approval.mapping });
  let handle;
  try {
    handle = await open(absolute, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      const exists = new Error("LICENSE already exists; refusing to overwrite");
      exists.code = "LICENSE_EXISTS";
      exists.exitCode = 4;
      throw exists;
    }
    throw error;
  }
  try {
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
  return {
    schemaVersion: ROOT_LICENSE_GENERATOR_SCHEMA,
    ok: true,
    authoritative: false,
    output: outputRelative,
    holder,
    year,
    mapping: approval.mapping,
    legalReviewer: approval.legalReviewer,
    reviewedOn: approval.reviewedOn,
    note: "Generated root LICENSE only. Package/crate SPDX fields, licenses/*.txt bodies, and counsel review remain separate hard gates.",
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await generateRootLicense(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`Wrote ${result.output} for ${result.holder} (${result.year})\n`);
    process.exitCode = 0;
  } catch (error) {
    const payload = {
      schemaVersion: ROOT_LICENSE_GENERATOR_SCHEMA,
      ok: false,
      authoritative: false,
      error: {
        code: error.code ?? "INTERNAL_ERROR",
        message: error.message,
      },
    };
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`generate-root-license failed: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 5;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
