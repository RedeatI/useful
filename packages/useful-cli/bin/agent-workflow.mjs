import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { loadLocalPluginActions } from "@useful/plugin-actions";
import { validateManifest } from "./validate.mjs";
import { USEFUL_LIMITS } from "./useful-limits.mjs";
import { securityError, usageError, validationError } from "./cli-contract.mjs";

const CLI_PACKAGE = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const SAFE_TEMPLATES = Object.freeze({
  "minimal-web": { permissions: [], label: "零权限最小 Web 工具" },
  "minimal-action": { permissions: [], label: "零权限声明式 pipeline-v1 Action 工具" },
  "starter-web": { permissions: [], label: "零 native 权限、带宿主就绪握手的 Web 工具" },
});
const FORBIDDEN_DIRECTORIES = new Set([".git", "node_modules", "dist-useful"]);
const SAFE_ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function checkText(value, field, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw usageError("INVALID_OPTION", `${field} 不能为空`, { field });
  }
  if (value.length > maxLength || hasControlCharacters(value)) {
    throw usageError("INVALID_OPTION", `${field} 包含控制字符或超过 ${maxLength} 字符`, { field, maxLength });
  }
  return value.trim();
}

function defaultIdFromDirectory(dir) {
  const slug = path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[^a-z]+/, "");
  return `com.example.${slug || "tool"}`;
}

function htmlEscape(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function iconBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
}

function starterScript(displayName) {
  return `const out = document.getElementById("out");
let seq = 0;
const pending = new Map();
const capability = new URLSearchParams(location.hash.slice(1)).get("usefulCapability");
if (!capability || !/^[0-9a-f]{64}$/.test(capability)) throw new Error("缺少 Useful 宿主 bootstrap secret");
const portPromise = new Promise((resolve, reject) => {
  const channel = new MessageChannel();
  const port = channel.port1;
  const timeout = setTimeout(() => {
    port.close();
    reject(new Error("宿主 bootstrap 超时"));
  }, 5000);
  port.onmessage = ({ data }) => {
    if (!data || data.__usefulBootstrap !== true || data.capability !== capability || data.ok !== true) return;
    clearTimeout(timeout);
    port.onmessage = ({ data: response }) => {
      if (!response || response.__usefulRpc !== true || !("ok" in response)) return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      response.ok ? request.resolve(response.result) : request.reject(new Error(response.error));
    };
    port.start();
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* opaque origin */ }
    resolve(port);
  };
  port.start();
  window.parent.postMessage({ __usefulBootstrap: true, capability }, "*", [channel.port2]);
});
async function call(method, params) {
  const port = await portPromise;
  const id = String(seq++);
  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ __usefulRpc: true, id, method, params });
  });
}
call("plugin.ready", { template: "starter-web", permissions: [] }).then(() => {
  out.textContent = "宿主握手完成；此模板不申请 native 权限。";
}).catch((error) => {
  out.textContent = "宿主握手失败: " + error.message;
});
document.title = ${JSON.stringify(displayName)};
`;
}

function minimalScript(displayName) {
  return `document.getElementById("status").textContent = ${JSON.stringify(`${displayName} 已就绪（零权限）`)};\n`;
}

export function createToolScaffold(directory, options = {}) {
  const dir = path.resolve(directory);
  if (fs.existsSync(dir)) {
    throw securityError("TARGET_EXISTS", `目标目录已存在: ${dir}`, { path: dir });
  }
  const template = options.template ?? "minimal-web";
  if (!Object.hasOwn(SAFE_TEMPLATES, template)) {
    throw usageError("UNKNOWN_TEMPLATE", `未知模板: ${template}`, { allowed: Object.keys(SAFE_TEMPLATES) });
  }
  const displayName = checkText(options.displayName ?? options.name ?? path.basename(dir), "name", 128);
  const description = checkText(options.description ?? `${displayName} - 由 Useful CLI 生成`, "description", 1024);
  const id = options.id ?? defaultIdFromDirectory(dir);
  if (!ID_PATTERN.test(id) || id.length > 128) {
    throw usageError("INVALID_TOOL_ID", `非法工具 ID: ${id}`, { field: "id", pattern: ID_PATTERN.source });
  }
  const permissions = [...SAFE_TEMPLATES[template].permissions];
  const manifest = {
    schemaVersion: 1,
    id,
    name: displayName,
    version: "1.0.0",
    description,
    icon: "assets/icon.png",
    entry: { type: "web", path: "index.html" },
    contributes: { sidebar: [{ id: "main", title: displayName, group: "installed", order: 100 }] },
    permissions,
    platforms: ["windows-x64"],
    minHostVersion: CLI_PACKAGE.version,
  };
  const declarativeAction = template === "minimal-action";
  const actionId = `${id}.base64-sha256`;
  if (declarativeAction) manifest.contributes.actions = [{ actionId, path: "actions/base64-sha256.json" }];
  const escapedName = htmlEscape(displayName);
  const interactive = template === "starter-web";
  const body = interactive
    ? `<p>这是一个零 native 权限的 Useful web 工具示例。</p>\n    <pre id="out">正在进行宿主握手…</pre>`
    : `<p id="status">正在初始化…</p>`;
  const script = interactive ? starterScript(displayName) : minimalScript(displayName);
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedName}</title>
    <style>body { font-family: system-ui, "Microsoft YaHei"; padding: 24px; } button { padding: 8px 16px; }</style>
  </head>
  <body>
    <h1>${escapedName}</h1>
    ${body}
    <script>${script.replace(/<\/script/gi, "<\\/script")}</script>
  </body>
