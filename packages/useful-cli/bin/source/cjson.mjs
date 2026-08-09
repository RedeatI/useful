// TUF 风格 canonical JSON（OLPC 规范化）：签名与 keyid 计算的确定性序列化。
// 注意：这只是序列化规则，不是密码学原语；签名/验签使用 node:crypto 的 Ed25519。

function canonicalString(s) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 按 OLPC canonical JSON 序列化（TUF 签名输入格式）。仅允许整数。 */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("canonical JSON 仅允许整数");
    return String(value);
  }
  if (typeof value === "string") return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${canonicalString(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON 不支持的类型: ${typeof value}`);
}
