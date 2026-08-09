// 组件测试：ToolShell 能力系统。
// 覆盖：能力按钮显示/隐藏、copy/clear/swap 事件、输入统计、错误显示。
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ToolShell from "@/components/ToolShell.vue";

describe("ToolShell 组件测试", () => {
  it("渲染标题和描述", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "测试工具", description: "测试描述" },
    });
    expect(wrapper.text()).toContain("测试工具");
    expect(wrapper.text()).toContain("测试描述");
  });

  it("显示错误消息", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", error: "出错了" },
    });
    expect(wrapper.find(".tool-shell__error").exists()).toBe(true);
    expect(wrapper.text()).toContain("出错了");
  });

  it("不显示能力按钮当 capabilities 为空", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", capabilities: {} },
    });
    expect(wrapper.find(".tool-shell__actions").exists()).toBe(true);
    expect(wrapper.findAll("button").length).toBe(0);
  });

  it("显示清空按钮当 capabilities.clear 为 true", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", capabilities: { clear: true } },
    });
    const btns = wrapper.findAll("button");
    expect(btns.length).toBe(1);
  });

  it("点击清空按钮触发 clear 事件", async () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", capabilities: { clear: true } },
    });
    await wrapper.find("button").trigger("click");
    expect(wrapper.emitted("clear")).toBeTruthy();
  });

  it("显示复制按钮当 output 非空", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", capabilities: { copy: true }, output: "result" },
    });
    const btns = wrapper.findAll("button");
    expect(btns.length).toBe(1);
  });

  it("不显示复制按钮当 output 为空", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", capabilities: { copy: true }, output: "" },
    });
    expect(wrapper.findAll("button").length).toBe(0);
  });

  it("点击交换按钮触发 swap 事件", async () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", capabilities: { swap: true } },
    });
    await wrapper.find("button").trigger("click");
    expect(wrapper.emitted("swap")).toBeTruthy();
  });

  it("文件选择输入保持可聚焦且有稳定名称", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", capabilities: { loadFile: true } },
      attachTo: document.body,
    });
    const input = wrapper.get('input[type="file"]');
    expect((input.element as HTMLInputElement).tabIndex).toBe(0);
    expect(input.attributes("aria-label")).toBeTruthy();
    expect(input.attributes("style")).toBeUndefined();
    (input.element as HTMLInputElement).focus();
    expect(document.activeElement).toBe(input.element);
    wrapper.unmount();
  });

  it("显示输入统计当 input 非空", () => {
    const wrapper = mount(ToolShell, {
      props: {
        title: "T",
        capabilities: { inputStats: true },
        input: "hello\nworld",
      },
    });
    expect(wrapper.find(".tool-shell__stats").exists()).toBe(true);
    expect(wrapper.text()).toContain("字符");
    expect(wrapper.text()).toContain("字节");
    expect(wrapper.text()).toContain("行");
  });

  it("不显示输入统计当 input 为空", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", capabilities: { inputStats: true }, input: "" },
    });
    expect(wrapper.find(".tool-shell__stats").exists()).toBe(false);
  });

  it("显示处理耗时当 processingMs > 0", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T", capabilities: { processingTime: true }, processingMs: 42 },
    });
    expect(wrapper.find(".tool-shell__time").exists()).toBe(true);
    expect(wrapper.text()).toContain("42");
  });

  it("渲染插槽内容", () => {
    const wrapper = mount(ToolShell, {
      props: { title: "T" },
      slots: { default: "<div class='custom-content'>自定义</div>" },
    });
    expect(wrapper.find(".custom-content").exists()).toBe(true);
  });
});