</html>
`;
  try {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    if (declarativeAction) fs.mkdirSync(path.join(dir, "actions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
    fs.writeFileSync(path.join(dir, "assets", "icon.png"), iconBytes());
    if (declarativeAction) {
      const actionSpec = {
        schemaVersion: "useful.plugin-action.v1",
        title: "Base64 then SHA-256",
        description: "Encode UTF-8 text as Base64, then hash that encoded text with SHA-256.",
        keywords: ["base64", "sha256", "pipeline"],
        aliases: [],
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string", maxLength: 262144 } },
          required: ["text"],
        },
        outputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          properties: {
            algorithm: { type: "string", const: "SHA-256" },
            digest: { type: "string", minLength: 64, maxLength: 64 },
            encoding: { type: "string", const: "hex" },
          },
          required: ["algorithm", "digest", "encoding"],
        },
        examples: [{
          name: "hash Base64 of abc",
          input: { text: "abc" },
          output: { algorithm: "SHA-256", digest: "35d95694d3f160215db293c7899daa5907837838fb4b8119ed713e32446c1266", encoding: "hex" },
        }],
        testVectors: [{
          name: "hash Base64 of abc",
          input: { text: "abc" },
          expectedOutput: { algorithm: "SHA-256", digest: "35d95694d3f160215db293c7899daa5907837838fb4b8119ed713e32446c1266", encoding: "hex" },
        }],
        execution: { timeoutMs: 2000, maxInputBytes: 1048576, maxOutputBytes: 1024 },
        pipeline: {
          steps: [
            { id: "encode", actionId: "builtin.utilities.base64", input: { operation: "encode", text: { $ref: "/input/text" } } },
            { id: "hash", actionId: "builtin.utilities.hash", input: { algorithm: "SHA-256", text: { $ref: "/steps/encode/output/text" } } },
          ],
          output: { $ref: "/steps/hash/output" },
        },
      };
      fs.writeFileSync(path.join(dir, "actions", "base64-sha256.json"), `${JSON.stringify(actionSpec, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    throw securityError("CREATE_FAILED", `创建工具失败: ${error instanceof Error ? error.message : String(error)}`, { path: dir });
  }
  return {
    directory: dir,
    toolId: id,
    displayName,
    template,
    permissions,
    files: ["manifest.json", "index.html", "assets/icon.png", ...(declarativeAction ? ["actions/base64-sha256.json"] : [])],
    ...(declarativeAction ? { actionId } : {}),
  };
}

function resultCheck(id, status, message, remediation = null, details = null) {
  return { id, status, message, remediation, details };
}

function isUnsafeRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return true;
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").includes("..");
}

function resolveInside(root, relative) {
  if (isUnsafeRelative(relative)) return null;
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? resolved : null;
}

function sensitiveReason(relativePath, fullPath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized).toLowerCase();
  if ((base === ".env" || base.startsWith(".env.")) && !SAFE_ENV_EXAMPLES.has(base)) return "环境秘密文件";
  if (/^(?:id_rsa|id_ed25519|id_ecdsa)$/.test(base) || /\.key$/i.test(base) || /private.*\.pem$/i.test(base)) return "私钥文件名";
  const descriptor = fs.openSync(fullPath, "r");
  try {
    const sampleBuffer = Buffer.allocUnsafe(8192);
    const bytesRead = fs.readSync(descriptor, sampleBuffer, 0, sampleBuffer.length, 0);
    const sample = sampleBuffer.subarray(0, bytesRead).toString("utf8");
    if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(sample)) return "私钥内容";
  } finally {
    fs.closeSync(descriptor);
  }
  return null;
}

