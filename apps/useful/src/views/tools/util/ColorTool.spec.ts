import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { setLocale } from "@/i18n";
import ColorTool from "./ColorTool.vue";

const runtime = vi.hoisted(() => ({ runColorAction: vi.fn() }));
vi.mock("@useful/action-runtime/browser", () => runtime);

const blue = {
  hex: "#3b82f6",
  rgb: { r: 59, g: 130, b: 246 },
  hsl: { h: 217, s: 91, l: 60 },
};
const red = {
  hex: "#ff0000",
  rgb: { r: 255, g: 0, b: 0 },
  hsl: { h: 0, s: 100, l: 50 },
};

function copyButtons(wrapper: ReturnType<typeof mount>) {
  return ["hex", "rgb", "hsl", "css"].map((format) =>
    wrapper.get(`[data-testid="color-copy-${format}"]`));
}

describe("ColorTool CSS handoff", () => {
  beforeEach(async () => {
    await setLocale("zh-CN");
    runtime.runColorAction.mockReset();
    runtime.runColorAction.mockImplementation(({ hex }: { hex: string }) => {
      if (hex === "#3b82f6") return blue;
      if (hex === "#ff0000" || hex === "#f00") return red;
      throw Object.assign(new Error("invalid"), { actionCode: "INPUT_INVALID" });
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("uses only the typed shared Action and never writes clipboard on mount, text input, or picker input", async () => {
    const wrapper = mount(ColorTool);
    const writeText = vi.mocked(navigator.clipboard.writeText);
    expect(runtime.runColorAction).toHaveBeenCalledWith({ hex: "#3b82f6" });
    expect(writeText).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="color-input"]').setValue("#f00");
    expect(runtime.runColorAction).toHaveBeenLastCalledWith({ hex: "#f00" });
    expect(wrapper.get('[data-testid="color-rgb-value"]').text()).toBe("rgb(255 0 0)");
    expect(wrapper.get('[data-testid="color-hsl-value"]').text()).toBe("hsl(0 100% 50%)");
    expect(writeText).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="color-picker"]').setValue("#ff0000");
    expect(runtime.runColorAction).toHaveBeenLastCalledWith({ hex: "#ff0000" });
    expect(writeText).not.toHaveBeenCalled();
    for (const button of copyButtons(wrapper)) {
      expect(button.attributes("type")).toBe("button");
      expect(button.attributes("aria-label")).toBeTruthy();
    }
  });

  it("copies only four explicit CSS handoff values with LF and no trailing newline", async () => {
    const wrapper = mount(ColorTool);
    const writeText = vi.mocked(navigator.clipboard.writeText);
    for (const button of copyButtons(wrapper)) await button.trigger("click");
    expect(writeText.mock.calls.map(([value]) => value)).toEqual([
      "#3b82f6",
      "rgb(59 130 246)",
      "hsl(217 91% 60%)",
      "--color-hex: #3b82f6;\n--color-rgb: rgb(59 130 246);\n--color-hsl: hsl(217 91% 60%);",
    ]);
    const css = writeText.mock.calls[3][0];
    expect(css.split("\n")).toHaveLength(3);
    expect(css.endsWith("\n")).toBe(false);
  });

  it("disables every copy action for empty or invalid input", async () => {
    const wrapper = mount(ColorTool);
    await wrapper.get('[data-testid="color-input"]').setValue("");
    for (const button of copyButtons(wrapper)) expect(button.attributes()).toHaveProperty("disabled");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="color-input"]').setValue("red");
    for (const button of copyButtons(wrapper)) expect(button.attributes()).toHaveProperty("disabled");
    expect(wrapper.text()).toContain("不是合法的 HEX 颜色");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("announces success only after resolution and never on rejection", async () => {
    let resolveCopy!: () => void;
    const pending = new Promise<void>((resolve) => { resolveCopy = resolve; });
    const writeText = vi.mocked(navigator.clipboard.writeText);
    writeText.mockReturnValueOnce(pending);
    const wrapper = mount(ColorTool);

    await wrapper.get('[data-testid="color-copy-hex"]').trigger("click");
    expect(wrapper.get('[data-testid="color-copy-status"]').text()).toBe("");
    resolveCopy();
    await flushPromises();
    expect(wrapper.get('[data-testid="color-copy-status"]').text()).toBe("已复制HEX。");

    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    await wrapper.get('[data-testid="color-copy-rgb"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="color-copy-status"]').text()).toBe("写入剪贴板失败，请检查剪贴板权限后重试。");
    expect(wrapper.get('[data-testid="color-copy-status"]').text()).not.toContain("已复制");
  });
});
