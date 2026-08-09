const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function propertyPath(parent, key) {
  return IDENTIFIER.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/**
 * Produce deterministic structural changes. Commercial state is intentionally absent:
 * this pure offline function keeps working after an installed package loses entitlement.
 */
export function diffJson(left, right, options = {}) {
  const maxChanges = options.maxChanges ?? 10_000;
  const maxDepth = options.maxDepth ?? 128;
  const changes = [];
  let truncated = false;

  function add(change) {
    if (changes.length >= maxChanges) {
      truncated = true;
      return false;
    }
    changes.push(change);
    return true;
  }

  function visit(before, after, path, depth) {
    if (truncated) return;
    if (depth > maxDepth) throw new Error(`JSON 嵌套超过 ${maxDepth} 层限制`);
    const beforeType = jsonType(before);
    const afterType = jsonType(after);
    if (beforeType !== afterType) {
      add({ path, kind: "type-changed", before, after, beforeType, afterType });
      return;
    }
    if (beforeType === "object") {
      const beforeObject = before;
      const afterObject = after;
      const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])].sort();
      for (const key of keys) {
        const hasBefore = Object.prototype.hasOwnProperty.call(beforeObject, key);
        const hasAfter = Object.prototype.hasOwnProperty.call(afterObject, key);
        const nextPath = propertyPath(path, key);
        if (!hasBefore) add({ path: nextPath, kind: "added", after: afterObject[key], afterType: jsonType(afterObject[key]) });
        else if (!hasAfter) add({ path: nextPath, kind: "removed", before: beforeObject[key], beforeType: jsonType(beforeObject[key]) });
        else visit(beforeObject[key], afterObject[key], nextPath, depth + 1);
        if (truncated) return;
      }
      return;
    }
    if (beforeType === "array") {
      const length = Math.max(before.length, after.length);
      for (let index = 0; index < length; index += 1) {
        const nextPath = `${path}[${index}]`;
        if (index >= before.length) add({ path: nextPath, kind: "added", after: after[index], afterType: jsonType(after[index]) });
        else if (index >= after.length) add({ path: nextPath, kind: "removed", before: before[index], beforeType: jsonType(before[index]) });
        else visit(before[index], after[index], nextPath, depth + 1);
        if (truncated) return;
      }
      return;
    }
    if (!Object.is(before, after)) add({ path, kind: "changed", before, after, beforeType, afterType });
  }

  visit(left, right, "$", 0);
  return { changes, truncated };
}

export function summarize(changes) {
  const result = { added: 0, removed: 0, changed: 0, typeChanged: 0, total: changes.length };
  for (const change of changes) {
    if (change.kind === "type-changed") result.typeChanged += 1;
    else result[change.kind] += 1;
  }
  return result;
}
