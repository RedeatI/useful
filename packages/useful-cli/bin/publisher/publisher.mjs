import fs from "node:fs";
import path from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { inspectUsefulArtifact, signaturePayload, verifyPublisherSidecar } from "@useful/plugin-actions";
import {
  CliError,
  securityError,
  successEnvelope,
  usageError,
  writeJson,
} from "../cli-contract.mjs";

function fail(message) {
  throw new Error(message);
}

function redactKnownSecrets(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce((current, secret) => current.split(secret).join("[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactKnownSecrets(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactKnownSecrets(child, secrets)]));
  }
  return value;
}

function parseArgs(args, allowed) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split("=", 2);
    if (!allowed.has(name)) throw usageError("UNKNOWN_FLAG", `未知选项: --${name}`, { option: name });
    if (name === "json") {
      if (inline !== undefined) throw usageError("INVALID_FLAG_VALUE", "--json 不接受值", { option: "json" });
      options.json = true;
      continue;
    }
    if (inline !== undefined) options[name] = inline;
    else if (args[i + 1] && !args[i + 1].startsWith("--")) options[name] = args[++i];
    else throw usageError("MISSING_OPTION_VALUE", `--${name} 需要值`, { option: name });
  }
  return { positional, options };
}

function publicHexFromPrivate(privatePem) {
  const publicKey = createPublicKey(createPrivateKey(privatePem));
  return Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
}

function artifactInfo(usefulPath) {
  const { bytes, manifest, sha256 } = inspectUsefulArtifact(usefulPath);
  const toolId = manifest.id ?? manifest.toolId;
  if (!toolId || !manifest.version) fail("manifest 缺少 id/toolId 或 version");
  return {
    bytes,
    manifest,
    toolId,
    version: manifest.version,
    sha256,
  };
}

