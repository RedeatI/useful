import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./HomeView.vue";
import { useAppStore } from "@/stores/app";
import { t } from "@/i18n";

function createTestRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: "/", component: { template: "<div/>" } },
      { path: "/tools/utilities/:id?", component: { template: "<div/>" } },
      { path: "/tools/office/:id?", component: { template: "<div/>" } },
      { path: "/settings", component: { template: "<div/>" } },
      { path: "/sources", component: { template: "<div/>" } },
    ],
  });
}

describe("HomeView quick start", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  async function mountView() {
    const router = createTestRouter();
    await router.push("/");
    await router.isReady();
    return { router, wrapper: mount(HomeView, { global: { plugins: [router] } }) };
  }

  it("renders the four localized quick-start titles and descriptions as keyboard-operable buttons", async () => {
    const { wrapper } = await mountView();
    const items = [
      ["utilities", "tools.utilities.name", "tools.utilities.description"],
      ["office", "tools.office.name", "tools.office.description"],
      ["agent-connections", "agentConnections.title", "agentConnections.inputHint"],
      ["sources", "sourceCenter.title", "sourceCenter.subtitle"],
    ] as const;

    expect(wrapper.get('[data-testid="quick-start"]').findAll("button")).toHaveLength(4);
    for (const [id, title, description] of items) {
      const button = wrapper.get(`[data-testid="quick-start-${id}"]`);
      expect(button.attributes("type")).toBe("button");
      expect(button.text()).toContain(t(title));
      expect(button.text()).toContain(t(description));
    }
  });

  it("navigates each quick-start button to its destination", async () => {
    const { router, wrapper } = await mountView();
    const destinations = [
      ["utilities", "/tools/utilities"],
      ["office", "/tools/office"],
      ["agent-connections", "/settings#agent-connections"],
      ["sources", "/sources"],
    ] as const;

    for (const [id, destination] of destinations) {
      await wrapper.get(`[data-testid="quick-start-${id}"]`).trigger("click");
      await flushPromises();
      expect(router.currentRoute.value.fullPath).toBe(destination);
    }
  });

  it("keeps the existing recent, favorites, and built-in home sections", async () => {
    const appStore = useAppStore();
    appStore.actionRecent = ["builtin.utilities.hash"];
    appStore.actionFavorites = ["builtin.utilities.base64"];
    const { wrapper } = await mountView();

    wrapper.get('[data-home-section="recent"] .useful-section__title');
    wrapper.get('[data-home-section="favorites"] .useful-section__title');
    wrapper.get('[data-home-section="builtin"] .useful-section__title');
  });
});
