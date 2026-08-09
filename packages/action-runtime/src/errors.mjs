import { ERROR_CODES } from "./semantics.mjs";

export { ERROR_CODES };

const SAFE_MESSAGES = Object.freeze({
  UNKNOWN_ACTION: "未知 action",
  DESCRIPTOR_INVALID: "Action descriptor 无效",
  INPUT_INVALID: "输入不符合 action schema",
  OUTPUT_INVALID: "handler 输出不符合 action schema",
  INPUT_TOO_LARGE: "输入超过 action 上限",
  OUTPUT_TOO_LARGE: "输出超过 action 上限",
  NOT_HEADLESS: "该 action 没有 headless handler",
  PERMISSION_DENIED: "调用方未获得所需权限或能力",
  CONFIRMATION_REQUIRED: "该 action 需要显式确认",
  CANCELLED: "action 已取消",
  TIMEOUT: "action 执行超时",
  ACTION_FAILED: "action 执行失败",
});

export class ActionExecutionError extends Error {
  constructor(code, options = {}) {
    super(SAFE_MESSAGES[code] ?? "action 执行失败", options.cause ? { cause: options.cause } : undefined);
    this.name = "ActionExecutionError";
    this.code = code;
    this.issues = options.issues ?? [];
    this.receipt = options.receipt;
  }
}