function scanTree(root) {
  const files = [];
  const issues = [];
  let totalBytes = 0;
  function visit(relative) {
    const current = relative ? path.join(root, relative) : root;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const normalized = childRelative.replace(/\\/g, "/");
      const full = path.join(root, childRelative);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        issues.push({ code: "LINK_FORBIDDEN", path: normalized, message: "符号链接或 junction 不允许打包" });
        continue;
      }
      if (entry.isDirectory()) {
        if (FORBIDDEN_DIRECTORIES.has(entry.name.toLowerCase())) {
          issues.push({ code: "FORBIDDEN_DIRECTORY", path: normalized, message: "禁止目录存在" });
          continue;
        }
        visit(childRelative);
        continue;
      }
      if (!stat.isFile()) {
        issues.push({ code: "SPECIAL_FILE", path: normalized, message: "仅允许普通文件" });
        continue;
      }
      if (entry.name.toLowerCase().endsWith(".useful")) {
        issues.push({ code: "NESTED_ARTIFACT", path: normalized, message: "禁止嵌套 .useful 产物" });
      }
      const secret = sensitiveReason(normalized, full);
      if (secret) issues.push({ code: "SECRET_FILE", path: normalized, message: secret });
      totalBytes += stat.size;
      files.push({ fullPath: full, path: normalized, size: stat.size });
    }
  }
  visit("");
  return { files, issues, totalBytes };
}

function fileTargetCheck(root, manifest, field, checks) {
  const relative = field === "entry" ? manifest?.entry?.path : manifest?.icon;
  const id = `${field}-path`;
  if (typeof relative !== "string" || !relative) {
    if (field === "icon" && relative === undefined) {
      checks.push(resultCheck(id, "warning", "icon 未声明；legacy manifest 允许缺省", "可选：在工具根目录内添加 icon 并声明安全相对路径"));
    } else {
      checks.push(resultCheck(id, "fail", `${field} 路径缺失`, `在 manifest.json 中声明有效的 ${field} 相对路径`));
    }
    return;
  }
  if (field === "entry" && manifest.entry.type === "launcher") {
    const targetKind = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relative) ? "url-or-scheme" : "program-or-script";
    checks.push(resultCheck(
      id,
      "pass",
      "launcher entry 是由宿主解析的程序、脚本或 URL 声明；doctor 未读取外部目标",
      null,
      { resolution: "host", targetKind },
    ));
    const declared = Array.isArray(manifest.permissions) && manifest.permissions.includes("process.launch.declared");
    checks.push(resultCheck(
      "launcher-permission",
      declared ? "pass" : "fail",
      declared ? "launcher 已声明 process.launch.declared" : "launcher 缺少 process.launch.declared 权限",
      declared ? null : "在 permissions 中显式添加 process.launch.declared；不要增加其他无关权限",
    ));
    return;
  }
  const target = resolveInside(root, relative);
  if (!target) {
    checks.push(resultCheck(id, "fail", `${field} 路径越界或不是安全相对路径`, `将 ${field} 放在工具根目录内并使用相对路径`));
    return;
  }
  try {
    const stat = fs.lstatSync(target);
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    const realRelative = path.relative(realRoot, realTarget);
    const escaped = !realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative);
    if (stat.isSymbolicLink() || !stat.isFile() || escaped) {
      checks.push(resultCheck(id, "fail", `${field} 必须是根目录内的普通文件`, `移除链接并提供普通文件: ${relative}`));
    } else {
      checks.push(resultCheck(id, "pass", `${field} 文件存在且位于工具根目录内`, null, { path: relative, sizeBytes: stat.size }));
    }
  } catch {
    checks.push(resultCheck(id, "fail", `${field} 文件不存在`, `创建文件: ${relative}`));
  }
}

