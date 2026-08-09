import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createRouter, createWebHistory } from "vue-router";
import { t } from "@/i18n";

const storeMocks = vi.hoisted(() => ({
  recordActionUse: vi.fn(async () => undefined),
  toggleActionFav: vi.fn(async () => undefined),
  isActionFavorite: vi.fn(() => false),
}));

vi.mock("@/stores/app", () => ({ useAppStore: () => storeMocks }));

import OfficeView from "./OfficeView.vue";

function testRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [{ path: "/tools/office/:id?", component: { template: "<div/>" } }],
  });
}

describe("OfficeView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.isActionFavorite.mockReturnValue(false);
  });

  it("renders five local-only tools and navigates by stable ID", async () => {
    const router = testRouter();
    await router.push("/tools/office");
    await router.isReady();
    const wrapper = mount(OfficeView, { global: { plugins: [router] } });
    expect(wrapper.findAll("article.office-card")).toHaveLength(5);
    expect(wrapper.findAll("button.office-card__favorite")).toHaveLength(5);
    expect(wrapper.find("button button").exists()).toBe(false);
    expect(wrapper.text()).toContain(t("office.view.subtitle"));
    expect(wrapper.text()).toContain(t("office.view.localOnly"));
    await wrapper.get('[data-tool-id="pdf"] .office-card__open').trigger("click");
    await flushPromises();
    expect(storeMocks.recordActionUse).toHaveBeenCalledTimes(1);
    expect(storeMocks.recordActionUse).toHaveBeenCalledWith("builtin.office.pdf");
    expect(router.currentRoute.value.fullPath).toBe("/tools/office/pdf");
  });

  it("provides an independently focusable favorite control", async () => {
    const wrapper = mount(OfficeView, { global: { plugins: [testRouter()] } });
    const favorite = wrapper.get('[data-tool-id="docx"] .office-card__favorite');
    expect(favorite.attributes("aria-pressed")).toBe("false");
    expect(favorite.attributes("aria-label")).toBe(t("library.favorite", {
      name: t("office.tools.docx.name"),
    }));
    await favorite.trigger("click");
    expect(storeMocks.toggleActionFav).toHaveBeenCalledWith("builtin.office.docx");
    expect(storeMocks.recordActionUse).not.toHaveBeenCalled();
  });

  it("records a directly opened office action", () => {
    mount(OfficeView, { props: { id: "markdown" }, global: { plugins: [testRouter()] } });
    expect(storeMocks.recordActionUse).toHaveBeenCalledTimes(1);
    expect(storeMocks.recordActionUse).toHaveBeenCalledWith("builtin.office.markdown");
  });

  it("shows a bounded unknown-ID state", () => {
    const wrapper = mount(OfficeView, { props: { id: "../../unknown" }, global: { plugins: [testRouter()] } });
    expect(wrapper.get('[role="alert"]').text()).toContain(t("office.view.notFoundTitle"));
    expect(wrapper.find(".office-workbench").exists()).toBe(false);
  });
});
