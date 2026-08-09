// TUF 风格密钥与签名：全部基于 node:crypto 的 Ed25519（不自行实现密码学原语）。
// keyid = sha256(canonicalJson(公钥对象))，与 TUF 规范一致。
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { canonicalJson } from "./cjson.mjs";

/** 生成 Ed25519 密钥对；返回 { keyid, publicHex, privatePem }。 */
export function generateKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicHex = publicKeyToHex(publicKey);
  return {
    keyid: keyidOf(publicHex),
    publicHex,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** 从 SPKI DER 提取 32 字节原始公钥的 hex（Ed25519 SPKI 前缀固定 12 字节）。 */
function publicKeyToHex(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32).toString("hex");
}

/** 从 PEM 私钥派生公钥 hex 与 keyid。 */
export function keyFromPrivatePem(privatePem) {
  const publicHex = publicKeyToHex(createPublicKey(createPrivateKey(privatePem)));
  return { keyid: keyidOf(publicHex), publicHex, privatePem };
}

/** TUF 公钥对象（固定形状，参与 keyid 计算）。 */
export function tufKeyObject(publicHex) {
  return {
    keytype: "ed25519",
    scheme: "ed25519",
    keyval: { public: publicHex },
  };
}

/** keyid = sha256(canonical(公钥对象))。 */
export function keyidOf(publicHex) {
  return createHash("sha256").update(canonicalJson(tufKeyObject(publicHex))).digest("hex");
}

/** 用 PEM 私钥对 signed 部分做 Ed25519 签名，返回 hex。 */
export function signCanonical(privatePem, signedObj) {
  const key = createPrivateKey(privatePem);
  const sig = edSign(null, Buffer.from(canonicalJson(signedObj), "utf8"), key);
  return sig.toString("hex");
}

/** 用 hex 公钥验证 signed 部分签名。 */
export function verifyCanonical(publicHex, signedObj, sigHex) {
  const spki = Buffer.concat([
    // Ed25519 SPKI 固定前缀
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(publicHex, "hex"),
  ]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return edVerify(
    null,
    Buffer.from(canonicalJson(signedObj), "utf8"),
    key,
    Buffer.from(sigHex, "hex"),
  );
}

/** Sign exact bytes for the publisher artifact domain (not canonical JSON). */
export function signBytes(privatePem, bytes) {
  return edSign(null, Buffer.from(bytes), createPrivateKey(privatePem)).toString("hex");
}

/** Verify an exact-byte Ed25519 signature using a raw public-key hex string. */
export function verifyBytes(publicHex, bytes, sigHex) {
  if (!/^[a-f0-9]{64}$/.test(publicHex) || !/^[a-f0-9]{128}$/.test(sigHex)) return false;
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(publicHex, "hex"),
  ]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return edVerify(null, Buffer.from(bytes), key, Buffer.from(sigHex, "hex"));
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
