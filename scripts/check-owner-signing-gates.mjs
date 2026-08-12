#!/usr/bin/env node
/**
 * Reports which Owner signing / publish-gate inputs are present.
 * Never prints secret values. Safe to run in CI logs.
 *
 * Usage:
 *   node scripts/check-owner-signing-gates.mjs --json
 *   node scripts/check-owner-signing-gates.mjs --json --repo RedeatI/useful
 *
 * With GITHUB_TOKEN / gh auth, inspects remote Actions variables (names only)
 * and whether required secret *names* exist via `gh secret list` if available.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX } from "./release-publish-gate.mjs";

const REQUIRED_VARS_IDENTITY = [
  "USEFUL_EXPECTED_REPOSITORY",
  "USEFUL_RELEASE_ACTORS",
];
const REQUIRED_VARS_UPDATE = [
  "USEFUL_UPDATE_ROOT_PUBKEY_HEX",
  "USEFUL_UPDATE_FEED_URL_TEMPLATE",
  "USEFUL_UPDATE_ROOT_CEREMONY_SHA256",
];
const OPTIONAL_VARS = [
  "USEFUL_SIGNING_READY",
  "USEFUL_STABLE_UPDATE_EVIDENCE_PATH",
  "USEFUL_STABLE_UPDATE_EVIDENCE_SHA256",
  "USEFUL_MEDIA_SOURCE_EVIDENCE_PATH",
  "USEFUL_MEDIA_SOURCE_EVIDENCE_SHA256",
];
const REQUIRED_SECRETS_WINDOWS = [
  "WINDOWS_CERTIFICATE_BASE64",
  "WINDOWS_CERTIFICATE_PASSWORD",
];
const REQUIRED_SECRETS_APPLE = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_KEYCHAIN_PASSWORD",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
];

function parseArgs(argv) {
  let json = false;
  let repo = "RedeatI/useful";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--repo") {
      repo = argv[++i];
      if (!repo) throw new Error("--repo needs a value");
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/check-owner-signing-gates.mjs --json [--repo owner/name]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!json) throw new Error("--json is required");
  return { repo };
}

function runGh(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", GH_FORCE_TTY: "0", CLICOLOR: "0" },
  });
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, "");
}

function listVariableNames(repo) {
  const r = runGh([
    "api",
    `repos/${repo}/actions/variables`,
    "--paginate",
    "--jq",
    "[.variables[].name] | .[]",
  ]);
  if (!r.ok) {
    // Fallback without --jq (older gh)
    const r2 = runGh(["api", `repos/${repo}/actions/variables`, "--paginate"]);
    if (!r2.ok) return { ok: false, names: [], error: stripAnsi(r2.stderr || r.stderr).trim() || "gh api variables failed" };
    try {
      const cleaned = stripAnsi(r2.stdout);
      const rows = JSON.parse(cleaned);
      const list = Array.isArray(rows)
        ? rows.flatMap((x) => (x.variables ? x.variables : [x]))
        : rows.variables ?? [];
      const names = list.map((v) => v.name).filter(Boolean).sort();
      return { ok: true, names, error: null };
    } catch (e) {
      return { ok: false, names: [], error: String(e.message || e) };
    }
  }
  const names = stripAnsi(r.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  return { ok: true, names: [...new Set(names)], error: null };
}

function listSecretNames(repo) {
  const r = runGh(["secret", "list", "--repo", repo]);
  if (!r.ok) return { ok: false, names: [], error: r.stderr.trim() || "gh secret list failed" };
  const names = r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((n) => n && n !== "NAME");
  return { ok: true, names: [...new Set(names)].sort(), error: null };
}

function presence(names, required) {
  return Object.fromEntries(required.map((name) => [name, names.includes(name)]));
}

function allTrue(map) {
  return Object.values(map).every(Boolean);
}

function main() {
  const { repo } = parseArgs(process.argv.slice(2));
  const vars = listVariableNames(repo);
  const secrets = listSecretNames(repo);

  const varNames = vars.names;
  const secretNames = secrets.names;

  const identity = presence(varNames, REQUIRED_VARS_IDENTITY);
  const updateTrust = presence(varNames, REQUIRED_VARS_UPDATE);
  const optional = presence(varNames, OPTIONAL_VARS);
  const windowsSecrets = presence(secretNames, REQUIRED_SECRETS_WINDOWS);
  const appleSecrets = presence(secretNames, REQUIRED_SECRETS_APPLE);

  const result = {
    schemaVersion: "useful.owner-signing-gate-status.v1",
    repository: repo,
    checkedAt: new Date().toISOString(),
    githubCli: {
      variablesReadable: vars.ok,
      secretsListable: secrets.ok,
      variablesError: vars.error,
      secretsError: secrets.error,
    },
    developmentUpdateRootPubkeyHex: DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX,
    developmentUpdateRootPubkeySha256: createHash("sha256")
      .update(Buffer.from(DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX, "hex"))
      .digest("hex"),
    variablesPresent: {
      identity,
      updateTrust,
      optional,
    },
    secretsPresent: {
      windowsCodeSigning: windowsSecrets,
      appleSigningAndNotarization: appleSecrets,
    },
    summary: {
      identityReady: allTrue(identity),
      updateTrustReady: allTrue(updateTrust),
      windowsSigningSecretsReady: allTrue(windowsSecrets),
      appleSigningSecretsReady: allTrue(appleSecrets),
      signedBetaPublishReady:
        allTrue(identity) && allTrue(updateTrust) && allTrue(windowsSecrets),
      signedStableClaimReady:
        allTrue(identity)
        && allTrue(updateTrust)
        && allTrue(windowsSecrets)
        && allTrue(appleSecrets)
        && optional.USEFUL_SIGNING_READY === true,
    },
    nextOwnerActions: [],
    docs: {
      checklist: "docs/OWNER-SIGNING-GATE-CHECKLIST.md",
      ownerGates: "docs/OWNER-GATES.md",
      remainingPublicGates: "docs/OPEN-SOURCE-REMAINING-GATES.md",
    },
  };

  if (!result.summary.identityReady) {
    result.nextOwnerActions.push("Set USEFUL_EXPECTED_REPOSITORY and USEFUL_RELEASE_ACTORS Actions variables");
  }
  if (!result.summary.updateTrustReady) {
    result.nextOwnerActions.push(
      "Complete production update-root ceremony and set USEFUL_UPDATE_ROOT_PUBKEY_HEX, USEFUL_UPDATE_FEED_URL_TEMPLATE, USEFUL_UPDATE_ROOT_CEREMONY_SHA256",
    );
  }
  if (!result.summary.windowsSigningSecretsReady) {
    result.nextOwnerActions.push(
      "Add WINDOWS_CERTIFICATE_BASE64 and WINDOWS_CERTIFICATE_PASSWORD Actions secrets",
    );
  }
  if (!result.summary.appleSigningSecretsReady) {
    result.nextOwnerActions.push(
      "Add all six APPLE_* Actions secrets for macOS signing and notarization",
    );
  }
  if (result.summary.signedBetaPublishReady && !optional.USEFUL_SIGNING_READY) {
    result.nextOwnerActions.push(
      "After a green signed beta workflow, set USEFUL_SIGNING_READY=true only when stable claims are intended",
    );
  }
  if (result.nextOwnerActions.length === 0) {
    result.nextOwnerActions.push("Run release.yml on a tag with publish=true and archive SIGNING-STATUS.json");
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.summary.signedBetaPublishReady ? 0 : 2);
}

main();
