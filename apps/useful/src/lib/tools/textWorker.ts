// 通用文本处理 Worker：在大输入场景下将文本处理移出主线程。
// 支持：base64 encode/decode、json format/minify、url encode/decode
// 用于 1MB+ 输入，避免主线程冻结。
import { runBase64Action, runJsonAction } from "@useful/action-runtime/browser";

export interface TextWorkerRequest {
  operation: "base64Encode" | "base64Decode" | "urlEncode" | "urlDecode" | "jsonFormat" | "jsonMinify";
  text: string;
  callId: number;
}

export interface TextWorkerResponse {
  callId: number;
  ok: boolean;
  result?: string;
  error?: string;
  durationMs?: number;
}

self.onmessage = (e: MessageEvent<TextWorkerRequest>) => {
  const { operation, text, callId } = e.data;
  const start = performance.now();

  try {
    let result: string;

    switch (operation) {
      case "base64Encode": {
        result = runBase64Action({ operation: "encode", text }).text;
        break;
      }
      case "base64Decode": {
        result = runBase64Action({ operation: "decode", text }).text;
        break;
      }
      case "urlEncode":
        result = encodeURIComponent(text);
        break;
      case "urlDecode":
        result = decodeURIComponent(text.replace(/\+/g, " "));
        break;
      case "jsonFormat": {
        result = runJsonAction({ operation: "format", text, indent: 2 }).text;
        break;
      }
      case "jsonMinify":
        result = runJsonAction({ operation: "minify", text }).text;
        break;
      default:
        throw new Error(`未知操作: ${operation}`);
    }

    const durationMs = performance.now() - start;
    const resp: TextWorkerResponse = { callId, ok: true, result, durationMs };
    (self as unknown as Worker).postMessage(resp);
  } catch (err) {
    const durationMs = performance.now() - start;
    const resp: TextWorkerResponse = {
      callId,
      ok: false,
      error: (err as Error).message,
      durationMs,
    };
    (self as unknown as Worker).postMessage(resp);
  }
};
