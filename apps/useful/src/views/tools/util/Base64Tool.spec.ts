import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import Base64Tool from "./Base64Tool.vue";

describe("Base64Tool accessibility", () => {
  it("labels input/output and exposes segmented selection without noisy live updates", async () => {
    const wrapper = mount(Base64Tool);
    const input = wrapper.get("#base64-input");
    expect(wrapper.get('label[for="base64-input"]').text()).toBe("输入文本");
    expect(wrapper.get('[role="group"]').attributes("aria-label")).toBe("Base64 操作");
    const buttons = wrapper.findAll(".seg__btn");
    expect(buttons[0].attributes("aria-pressed")).toBe("true");
    expect(buttons[1].attributes("aria-pressed")).toBe("false");
    await input.setValue("Useful 工具");
    const output = wrapper.get('[role="region"]');
    expect(output.attributes("aria-labelledby")).toBe("base64-output-label");
    expect(output.attributes("aria-live")).toBeUndefined();
    await buttons[1].trigger("click");
    expect(buttons[1].attributes("aria-pressed")).toBe("true");
  });
});
