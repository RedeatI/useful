import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/i18n";
import { toolErrorMessage } from "./errors";

describe("toolErrorMessage", () => {
  afterEach(() => setLocale("zh-CN"));

  it("localizes exact tool errors", () => {
    setLocale("en-US");
    expect(toolErrorMessage(new Error("无法解析的日期"))).toBe("The date could not be parsed");
    expect(toolErrorMessage("至少选择一种字符集")).toBe("Select at least one character set");
  });

  it("localizes parameterized worker errors without losing limits", () => {
    setLocale("en-US");
    expect(toolErrorMessage("文件过大（600.5 MB），上限 500 MB。")).toBe(
      "The file is 600.5 MB; the limit is 500 MB.",
    );
    expect(toolErrorMessage("不是合法的 16 进制数")).toBe("The value is not valid base-16 input");
  });

  it("preserves unknown errors", () => {
    setLocale("en-US");
    expect(toolErrorMessage("opaque runtime detail")).toBe("opaque runtime detail");
  });
});
