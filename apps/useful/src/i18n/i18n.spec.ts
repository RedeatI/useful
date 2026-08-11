// i18n 单元测试。
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { nextTick, watchEffect } from "vue";
import { getLocale, resetLocaleForTests, setLocale, t } from "@/i18n";
import zhCN from "@/i18n/zh-CN";
import enUS from "@/i18n/en-US";

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
}

describe("i18n", () => {
  beforeEach(() => resetLocaleForTests());

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

  it("中文初始状态不会请求英文字典", async () => {
    const loader = vi.fn(async () => ({ default: enUS }));
    resetLocaleForTests(loader);
    expect(t("nav.home")).toBe("首页");
    await expect(setLocale("zh-CN")).resolves.toBe(true);
    expect(loader).not.toHaveBeenCalled();
  });

  it("首次切换加载英文字典，后续切换复用缓存", async () => {
    const loader = vi.fn(async () => ({ default: enUS }));
    resetLocaleForTests(loader);
    await expect(setLocale("en-US")).resolves.toBe(true);
    expect(t("nav.home")).toBe("Home");
    await setLocale("zh-CN");
    await expect(setLocale("en-US")).resolves.toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("迟到的英文加载不会覆盖更新的中文请求", async () => {
    let resolveEnglish!: (module: { default: Record<string, unknown> }) => void;
    const loader = vi.fn(() => new Promise<{ default: Record<string, unknown> }>((resolve) => {
      resolveEnglish = resolve;
    }));
    resetLocaleForTests(loader);

    const englishSwitch = setLocale("en-US");
    await expect(setLocale("zh-CN")).resolves.toBe(true);
    resolveEnglish({ default: enUS });

    await expect(englishSwitch).resolves.toBe(false);
    expect(getLocale()).toBe("zh-CN");
    expect(t("nav.home")).toBe("首页");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("英文加载失败时保留当前语言且不泄漏异常", async () => {
    resetLocaleForTests(vi.fn().mockRejectedValue(new Error("chunk unavailable")));
    await expect(setLocale("en-US")).resolves.toBe(false);
    expect(getLocale()).toBe("zh-CN");
    expect(t("nav.home")).toBe("首页");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("切换语言并响应式同步 html lang", async () => {
    expect(getLocale()).toBe("zh-CN");
    let rendered = "";
    const stop = watchEffect(() => { rendered = t("nav.home"); });
    await setLocale("en-US");
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

  it("Office 补强操作在双语字典中保持闭集", async () => {
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
      await setLocale(locale);
      for (const key of officeKeys) expect(t(key)).not.toBe(key);
    }
  });

  it("生产入口静态图不含英文字典且保留动态 import", async () => {
    const appRoot = process.cwd();
    const packageJson = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8")) as { name?: string };
    expect(packageJson.name).toBe("@useful/app");
    const checker = String.raw`
      import { build } from "esbuild";
      const normalize = (value) => value.replaceAll(String.fromCharCode(92), "/");
      const result = await build({
        entryPoints: [process.argv[1]],
        bundle: true,
        external: ["vue"],
        format: "esm",
        logLevel: "silent",
        metafile: true,
        outdir: "i18n-metafile-out",
        platform: "browser",
        splitting: true,
        treeShaking: true,
        write: false,
      });
      const entryOutput = Object.values(result.metafile.outputs).find(
        (output) => output.entryPoint && normalize(output.entryPoint).endsWith("/i18n/index.ts"),
      );
      const staticInputs = entryOutput ? Object.keys(entryOutput.inputs).map(normalize) : [];
      const indexInput = Object.entries(result.metafile.inputs).find(
        ([input]) => normalize(input).endsWith("/i18n/index.ts"),
      )?.[1];
      const englishImport = indexInput?.imports.find(
        (entry) => normalize(entry.path).endsWith("/i18n/en-US.ts"),
      );
      process.stdout.write(JSON.stringify({
        entryFound: Boolean(entryOutput),
        englishImportKind: englishImport?.kind ?? null,
        staticInputs,
      }));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "--eval", checker, resolve(appRoot, "src/i18n/index.ts")],
      { cwd: appRoot, encoding: "utf8" },
    );
    const graph = JSON.parse(String(stdout)) as {
      entryFound: boolean;
      englishImportKind: string | null;
      staticInputs: string[];
    };
    expect(graph.entryFound).toBe(true);
    expect(graph.staticInputs.some((input) => input.endsWith("/i18n/en-US.ts"))).toBe(false);
    expect(graph.englishImportKind).toBe("dynamic-import");
  });
});
