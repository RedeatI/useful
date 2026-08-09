import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const bridgeDispose = vi.hoisted(() => vi.fn());
const armForLoadedDocument = vi.hoisted(() => vi.fn(() => true));
const createBridgeCapability = vi.hoisted(() => vi.fn());
const createPluginBridge = vi.hoisted(() => vi.fn(() => ({
  armForLoadedDocument,
  dispose: bridgeDispose,
  stats: vi.fn(),
})));
vi.mock("@/lib/pluginBridge", () => ({
  createBridgeCapability,
  createPluginBridge,
}));

import PluginHostView from "./PluginHostView.vue";
import { useAppStore } from "@/stores/app";

describe("PluginHostView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createBridgeCapability.mockReset();
  });

  it("puts a fresh capability only in the fragment and uses no-referrer", async () => {
    createBridgeCapability.mockReturnValue("e".repeat(64));
    setActivePinia(createPinia());
    const store = useAppStore();
    vi.spyOn(store, "toolById").mockReturnValue({ id: "plugin.test", name: "Test" } as never);
    const wrapper = mount(PluginHostView, { props: { id: "plugin.test" } });
    await vi.waitFor(() => expect(wrapper.get("iframe").attributes("src")).toContain("#usefulCapability="));
    expect(wrapper.get("iframe").attributes("referrerpolicy")).toBe("no-referrer");
    expect(createPluginBridge).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "plugin.test", capability: "e".repeat(64),
    }));
    await wrapper.get("iframe").trigger("load");
    expect(armForLoadedDocument).toHaveBeenCalledTimes(1);
    await wrapper.get("iframe").trigger("load");
    expect(bridgeDispose).toHaveBeenCalled();
    wrapper.unmount();
  });

  it("rotates the capability and bridge on a route/plugin generation change", async () => {
    createBridgeCapability
      .mockReturnValueOnce("a".repeat(64))
      .mockReturnValueOnce("b".repeat(64));
    setActivePinia(createPinia());
    const store = useAppStore();
    vi.spyOn(store, "toolById").mockImplementation((id) => ({ id, name: id } as never));
    const wrapper = mount(PluginHostView, { props: { id: "plugin.one" } });
    await vi.waitFor(() => expect(wrapper.get("iframe").attributes("src")).toContain("a".repeat(64)));
    await wrapper.setProps({ id: "plugin.two" });
    await vi.waitFor(() => expect(wrapper.get("iframe").attributes("src")).toContain("b".repeat(64)));
    expect(bridgeDispose).toHaveBeenCalled();
    expect(createPluginBridge).toHaveBeenLastCalledWith(expect.objectContaining({
      pluginId: "plugin.two",
      capability: "b".repeat(64),
    }));
    expect(wrapper.get("iframe").attributes("src")).toContain("plugin.two");
    wrapper.unmount();
  });
});
