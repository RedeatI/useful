import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";

const ipcMock = vi.hoisted(() => ({
  recordActionUse: vi.fn().mockResolvedValue(undefined),
  toggleActionFavorite: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));

import UtilitiesView from "./UtilitiesView.vue";

describe("UtilitiesView keyboard-accessible favorites", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it("renders the favorite as an independent focusable button with pressed state", async () => {
    const router = createRouter({
      history: createWebHistory(),
      routes: [{ path: "/tools/utilities/:id?", component: { template: "<div/>" } }],
    });
    await router.push("/tools/utilities");
    await router.isReady();
    const wrapper = mount(UtilitiesView, { props: {}, attachTo: document.body, global: { plugins: [router] } });
    const card = wrapper.find("article.tool-card");
    const main = card.get("button.tool-card__main");
    const favorite = card.get("button.tool-card__fav");
    expect(main.find("button").exists()).toBe(false);
    expect(favorite.attributes("aria-pressed")).toBe("false");
    expect(favorite.attributes("aria-label")).toContain("收藏");
    await main.trigger("click");
    expect(ipcMock.recordActionUse).not.toHaveBeenCalled();
    (favorite.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(favorite.element);
    await favorite.trigger("click");
    expect(ipcMock.toggleActionFavorite).toHaveBeenCalled();
    wrapper.unmount();
  });

  it("records a directly opened action exactly once", () => {
    const router = createRouter({
      history: createWebHistory(),
      routes: [{ path: "/tools/utilities/:id?", component: { template: "<div/>" } }],
    });
    mount(UtilitiesView, { props: { id: "base64" }, global: { plugins: [router] } });
    expect(ipcMock.recordActionUse).toHaveBeenCalledTimes(1);
    expect(ipcMock.recordActionUse).toHaveBeenCalledWith("builtin.utilities.base64");
  });

  it("uses shared NFKC multi-token discovery and keeps relevance order stable", async () => {
    const router = createRouter({
      history: createWebHistory(),
      routes: [{ path: "/tools/utilities/:id?", component: { template: "<div/>" } }],
    });
    await router.push("/tools/utilities");
    await router.isReady();
    const wrapper = mount(UtilitiesView, { props: {}, global: { plugins: [router] } });
    const input = wrapper.get<HTMLInputElement>('input[type="text"]');

    await input.setValue("Ｂ６４ UTF-8");
    expect(wrapper.findAll("article.tool-card")).toHaveLength(1);
    expect(wrapper.text()).toContain("Base64 编解码");
    await input.setValue("编码");
    const once = wrapper.findAll("article.tool-card .tool-card__name").map((node) => node.text());
    await input.setValue("");
    await input.setValue("编码");
    expect(wrapper.findAll("article.tool-card .tool-card__name").map((node) => node.text())).toEqual(once);
    wrapper.unmount();
  });
});
