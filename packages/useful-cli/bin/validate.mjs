// Useful 插件包校验器（供 CLI 与测试共用）。纯 JS，无外部依赖。兼容 CLI 命令名 useful。
// 与 Rust 侧 manifest.schema.json 保持语义一致。

const KNOWN_EXACT = new Set(["process.launch.declared"]);

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLUGIN_ID = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z][a-zA-Z0-9_-]*)+$/;
const ACTION_ID_FOR_PLUGIN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function hasForbiddenDescriptionCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code === 0 || code === 127;
  });
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !/^[a-zA-Z]:/.test(normalized) && !normalized.split("/").includes("..");
}

/** 校验权限字符串。 */
export function isKnownPermission(perm) {
  if (typeof perm !== "string") return false;
  return KNOWN_EXACT.has(perm);
}

/**
 * 校验 manifest 对象。返回 { valid, errors: string[] }。
 */
export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== "object") {
    return { valid: false, errors: ["manifest 不是对象"] };
  }
  const manifestKeys = new Set(["schemaVersion", "id", "name", "version", "description", "icon", "entry", "contributes", "permissions", "platforms", "minHostVersion"]);
  if (Array.isArray(m) || Object.keys(m).some((key) => !manifestKeys.has(key))) errors.push("manifest 包含未知字段");
  if (m.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (typeof m.id !== "string" || m.id.length > 128 || !PLUGIN_ID.test(m.id)) {
    errors.push(`非法插件 id: ${m.id}`);
  }
  if (typeof m.name !== "string" || m.name.length === 0 || m.name.length > 128 || hasControlCharacters(m.name)) {
    errors.push("name 必须是 1-128 字符且不含控制字符");
  }
  if (m.description !== undefined && (typeof m.description !== "string" || m.description.length > 1024 || hasForbiddenDescriptionCharacter(m.description))) {
    errors.push("description 必须是不超过 1024 字符的安全文本");
  }
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) {
    errors.push(`非法版本号: ${m.version}`);
  }
  if (!m.entry || typeof m.entry !== "object") {
    errors.push("缺少 entry");
  } else {
    if (Array.isArray(m.entry) || Object.keys(m.entry).some((key) => !["type", "path", "args"].includes(key))) errors.push("entry 包含未知字段");
    if (!["web", "launcher", "worker"].includes(m.entry.type)) {
      errors.push(`非法 entry.type: ${m.entry.type}`);
    }
    if (typeof m.entry.path !== "string" || m.entry.path.length === 0 || m.entry.path.length > 1024 || m.entry.path.includes("\0")) {
      errors.push("entry.path 必须是 1-1024 字符且不含 NUL");
    } else if (m.entry.type !== "launcher") {
      // 路径穿越检查
      if (!isSafeRelativePath(m.entry.path)) {
        errors.push(`entry.path 不安全: ${m.entry.path}`);
      }
    }
    if (m.entry.args !== undefined && (!Array.isArray(m.entry.args) || m.entry.args.some((value) => typeof value !== "string"))) errors.push("entry.args 必须是字符串数组");
  }
  if (m.icon !== undefined && (!isSafeRelativePath(m.icon) || m.icon.length > 512)) {
    errors.push(`icon 路径不安全: ${m.icon}`);
  }
  if (m.permissions !== undefined && !Array.isArray(m.permissions)) {
    errors.push("permissions 必须是数组");
  } else if (Array.isArray(m.permissions)) {
    if (m.permissions.length > 128 || new Set(m.permissions).size !== m.permissions.length) {
      errors.push("permissions 不得超过 128 项且不能重复");
    }
    for (const p of m.permissions) {
      if (!isKnownPermission(p)) errors.push(`未知权限: ${p}`);
    }
  }
  const effectivePermissions = Array.isArray(m.permissions) ? m.permissions : [];
  if (m.entry?.type === "launcher" && !effectivePermissions.includes("process.launch.declared")) {
    errors.push("launcher 必须声明 process.launch.declared");
  }
  if (m.entry?.type !== "launcher" && effectivePermissions.length !== 0) {
    errors.push("web/worker 插件首发版本必须使用 permissions: []");
  }
  if (m.minHostVersion !== undefined && (typeof m.minHostVersion !== "string" || !SEMVER.test(m.minHostVersion))) {
    errors.push(`非法 minHostVersion: ${m.minHostVersion}`);
  }
  if (m.platforms !== undefined && !Array.isArray(m.platforms)) {
    errors.push("platforms 必须是数组");
  } else if (Array.isArray(m.platforms)) {
    for (const p of m.platforms) {
      if (!["windows-x64", "windows-arm64"].includes(p)) {
        errors.push(`未知平台: ${p}`);
      }
    }
  }
  if (m.contributes !== undefined && (!m.contributes || typeof m.contributes !== "object" || Array.isArray(m.contributes))) {
    errors.push("contributes 必须是对象");
  } else if (m.contributes && Object.keys(m.contributes).some((key) => !["sidebar", "actions"].includes(key))) {
    errors.push("contributes 包含未知字段");
  }
  if (m.contributes?.sidebar !== undefined) {
    if (!Array.isArray(m.contributes.sidebar)) errors.push("contributes.sidebar 必须是数组");
    else for (const item of m.contributes.sidebar) {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["id", "title", "group", "order"].includes(key)) || typeof item.id !== "string" || !item.id.length || typeof item.title !== "string" || !item.title.length || (item.group !== undefined && !["installed", "builtin"].includes(item.group)) || (item.order !== undefined && !Number.isInteger(item.order))) {
        errors.push("contributes.sidebar 项不符合 schema");
      }
    }
  }
  const actions = m.contributes?.actions;
  if (actions !== undefined) {
    if (!Array.isArray(actions) || actions.length > 32) {
      errors.push("contributes.actions 必须是不超过 32 项的数组");
    } else {
      const ids = new Set();
      const paths = new Set();
      for (const action of actions) {
        if (!action || typeof action !== "object" || Array.isArray(action) || Object.keys(action).some((key) => !["actionId", "path"].includes(key))) {
          errors.push("contributes.actions 项只允许 actionId 与 path");
          continue;
        }
        if (typeof action.actionId !== "string" || !ACTION_ID_FOR_PLUGIN.test(action.actionId) || !action.actionId.startsWith(`${m.id}.`) || ids.has(action.actionId)) {
          errors.push("contributes.actions actionId 必须唯一且位于插件命名空间");
        }
        if (!isSafeRelativePath(action.path) || paths.has(action.path?.replace(/\\/g, "/"))) {
          errors.push("contributes.actions path 必须是唯一安全相对路径");
        }
        ids.add(action.actionId);
        paths.add(action.path?.replace(/\\/g, "/"));
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