export function publisherInit(directory, options = {}) {
  const dir = path.resolve(directory);
  if (fs.existsSync(dir)) fail(`发布者目录已存在: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  const publisherId = options.id ?? "com.example.preview-publisher";
  const displayName = options.name ?? "Useful Preview Publisher";
  const privatePath = path.join(dir, "publisher.private.pem");
  fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "publisher.json"),
    `${JSON.stringify({ id: publisherId, displayName, keyId: `ed25519:${publicHex}` }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, ".gitignore"), "publisher.private.pem\n*.publisher-signature.json\n");
  return { dir, publisherId, displayName, keyId: `ed25519:${publicHex}`, privatePath };
}

export function publisherSign(usefulPath, privateKeyPath, outputPath) {
  const info = artifactInfo(path.resolve(usefulPath));
  const privatePem = fs.readFileSync(path.resolve(privateKeyPath), "utf8");
  const publicHex = publicHexFromPrivate(privatePem);
  const signature = sign(
    null,
    signaturePayload(info.toolId, info.version, info.sha256),
    createPrivateKey(privatePem),
  ).toString("hex");
  const receipt = {
    schemaVersion: 1,
    signatureDomain: "useful-artifact-v1",
    publisherKeyId: `ed25519:${publicHex}`,
    toolId: info.toolId,
    version: info.version,
    artifactSha256: info.sha256,
    artifactBytes: info.bytes.length,
    signature,
  };
  const destination = path.resolve(outputPath ?? `${usefulPath}.publisher-signature.json`);
  fs.writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`);
  return { ...receipt, path: destination };
}

export function publisherVerify(usefulPath, signaturePath) {
  const info = artifactInfo(path.resolve(usefulPath));
  let receipt;
  try {
    receipt = verifyPublisherSidecar({ bytes: info.bytes, manifest: info.manifest, sha256: info.sha256 }, signaturePath);
  } catch (error) {
    const messages = {
      SIGNATURE_DOMAIN_INVALID: "发布者签名域错误",
      SIGNATURE_IDENTITY_MISMATCH: "发布者签名身份与包不一致",
      SIGNATURE_ARTIFACT_MISMATCH: "发布者签名摘要或大小不一致",
      SIGNATURE_INVALID: "发布者签名验证失败",
    };
    fail(messages[error?.code] ?? "发布者签名无效");
  }
  return { valid: true, toolId: info.toolId, version: info.version, artifactSha256: info.sha256, publisherKeyId: receipt.publisherKeyId };
}

function authHeaders(options) {
  if (options.token) return { Authorization: `Bearer ${options.token}` };
  if (options["admin-token"]) return { "X-Admin-Token": options["admin-token"] };
  fail("需要 --token 或仅限开发环境的 --admin-token");
}

async function jsonRequest(server, route, options, init = {}) {
  const response = await fetch(`${server.replace(/\/$/, "")}${route}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...authHeaders(options),
      ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  // 不可信服务端可能原样回显 credential；失败结果只暴露固定 route/status。
  if (!response.ok) fail(`${route} 返回 HTTP ${response.status}`);
  let body = null;
  try { body = await response.clone().json(); } catch { body = await response.text(); }
  return body;
}

export async function publisherRegister(publisherFile, options) {
  const publisher = JSON.parse(fs.readFileSync(path.resolve(publisherFile), "utf8"));
  return jsonRequest(options.server, "/v1/admin/publishers", options, {
    method: "POST",
    body: JSON.stringify(publisher),
  });
}

export async function publisherPublish(usefulPath, signaturePath, options) {
  const useful = path.resolve(usefulPath);
  const info = artifactInfo(useful);
  const verified = publisherVerify(useful, signaturePath);
  const signature = JSON.parse(fs.readFileSync(path.resolve(signaturePath), "utf8"));
  const session = await jsonRequest(options.server, "/v1/publisher/upload-sessions", options, {
    method: "POST",
    body: JSON.stringify({ publisherKeyId: verified.publisherKeyId, sha256: info.sha256, size: info.bytes.length }),
  });
  await jsonRequest(options.server, session.uploadUrl, options, {
    method: "PUT",
    body: info.bytes,
    headers: { "Content-Type": "application/octet-stream" },
  });
  const release = await jsonRequest(options.server, "/v1/publisher/releases", options, {
    method: "POST",
    body: JSON.stringify({
      uploadSessionId: session.uploadSessionId,
      toolId: info.toolId,
      name: info.manifest.name,
      summary: info.manifest.description ?? "Useful Developer Preview tool",
      license: info.manifest.license ?? "MIT",
      version: info.version,
      channel: options.channel ?? "stable",
      platform: "windows",
      arch: "x86_64",
      accessMode: options["access-mode"] ?? "free",
      productId: options["product-id"] ?? "",
      permissions: info.manifest.permissions ?? [],
      publisherSignature: signature.signature,
    }),
  });
  const waitSeconds = Number(options["wait-seconds"] ?? 60);
  let current = release;
  for (let i = 0; i < waitSeconds && !["published", "rejected"].includes(current.status); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await jsonRequest(options.server, `/v1/publisher/releases/${release.id}`, options);
  }
  if (current.status !== "published") fail(`发布未进入 published: ${current.status}`);
  const receipt = { ...current, publisherSignatureVerified: current.publisherSignatureVerified === true };
  if (!receipt.publisherSignatureVerified) fail("服务端未确认发布者签名");
  if (options.receipt) fs.writeFileSync(path.resolve(options.receipt), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function publisherWithdraw(releaseId, options) {
  const result = await jsonRequest(options.server, `/v1/publisher/releases/${releaseId}/withdraw`, options, {
    method: "POST",
    body: JSON.stringify({ reason: options.reason ?? "" }),
  });
  if (options.receipt) fs.writeFileSync(path.resolve(options.receipt), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function publisherMain(args) {
  const [command, ...rest] = args;
  const allowedByCommand = {
    init: ["id", "name", "json"],
    sign: ["key", "out", "json"],
    verify: ["json"],
    register: ["server", "token", "admin-token", "json"],
    publish: ["signature", "server", "token", "admin-token", "channel", "access-mode", "product-id", "wait-seconds", "receipt", "json"],
    withdraw: ["server", "token", "admin-token", "reason", "receipt", "json"],
  };
  if (!Object.hasOwn(allowedByCommand, command ?? "")) {
    throw usageError("UNKNOWN_PUBLISHER_COMMAND", command ? `未知 publisher 命令: ${command}` : "缺少 publisher 命令", { command: command ?? null });
  }
  const { positional, options } = parseArgs(rest, new Set(allowedByCommand[command]));
  const jsonMode = options.json === true;
  const requireCount = (minimum, maximum, usage) => {
    if (positional.length < minimum || positional.length > maximum) {
      throw usageError("INVALID_ARGUMENTS", usage, { positionalCount: positional.length });
    }
  };
  let result;
  try {
    switch (command) {
    case "init": {
      requireCount(0, 1, "用法: useful publisher init [目录] [--id <id>] [--name <name>] [--json]");
      result = publisherInit(positional[0] ?? "publisher", options);
      if (!jsonMode) {
        console.log(`✓ 发布者已创建: ${result.keyId}`);
        console.log(`  私钥: ${result.privatePath}（不要提交或分发）`);
      }
      break;
    }
    case "sign": {
      requireCount(1, 1, "用法: useful publisher sign <artifact.useful> --key <private.pem> [--out <sidecar>] [--json]");
      if (!options.key) throw usageError("MISSING_OPTION", "publisher sign 需要 --key", { option: "key" });
      result = publisherSign(positional[0], options.key, options.out);
      if (!jsonMode) console.log(`✓ 已签名 ${result.toolId}@${result.version}: ${result.path}`);
      break;
    }
    case "verify": {
      requireCount(2, 2, "用法: useful publisher verify <artifact.useful> <sidecar.json> [--json]");
      result = publisherVerify(positional[0], positional[1]);
      if (!jsonMode) console.log(`✓ 发布者签名有效: ${result.publisherKeyId}`);
      break;
    }
    case "register": {
      requireCount(1, 1, "用法: useful publisher register <publisher.json> --server <url> --token <token> [--json]");
      if (!options.server) throw usageError("MISSING_OPTION", "publisher register 需要显式 --server", { option: "server" });
      result = await publisherRegister(positional[0], options);
      if (!jsonMode) console.log(`✓ 发布者已登记: ${result.keyId}`);
      break;
    }
    case "publish": {
      requireCount(1, 1, "用法: useful publisher publish <artifact.useful> --signature <sidecar> --server <url> --token <token> [--json]");
      if (!options.server || !options.signature) throw usageError("MISSING_OPTION", "publisher publish 需要显式 --server 和 --signature", { required: ["server", "signature"] });
      result = await publisherPublish(positional[0], options.signature, options);
      if (!jsonMode) console.log(`✓ 已发布: ${result.id} (${result.status})`);
      break;
    }
    case "withdraw": {
      requireCount(1, 1, "用法: useful publisher withdraw <release-id> --server <url> --token <token> [--json]");
      if (!options.server) throw usageError("MISSING_OPTION", "publisher withdraw 需要显式 --server", { option: "server" });
      result = await publisherWithdraw(positional[0], options);
      if (!jsonMode) console.log(`✓ 已撤回 release: ${positional[0]}`);
      break;
    }
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw securityError("PUBLISHER_IO_OR_SECURITY", error instanceof Error ? error.message : String(error));
  }
  if (jsonMode) {
    const secrets = [options.token, options["admin-token"]].filter((value) => typeof value === "string" && value.length > 0);
    writeJson(successEnvelope(`publisher ${command}`, redactKnownSecrets(result, secrets)));
  }
  return result;
}
