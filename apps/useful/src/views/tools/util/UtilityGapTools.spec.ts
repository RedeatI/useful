import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setLocale } from "@/i18n";
import DataFormatTool from "./DataFormatTool.vue";
import TextDiffTool from "./TextDiffTool.vue";
import Ipv4Tool from "./Ipv4Tool.vue";

const runtime = vi.hoisted(() => ({ runBrowserAction: vi.fn() }));
vi.mock("@useful/action-runtime/browser", () => runtime);

describe("new utility GUI adapters", () => {
  beforeEach(async () => {
    await setLocale("zh-CN");
    runtime.runBrowserAction.mockReset();
  });

  it("converts data through the shared action ID", async () => {
    runtime.runBrowserAction.mockReturnValue({ text: "a: 1\n", format: "yaml" });
    const wrapper = mount(DataFormatTool);
    await wrapper.get("textarea").setValue('{"a":1}');
    expect(runtime.runBrowserAction).toHaveBeenLastCalledWith("builtin.utilities.data-format", {
      operation: "json-to-yaml", text: '{"a":1}', indent: 2,
    });
    expect(wrapper.text()).toContain("a: 1");
  });

  it("renders deterministic text diff output and summary", async () => {
    runtime.runBrowserAction.mockReturnValue({ summary: { added: 1, removed: 1, unchanged: 0, hunks: 1 }, hunks: [], text: "-a\n+b" });
    const wrapper = mount(TextDiffTool);
    const inputs = wrapper.findAll("textarea");
    await inputs[0].setValue("a");
    await inputs[1].setValue("b");
    expect(runtime.runBrowserAction).toHaveBeenLastCalledWith("builtin.utilities.text-diff", { before: "a", after: "b", context: 3 });
    expect(wrapper.text()).toContain("+1");
    expect(wrapper.text()).toContain("−1");
  });

  it("inspects IPv4 through the offline shared handler", () => {
    runtime.runBrowserAction.mockReturnValue({ network: "192.168.1.0", broadcast: "192.168.1.255", prefixLength: 24, totalAddresses: 256, isPrivate: true, isLoopback: false, isMulticast: false });
    const wrapper = mount(Ipv4Tool);
    expect(runtime.runBrowserAction).toHaveBeenCalledWith("builtin.utilities.ipv4", { operation: "inspect", value: "192.168.1.42/24" });
    expect(wrapper.text()).toContain("192.168.1.0/24");
    expect(wrapper.text()).toContain("192.168.1.255");
  });
});
