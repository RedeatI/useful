import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";
import { buildPluginExample } from "./build-plugin-example.mjs";
import {
  cmdAddPackage,
  cmdExportStatic,
  cmdInit,
  cmdPublish,
  cmdValidate,
} from "../packages/useful-cli/bin/source/source.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const outputRoot = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("用法: node scripts/prepare-plugin-static-lifecycle.mjs <证据目录>");
}

const sourceWork = path.join(outputRoot, "source-work");
const sourceV1 = path.join(outputRoot, "source-v1");
const sourceV2 = path.join(outputRoot, "source-v2");
const liveSource = path.join(outputRoot, "source-live");
const buildRoot = path.join(outputRoot, "build");
const packageRoot = path.join(outputRoot, "packages");
fs.mkdirSync(packageRoot, { recursive: true });

const examples = [
  { name: "base64", source: "examples/base64-tool" },
  { name: "file-hash", source: "examples/file-hash-tool" },
  { name: "qr-code", source: "examples/qr-code-tool" },
];

function packDirectory(directory, destination) {
  const zip = new AdmZip();
  zip.addLocalFolder(directory);
  zip.writeZip(destination);
  return fs.readFileSync(destination);
}

const packages = [];
for (const example of examples) {
  const builtV1 = path.join(buildRoot, example.name, "1.0.0");
  await buildPluginExample(path.join(repoRoot, example.source), builtV1);
  const manifestV1 = JSON.parse(fs.readFileSync(path.join(builtV1, "manifest.json"), "utf8"));
  manifestV1.version = "1.0.0";
  fs.writeFileSync(path.join(builtV1, "manifest.json"), `${JSON.stringify(manifestV1, null, 2)}\n`);
  const packageV1 = path.join(packageRoot, `${manifestV1.id}-1.0.0.useful`);
  const bytesV1 = packDirectory(builtV1, packageV1);

  const builtV2 = path.join(buildRoot, example.name, "1.1.0");
  fs.cpSync(builtV1, builtV2, { recursive: true });
  const manifestV2 = { ...manifestV1, version: "1.1.0" };
  if (example.addedPermission) {
    manifestV2.permissions = [...new Set([...(manifestV2.permissions ?? []), example.addedPermission])];
  }
  fs.writeFileSync(path.join(builtV2, "manifest.json"), `${JSON.stringify(manifestV2, null, 2)}\n`);
  const packageV2 = path.join(packageRoot, `${manifestV2.id}-1.1.0.useful`);
  const bytesV2 = packDirectory(builtV2, packageV2);
  packages.push({
    id: manifestV1.id,
    name: manifestV1.name,
    v1: { path: packageV1, sha256: createHash("sha256").update(bytesV1).digest("hex") },
    v2: { path: packageV2, sha256: createHash("sha256").update(bytesV2).digest("hex") },
    addedPermission: example.addedPermission ?? null,
  });
}

cmdInit(sourceWork, {
  id: "com.useful.phase12-static",
  name: "Useful Phase 12.1 Static Lifecycle",
  operator: "Useful Test Publisher",
  baseUrl: pathToFileURL(liveSource).href,
});
for (const plugin of packages) cmdAddPackage(sourceWork, plugin.v1.path, { channel: "stable" });
cmdPublish(sourceWork);
await cmdValidate(sourceWork);
cmdExportStatic(sourceWork, sourceV1);

for (const plugin of packages) cmdAddPackage(sourceWork, plugin.v2.path, { channel: "stable" });
cmdPublish(sourceWork);
await cmdValidate(sourceWork);
cmdExportStatic(sourceWork, sourceV2);

const configText = fs.readFileSync(path.join(sourceWork, "source-config.yaml"), "utf8");
const publisherKeyId = /^publisherKeyId:\s*(.+)$/m.exec(configText)?.[1]?.trim();
if (!publisherKeyId) throw new Error("静态源配置缺少 publisherKeyId");
const evidence = {
  scenario: "three-plugin-static-tuf-lifecycle",
  sourceId: "com.useful.phase12-static",
  publisherKeyId,
  sourceV1,
  sourceV2,
  liveSource,
  packages,
};
fs.writeFileSync(path.join(outputRoot, "fixture.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`FIXTURE=${path.join(outputRoot, "fixture.json")}`);