export async function doctorToolDirectory(directory) {
  const root = path.resolve(directory);
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(resultCheck("node-version", nodeMajor >= 20 ? "pass" : "fail", `Node.js ${process.versions.node}`, nodeMajor >= 20 ? null : "安装 Node.js 20 或更高版本"));
  checks.push(resultCheck("cli-version", "pass", `Useful CLI ${CLI_PACKAGE.version}`));
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      checks.push(resultCheck("tool-root", "fail", "工具根路径不是普通目录", "使用真实的本地目录，不要使用链接或 junction"));
    } else checks.push(resultCheck("tool-root", "pass", "工具根目录可读取"));
  } catch {
    checks.push(resultCheck("tool-root", "fail", "工具根目录不存在或不可读取", "确认目录路径和读取权限"));
  }
  let manifest = null;
  const manifestPath = path.join(root, "manifest.json");
  try {
    const stat = fs.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("manifest.json 不是普通文件");
    if (stat.size > USEFUL_LIMITS.manifestBytes) throw new Error("manifest.json 超过 1 MiB");
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    checks.push(resultCheck("manifest-parse", "pass", "manifest.json 可解析"));
  } catch (error) {
    checks.push(resultCheck("manifest-parse", "fail", `manifest.json 无法读取或解析: ${error instanceof Error ? error.message : String(error)}`, "修复 JSON 语法并确保它是小于 1 MiB 的普通文件"));
  }
  if (manifest) {
    const validation = validateManifest(manifest);
    checks.push(resultCheck("manifest-schema", validation.valid ? "pass" : "fail", validation.valid ? "manifest Schema 与权限声明有效" : "manifest 校验失败", validation.valid ? null : "按 details 中的错误修复 manifest.json", validation.valid ? null : { errors: validation.errors }));
    checks.push(resultCheck(
      "permissions",
      manifest.permissions === undefined ? "warning" : "pass",
      manifest.permissions === undefined ? "permissions 缺省；宿主按 [] 处理" : `permissions 显式声明 ${manifest.permissions.length} 项`,
      manifest.permissions === undefined ? "建议显式写 permissions: []，便于审阅最小权限" : null,
    ));
    checks.push(resultCheck(
      "platforms",
      manifest.platforms === undefined ? "warning" : "pass",
      manifest.platforms === undefined ? "platforms 缺省；宿主按 [windows-x64] 处理" : `platforms 显式声明 ${manifest.platforms.length} 项`,
      manifest.platforms === undefined ? "建议显式写 platforms: [\"windows-x64\"]" : null,
    ));
    checks.push(resultCheck(
      "min-host-version",
      manifest.minHostVersion === undefined ? "warning" : "pass",
      manifest.minHostVersion === undefined ? "minHostVersion 缺省；宿主按 0.1.0 处理" : `minHostVersion=${manifest.minHostVersion}`,
      manifest.minHostVersion === undefined ? "建议显式声明已验证的最低宿主版本" : null,
    ));
    fileTargetCheck(root, manifest, "entry", checks);
    fileTargetCheck(root, manifest, "icon", checks);
    if (manifest.contributes?.actions !== undefined) {
      try {
        const actions = await loadLocalPluginActions(root, manifest);
        checks.push(resultCheck("plugin-actions", "pass", `${actions.length} 个声明式 action 通过 schema、pipeline 与 testVectors`));
      } catch (error) {
        checks.push(resultCheck("plugin-actions", "fail", "声明式 action 校验或 testVectors 失败", "修复 action spec、pipeline 或 testVectors", { code: typeof error?.code === "string" ? error.code : "PLUGIN_ACTION_INVALID" }));
      }
    }
  } else {
    checks.push(resultCheck("manifest-schema", "fail", "无法在解析前校验 manifest", "先修复 manifest-parse"));
  }
  let scan = { files: [], issues: [], totalBytes: 0 };
  try {
    scan = scanTree(root);
    checks.push(resultCheck("package-safety", scan.issues.length ? "fail" : "pass", scan.issues.length ? `发现 ${scan.issues.length} 个禁止打包项` : "未发现链接、秘密、禁止目录或嵌套产物", scan.issues.length ? "移除 details 中列出的禁止项；不要把秘密移入其他名称后打包" : null, scan.issues.length ? { issues: scan.issues } : null));
    const overEntry = scan.files.filter((file) => file.size > USEFUL_LIMITS.entryBytes).map((file) => file.path);
    const withinBudget = scan.files.length <= USEFUL_LIMITS.entries && scan.totalBytes <= USEFUL_LIMITS.totalUncompressedBytes && overEntry.length === 0;
    checks.push(resultCheck("package-budget", withinBudget ? "pass" : "fail", `${scan.files.length} 个文件，展开大小 ${scan.totalBytes} bytes`, withinBudget ? null : "减少文件数量或大小；单文件 64 MiB、总展开 256 MiB、4096 entries", { entryCount: scan.files.length, totalBytes: scan.totalBytes, oversizedEntries: overEntry }));
  } catch (error) {
    checks.push(resultCheck("package-safety", "fail", `目录扫描失败: ${error instanceof Error ? error.message : String(error)}`, "检查目录读取权限和特殊文件"));
  }
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  return {
    directory: root,
    toolId: manifest?.id ?? null,
    version: manifest?.version ?? null,
    checks,
    summary: { total: checks.length, passed: checks.length - failed - warnings, failed, warnings, hardFailure: failed > 0 },
    manifest,
    files: scan.files,
  };
}

