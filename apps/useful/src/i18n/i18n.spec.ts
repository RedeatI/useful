// i18n 单元测试。
import { beforeEach, describe, it, expect } from "vitest";
import { nextTick, watchEffect } from "vue";
import { t, setLocale, getLocale } from "@/i18n";
import zhCN from "@/i18n/zh-CN";
import enUS from "@/i18n/en-US";

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
}

describe("i18n", () => {
  beforeEach(() => setLocale("zh-CN"));

  it("解析点分 key", () => {
    expect(t("nav.home")).toBe("首页");
    expect(t("app.name")).toBe("Useful");
    expect(t("shop.pluginFileType")).toBe("Useful 工具包");
  });

  it("占位符替换", () => {
    expect(t("shortcut.repaired", { count: 3 })).toContain("3");
  });

  it("缺失 key 返回 key 本身", () => {
    expect(t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("即时切换语言并同步 html lang", async () => {
    expect(getLocale()).toBe("zh-CN");
    let rendered = "";
    const stop = watchEffect(() => { rendered = t("nav.home"); });
    setLocale("en-US");
    await nextTick();
    expect(getLocale()).toBe("en-US");
    expect(rendered).toBe("Home");
    expect(document.documentElement.lang).toBe("en-US");
    expect(t("shop.pluginFileType")).toBe("Useful tool package");
    stop();
  });

  it("zh-CN 与 en-US 字典 key 完全一致", () => {
    expect(keys(enUS).sort()).toEqual(keys(zhCN).sort());
  });

  it("Office 补强操作在双语字典中保持闭集", () => {
    const officeKeys = [
      "office.operations.spreadsheet.inspectXlsx",
      "office.operations.spreadsheet.inspectCsv",
      "office.operations.spreadsheet.toMarkdown",
      "office.operations.spreadsheet.fromMarkdown",
      "office.operations.pdf.inspect",
      "office.operations.pdf.extractPages",
      "office.operations.pdf.deletePages",
      "office.errors.pdfNeedsPages",
    ];
    for (const locale of ["zh-CN", "en-US"] as const) {
      setLocale(locale);
      for (const key of officeKeys) expect(t(key)).not.toBe(key);
    }
  });
});
