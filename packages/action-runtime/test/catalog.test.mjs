import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import {
  ACTION_IDS,
  BUILTIN_ACTION_CATALOG,
  OFFICE_ACTION_IDS,
  findBuiltinActionMetadata,
} from "@useful/action-runtime/catalog";
import { BUILTIN_ACTION_DESCRIPTORS } from "../src/browser.mjs";

const PUBLIC_CATALOG_SHA256 = "67d706a7ac2c0382dbaabbaed1a3b89bac9db96363170202b83ca2618ba71502";

function publicCatalogProjection(metadata) {
  return {
    contractVersion: metadata.contractVersion,
    actionId: metadata.actionId,
    version: metadata.version,
    source: {
      kind: metadata.source.kind,
      toolId: metadata.source.toolId,
      publisher: {
        id: metadata.source.publisher.id,
        name: metadata.source.publisher.name,
      },
    },
    title: metadata.title,
    description: metadata.description,
    keywords: [...metadata.keywords],
    aliases: [...metadata.aliases],
    execution: { mode: metadata.execution.mode },
    behavior: {
      readOnly: metadata.behavior.readOnly,
      destructive: metadata.behavior.destructive,
      idempotent: metadata.behavior.idempotent,
      openWorld: metadata.behavior.openWorld,
      sideEffects: [...metadata.behavior.sideEffects],
      requiresConfirmation: metadata.behavior.requiresConfirmation,
    },
    permissions: {
      required: [...metadata.permissions.required],
      capabilities: [...metadata.permissions.capabilities],
    },
    presentation: {
      route: metadata.presentation.route,
      icon: metadata.presentation.icon ?? null,
      category: metadata.presentation.category,
    },
  };
}

test("the 36-entry public metadata projection matches its independent golden hash", () => {
  const projection = BUILTIN_ACTION_CATALOG.map(publicCatalogProjection);
  assert.equal(projection.length, 36);
  assert.equal(
    createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    PUBLIC_CATALOG_SHA256,
  );
});

test("the public catalog and browser descriptors share one metadata source", () => {
  assert.equal(BUILTIN_ACTION_CATALOG.length, 36);
  assert.deepEqual(
    BUILTIN_ACTION_CATALOG.map(({ actionId }) => actionId),
    BUILTIN_ACTION_DESCRIPTORS.map(({ actionId }) => actionId),
  );
  assert.deepEqual(
    new Set(BUILTIN_ACTION_CATALOG.map(({ actionId }) => actionId)),
    new Set([...Object.values(ACTION_IDS), ...Object.values(OFFICE_ACTION_IDS)]),
  );

  for (const descriptor of BUILTIN_ACTION_DESCRIPTORS) {
    const metadata = findBuiltinActionMetadata(descriptor.actionId);
    assert.ok(metadata, descriptor.actionId);
    assert.deepEqual(
      {
        contractVersion: descriptor.contractVersion,
        actionId: descriptor.actionId,
        version: descriptor.version,
        title: descriptor.title,
        description: descriptor.description,
        keywords: descriptor.keywords,
        aliases: descriptor.aliases,
        source: {
          kind: descriptor.source.kind,
          toolId: descriptor.source.toolId,
          publisher: descriptor.source.publisher,
        },
        execution: { mode: descriptor.execution.mode },
        behavior: descriptor.behavior,
        permissions: descriptor.permissions,
        presentation: descriptor.presentation,
      },
      metadata,
      descriptor.actionId,
    );
  }
});

test("the catalog browser graph excludes handlers, YAML, and the full runtime", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/catalog.mjs", import.meta.url))],
    bundle: true,
    format: "esm",
    metafile: true,
    platform: "browser",
    treeShaking: true,
    write: false,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
  const forbidden = [
    "/browser.mjs",
    "/semantics.mjs",
    "/utility-actions.mjs",
    "/office-actions.mjs",
    "/builtins.mjs",
    "/executor.mjs",
    "/node_modules/yaml/",
  ];
  for (const fragment of forbidden) {
    assert.equal(inputs.some((input) => input.includes(fragment)), false, `${fragment}: ${inputs.join(", ")}`);
  }
  assert.equal(result.outputFiles.some((file) => file.text.includes("createBrowserActionHandlers")), false);
  assert.equal(result.outputFiles.some((file) => file.text.includes("parseSafeYaml")), false);
});
