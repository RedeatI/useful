// 正则测试 Worker：在独立线程执行正则匹配，防止灾难性回溯冻结 UI 主线程。
// 支持超时和取消：超时后 Worker 自行终止并报告。

export interface RegexWorkerRequest {
  pattern: string;
  flags: string;
  text: string;
  mode: "test" | "replace";
  replacement?: string;
  timeoutMs: number;
  callId: number;
}

export interface RegexWorkerResponse {
  callId: number;
  ok: boolean;
  matches?: { index: number; match: string; groups: string[] }[];
  result?: string;
  error?: string;
  timedOut?: boolean;
}

self.onmessage = (e: MessageEvent<RegexWorkerRequest>) => {
  const req = e.data;
  const { callId, pattern, flags, text, mode, replacement, timeoutMs } = req;

  // 设置超时守卫：到时间自行终止
  const timer = setTimeout(() => {
    const resp: RegexWorkerResponse = {
      callId,
      ok: false,
      error: `正则执行超时（${timeoutMs}ms），可能存在高复杂度表达式（ReDoS 风险）`,
      timedOut: true,
    };
    (self as unknown as Worker).postMessage(resp);
    // 终止自身 Worker 线程
    self.close();
  }, timeoutMs);

  try {
    // 输入大小限制
    const MAX_TEXT = 5_000_000; // 5MB
    const MAX_PATTERN = 10_000;
    if (text.length > MAX_TEXT) {
      throw new Error(`输入文本过大（${text.length} 字符），上限 ${MAX_TEXT}。请缩短输入或使用文件模式。`);
    }
    if (pattern.length > MAX_PATTERN) {
      throw new Error(`正则表达式过长（${pattern.length} 字符），上限 ${MAX_PATTERN}。`);
    }

    if (mode === "replace") {
      const re = new RegExp(pattern, flags);
      const result = text.replace(re, replacement ?? "");
      clearTimeout(timer);
      const resp: RegexWorkerResponse = { callId, ok: true, result };
      (self as unknown as Worker).postMessage(resp);
      return;
    }

    // test 模式
    const withGlobal = flags.includes("g") ? flags : flags + "g";
    const re = new RegExp(pattern, withGlobal);
    const out: { index: number; match: string; groups: string[] }[] = [];
    let m: RegExpExecArray | null;
    let guard = 0;
    const MAX_MATCHES = 100_000;
    while ((m = re.exec(text)) !== null) {
      out.push({ index: m.index, match: m[0], groups: m.slice(1) });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (++guard > MAX_MATCHES) {
        clearTimeout(timer);
        const resp: RegexWorkerResponse = {
          callId,
          ok: false,
          error: `匹配数超过上限 ${MAX_MATCHES}，请缩小输入或优化正则`,
        };
        (self as unknown as Worker).postMessage(resp);
        return;
      }
    }
    clearTimeout(timer);
    const resp: RegexWorkerResponse = { callId, ok: true, matches: out };
    (self as unknown as Worker).postMessage(resp);
  } catch (err) {
    clearTimeout(timer);
    const resp: RegexWorkerResponse = {
      callId,
      ok: false,
      error: (err as Error).message,
    };
    (self as unknown as Worker).postMessage(resp);
  }
};
