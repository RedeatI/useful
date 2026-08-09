// 哈希计算：SHA-1/256/384/512 走 Web Crypto SubtleCrypto（无第三方依赖）。
// MD5 不在 Web Crypto 中，且已不安全，故不提供——UI 只暴露 SHA 家族。
import {
  HASH_ALGORITHMS,
  runHashAction,
  type HashAlgorithm,
} from "@useful/action-runtime/browser";

export type HashAlgo = HashAlgorithm;

export const HASH_ALGOS: readonly HashAlgo[] = HASH_ALGORITHMS;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 计算文本的哈希（hex 小写）。 */
export async function hashText(algo: HashAlgo, text: string): Promise<string> {
  return (await runHashAction({ algorithm: algo, text })).digest;
}

/** 计算字节的哈希（hex 小写），供文件哈希复用。 */
export async function hashBytes(algo: HashAlgo, bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest(algo, bytes);
  return toHex(digest);
}
