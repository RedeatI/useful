import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ComputerUseProbeError,
  computerUseProbeTesting,
  runComputerUseProbe,
} from "./computer-use-probe.mjs";

const realCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "useful.mjs");
const CLI_TEST_TIMEOUT_MS = 40_000;
const sourceInstallation = Object.freeze({
  mode: "source",
  artifactVerified: false,
  sourceRevision: "ab".repeat(20),
  version: "0.1.0-beta.3",
});

function fixedResolution(installation = sourceInstallation) {
  return Object.freeze({ installation });
}

describe("useful computer-use self-probe", () => {
  it("observes the fixed fail-closed contract without fetch or invoking the browser adapter factory", async () => {
    let resolutionCount = 0;
    let adapterFactoryCalls = 0;
    let fetchCalls = 0;
    const hadFetch = Object.hasOwn(globalThis, "fetch");
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    };
    try {
      const result = await computerUseProbeTesting.executeProbe({
        resolveInstallation() {
          resolutionCount += 1;
          return fixedResolution();
        },
        browserAdapterFactory() {
          adapterFactoryCalls += 1;
          throw new Error("adapter factory must not be called");
        },
      });
      expect(result).toEqual({
        schemaVersion: "useful.computer-use-probe.v1",
        status: "success",
        claimScope: "useful-computer-use-capability-local-self-reported",
        installation: sourceInstallation,
        contract: {
          schemaVersion: "useful.computer-use.v1",
          environments: ["isolated-browser", "isolated-vm"],
          actionTypes: ["screenshot", "click", "double-click", "drag", "move", "scroll", "type", "key", "wait"],
          actionTypesSha256: "a9bce07e51d533f830833d94ddc5fd53ae7f0b837da31edc8b68f64394a10cf7",
          defaultPolicy: {
            environment: "isolated-browser",
            allowDomainsCount: 0,
            maxRedirects: 0,
            developmentMode: false,
            allowPrivateDomains: false,
          },
        },
        capabilities: {
          cliProbeAvailable: true,
          cliExecutionAvailable: false,
          defaultProviderEnabled: false,
          executableBrowserProviderPresent: false,
          isolatedVmAdapterPresent: false,
          modelAdapterPresent: false,
          actionRegistered: false,
          mcpRegistered: false,
          guiRegistered: false,
          browserAdapterInterfacePresent: true,
        },
        claims: {
          documentAuthenticated: false,
          defaultControllerDisabledObserved: true,
          hostDesktopRejectedObserved: true,
          networkUsedByProbe: false,
          userInputPerformed: false,
          hostDesktopTouched: false,
          realBrowserAttested: false,
          networkEnforcementAttested: false,
        },
      });
      expect(resolutionCount).toBe(2);
      expect(adapterFactoryCalls).toBe(0);
      expect(fetchCalls).toBe(0);
    } finally {
      if (hadFetch) globalThis.fetch = previousFetch;
      else delete globalThis.fetch;
    }
  });

  it("passes only the fixed installation identity to the protocol factory", async () => {
    let captured;
    const result = await computerUseProbeTesting.executeProbe({
      resolveInstallation: () => fixedResolution(),
      createProbe(input) {
        captured = input;
        return Object.freeze({ accepted: true });
      },
    });
    expect(captured).toEqual({ installation: sourceInstallation });
    expect(Object.keys(captured)).toEqual(["installation"]);
    expect(result).toEqual({ accepted: true });
  });

  it("fails closed if the default provider or host-desktop rejection drifts", async () => {
    await expect(computerUseProbeTesting.executeProbe({
      resolveInstallation: () => fixedResolution(),
      createController: () => ({
        policy: computerUseProbeTesting.expectedDefaultPolicy,
        createSession: async () => ({ sessionId: "unexpected" }),
      }),
    })).rejects.toMatchObject({
      code: "COMPUTER_USE_DEFAULT_PROVIDER_NOT_DISABLED",
    });

    await expect(computerUseProbeTesting.executeProbe({
      resolveInstallation: () => fixedResolution(),
      normalizePolicy: () => computerUseProbeTesting.expectedDefaultPolicy,
    })).rejects.toMatchObject({
      code: "COMPUTER_USE_HOST_DESKTOP_NOT_REJECTED",
    });
  });

  it("fails closed on contract or installation identity drift", async () => {
    await expect(computerUseProbeTesting.executeProbe({
      resolveInstallation: () => fixedResolution(),
      contract: {
        schemaVersion: "useful.computer-use.v2",
      },
    })).rejects.toBeInstanceOf(ComputerUseProbeError);

    let call = 0;
    await expect(computerUseProbeTesting.executeProbe({
      resolveInstallation() {
        call += 1;
        return fixedResolution({
          ...sourceInstallation,
          sourceRevision: call === 1 ? "ab".repeat(20) : "cd".repeat(20),
        });
      },
    })).rejects.toMatchObject({
      code: "COMPUTER_USE_INSTALLATION_IDENTITY_DRIFT",
    });
  });

  it("runs the real source CLI as one JSON document without enabling a provider", () => {
    const result = spawnSync(process.execPath, [realCli, "computer-use", "probe", "--json"], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      timeout: CLI_TEST_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, OPENAI_API_KEY: "DO_NOT_INHERIT_COMPUTER_USE_PROBE_SECRET" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("DO_NOT_INHERIT_COMPUTER_USE_PROBE_SECRET");
    expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "useful.cli.result.v1",
      ok: true,
      command: "computer-use probe",
      data: {
        schemaVersion: "useful.computer-use-probe.v1",
        status: "success",
        installation: {
          mode: "source",
          artifactVerified: false,
        },
        capabilities: {
          cliExecutionAvailable: false,
          defaultProviderEnabled: false,
          executableBrowserProviderPresent: false,
          browserAdapterInterfacePresent: true,
        },
        claims: {
          defaultControllerDisabledObserved: true,
          hostDesktopRejectedObserved: true,
          networkUsedByProbe: false,
          userInputPerformed: false,
          hostDesktopTouched: false,
          realBrowserAttested: false,
        },
      },
    });
  }, CLI_TEST_TIMEOUT_MS);

  it("rejects all provider, path, runtime, action and write overrides", () => {
    const rejected = [
      "--provider",
      "--url",
      "--launcher",
      "--module",
      "--profile",
      "--env",
      "--action",
      "--apply",
      "--config",
      "--output",
    ];
    for (const argument of rejected) {
      const result = spawnSync(
        process.execPath,
        [realCli, "computer-use", "probe", argument, "ignored", "--json"],
        { encoding: "utf8", windowsHide: true },
      );
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "computer-use probe",
        error: { code: "UNKNOWN_FLAG" },
      });
    }
    const positional = spawnSync(
      process.execPath,
      [realCli, "computer-use", "probe", "ignored", "--json"],
      { encoding: "utf8", windowsHide: true },
    );
    expect(positional.status).toBe(2);
    expect(JSON.parse(positional.stdout).error.code).toBe("INVALID_ARGUMENTS");

    const duplicate = spawnSync(
      process.execPath,
      [realCli, "computer-use", "probe", "--json", "--json"],
      { encoding: "utf8", windowsHide: true },
    );
    expect(duplicate.status).toBe(2);
    expect(JSON.parse(duplicate.stdout).error.code).toBe("DUPLICATE_FLAG");
  }, CLI_TEST_TIMEOUT_MS);

  it("keeps the existing real Agent probe at the 40-tool closure", () => {
    const result = spawnSync(process.execPath, [realCli, "agent", "probe", "--json"], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      timeout: CLI_TEST_TIMEOUT_MS,
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "agent probe",
      data: { tools: { count: 40, actionCount: 36, helperCount: 4 } },
    });
  }, CLI_TEST_TIMEOUT_MS);

  it("uses the fixed real source identity independent of cwd", async () => {
    const before = process.cwd();
    process.chdir(os.tmpdir());
    try {
      const result = await runComputerUseProbe();
      expect(result.installation).toMatchObject({
        mode: "source",
        artifactVerified: false,
        sourceRevision: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      });
    } finally {
      process.chdir(before);
    }
  });
});