function publicReport(report) {
  const publicData = { ...report };
  delete publicData.files;
  delete publicData.manifest;
  return publicData;
}

export async function doctorDataOrThrow(directory) {
  const report = await doctorToolDirectory(directory);
  const data = publicReport(report);
  if (report.summary.hardFailure) {
    throw validationError("DOCTOR_FAILED", "工具目录未通过 doctor 硬检查", { failedChecks: report.checks.filter((check) => check.status === "fail").map((check) => check.id) }, data);
  }
  return data;
}

export async function validateToolDirectory(directory) {
  const report = await doctorToolDirectory(directory);
  const relevant = report.checks.filter((check) => ["tool-root", "manifest-parse", "manifest-schema", "entry-path", "icon-path", "plugin-actions"].includes(check.id));
  const failed = relevant.filter((check) => check.status === "fail");
  const data = {
    directory: report.directory,
    toolId: report.toolId,
    version: report.version,
    valid: failed.length === 0,
    checks: relevant,
    summary: { total: relevant.length, passed: relevant.length - failed.length, failed: failed.length },
  };
  if (failed.length) throw validationError("VALIDATION_FAILED", "工具校验失败", { failedChecks: failed.map((check) => check.id) }, data);
  return data;
}

export async function packToolDirectory(directory, outputDirectory) {
  const { default: AdmZip } = await import("adm-zip");
  const report = await doctorToolDirectory(directory);
  if (report.summary.hardFailure) {
    throw validationError("PACK_PREFLIGHT_FAILED", "打包前安全检查失败", { failedChecks: report.checks.filter((check) => check.status === "fail").map((check) => check.id) }, publicReport(report));
  }
  const root = report.directory;
  const outDir = path.resolve(outputDirectory ?? root);
  const target = path.join(outDir, `${report.manifest.id}-${report.manifest.version}.useful`);
  if (fs.existsSync(target)) throw securityError("ARTIFACT_EXISTS", `产物已存在，拒绝覆盖: ${target}`, { artifactPath: target });
  const zip = new AdmZip();
  const realRoot = fs.realpathSync(root);
  for (const file of report.files) {
    const current = fs.lstatSync(file.fullPath);
    const realFile = fs.realpathSync(file.fullPath);
    const realRelative = path.relative(realRoot, realFile);
    if (current.isSymbolicLink() || !current.isFile() || current.size !== file.size || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw securityError("PACKAGE_CHANGED", `安全扫描后文件类型、大小或位置发生变化: ${file.path}`, { path: file.path });
    }
    const content = fs.readFileSync(file.fullPath);
    if (content.length !== file.size) throw securityError("PACKAGE_CHANGED", `安全扫描后文件大小发生变化: ${file.path}`, { path: file.path });
    zip.addFile(file.path, content);
  }
  const bytes = zip.toBuffer();
  if (bytes.length > USEFUL_LIMITS.archiveBytes) {
    throw securityError("ARCHIVE_TOO_LARGE", "压缩后的 .useful 超过 128 MiB", { sizeBytes: bytes.length, limitBytes: USEFUL_LIMITS.archiveBytes });
  }
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(target, bytes, { flag: "wx" });
  } catch (error) {
    throw securityError("PACK_WRITE_FAILED", `无法写入 .useful: ${error instanceof Error ? error.message : String(error)}`, { artifactPath: target });
  }
  return {
    artifactPath: target,
    toolId: report.manifest.id,
    version: report.manifest.version,
    sizeBytes: bytes.length,
    entryCount: report.files.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function templateCatalog() {
  return Object.entries(SAFE_TEMPLATES).map(([id, template]) => ({ id, ...template }));
}
