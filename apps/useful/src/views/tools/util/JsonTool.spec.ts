import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import JsonTool from "./JsonTool.vue";

describe("JsonTool explorer", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("formats, explores, filters, copies pointers, and runs the shared query action", async () => {
    const wrapper = mount(JsonTool);
    const document = '{"a/b":{"~key":[1,{"ok":true}]},"other":"value"}';
    await wrapper.get('[data-testid="json-input"]').setValue(document);
    expect(wrapper.text()).toContain('"a/b"');

    await wrapper.get('[data-testid="json-tree-tab"]').trigger("click");
    expect(wrapper.text()).toContain("/a~1b/~0key/1/ok");

    await wrapper.get('[data-testid="json-tree-search"]').setValue("ok");
    expect(wrapper.text()).toContain("/a~1b/~0key/1/ok");
    expect(wrapper.text()).not.toContain("/other");

    const pathButton = wrapper.findAll('[data-testid="json-copy-pointer"]')
      .find((button) => button.text() === "/a~1b/~0key/1/ok");
    expect(pathButton).toBeTruthy();
    await pathButton!.trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/a~1b/~0key/1/ok");

    await wrapper.get('[data-testid="json-pointer"]').setValue("/a~1b/~0key/1/ok");
    await wrapper.get('[data-testid="json-query"]').trigger("click");
    expect(wrapper.get('[data-testid="json-query-result"]').text()).toBe("true");
  });

  it("shows bounded query errors without replacing the valid tree", async () => {
    const wrapper = mount(JsonTool);
    await wrapper.get('[data-testid="json-input"]').setValue('{"items":[1]}');
    await wrapper.get('[data-testid="json-tree-tab"]').trigger("click");
    await wrapper.get('[data-testid="json-pointer"]').setValue("/items/9");
    await wrapper.get('[data-testid="json-query"]').trigger("click");
    expect(wrapper.find('[role="alert"]').text()).toContain("JSON Pointer");
    expect(wrapper.text()).toContain("/items/0");
  });
});
