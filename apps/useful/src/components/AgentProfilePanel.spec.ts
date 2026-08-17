import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import { nextTick } from "vue";
import { createDefaultBuiltinProfile, type AgentProfileV1 } from "@useful/agent-profile/browser";
import { BUILTIN_ACTION_DESCRIPTORS } from "@useful/action-runtime/browser";

const ipcMock = vi.hoisted(() => ({
  agentProfileGet: vi.fn(),
  agentProfileSave: vi.fn(),
  agentProfileExport: vi.fn().mockResolvedValue("C:\\Data Folder\\agent\\useful.agent-profile.v1.json"),
  agentProfileOpenDirectory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));

import AgentProfilePanel from "./AgentProfilePanel.vue";

const profilePath = "C:\\Data Folder\\agent\\useful.agent-profile.v1.json";
let wrapper: ReturnType<typeof mount> | null = null;

function profileFor(actionId: string): AgentProfileV1 {
  const descriptor = BUILTIN_ACTION_DESCRIPTORS.find((item) => item.actionId === actionId)!;
  return createDefaultBuiltinProfile([descriptor]);
}

async function mountPanel(profile: AgentProfileV1 | null, query = "") {
  ipcMock.agentProfileGet.mockResolvedValue(profile ? {
    profileId: profile.profileId,
    name: profile.name,
    schemaVersion: profile.schemaVersion,
    profileJson: JSON.stringify(profile),
    exportPath: profilePath,
  } : null);
  ipcMock.agentProfileSave.mockImplementation(async (profileJson: string) => {
    const saved = JSON.parse(profileJson) as AgentProfileV1;
    return {
      profileId: saved.profileId,
      name: saved.name,
      schemaVersion: saved.schemaVersion,
      profileJson,
      exportPath: profilePath,
    };
  });
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: "/settings", component: { template: "<div/>" } }],
  });
  await router.push(`/settings${query}`);
  await router.isReady();
  wrapper = mount(AgentProfilePanel, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  return { router, wrapper };
}

describe("AgentProfilePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.innerHTML = "";
  });

  it("preserves unresolved signed-plugin entries while validating builtin descriptors locally", async () => {
    const profile = profileFor("builtin.utilities.base64");
    profile.actions.push({
      actionId: "com.example.plugin.transform",
      expectedContractVersion: "1.0",
      expectedActionVersion: "1.2.3",
      expectedSourceKind: "plugin",
      expectedPublisherId: "com.example.publisher",
      enabled: { cli: true, mcp: false },
      aliases: ["plugin-transform"],
      presets: [],
    });
    const { wrapper: panel } = await mountPanel(profile);
    expect(panel.text()).toContain("Useful 不内置 AI");
    expect(panel.text()).toContain("com.example.plugin.transform");
    expect(panel.text()).toContain("需由 runtime config 验证");
    expect(panel.find(".agent-panel__error").exists() ? panel.find(".agent-panel__error").text() : "").toBe("");
    const save = panel.findAll("button").find((button) => button.text() === "保存")!;
    await save.trigger("click");
    await flushPromises();
    const saved = JSON.parse(ipcMock.agentProfileSave.mock.calls[0][0]) as AgentProfileV1;
    expect(saved.actions.map((action) => action.actionId)).toContain("com.example.plugin.transform");
  });

  it("reacts to query.action changes by adding and focusing the requested builtin", async () => {
    const profile = profileFor("builtin.utilities.base64");
    const { router } = await mountPanel(profile, "?action=builtin.utilities.base64");
    expect((document.activeElement as HTMLElement).dataset.actionId).toBe("builtin.utilities.base64");
    await router.push("/settings?action=builtin.utilities.hash");
    await flushPromises();
    expect(wrapper!.text()).toContain("builtin.utilities.hash");
    expect((document.activeElement as HTMLElement).dataset.actionId).toBe("builtin.utilities.hash");
  });

  it("adds, orders, disables, and removes bundled actions without silently expanding a saved profile", async () => {
    const profile = profileFor("builtin.utilities.base64");
    const { wrapper: panel } = await mountPanel(profile);
    expect(panel.findAll("article.agent-action")).toHaveLength(1);
    const addHash = panel.findAll("button.agent-catalog__add")
      .find((button) => button.text().includes("builtin.utilities.hash"))!;
    await addHash.trigger("click");
    expect(panel.findAll("article.agent-action")).toHaveLength(2);

    const hashCard = panel.findAll("article.agent-action")
      .find((card) => card.text().includes("builtin.utilities.hash"))!;
    const moveUp = hashCard.findAll("button")
      .find((button) => button.attributes("aria-label")?.includes("上移"))!;
    await moveUp.trigger("click");

    const disableAll = panel.findAll("button")
      .find((button) => button.text() === "全部停用")!;
    await disableAll.trigger("click");
    const save = panel.findAll("button").find((button) => button.text() === "保存")!;
    await save.trigger("click");
    await flushPromises();
    let saved = JSON.parse(ipcMock.agentProfileSave.mock.calls.at(-1)![0]) as AgentProfileV1;
    expect(saved.actions.map((action) => action.actionId)).toEqual([
      "builtin.utilities.hash",
      "builtin.utilities.base64",
    ]);
    expect(saved.actions.every((action) => !action.enabled.cli && !action.enabled.mcp)).toBe(true);

    const remove = panel.findAll("article.agent-action")[0].findAll("button")
      .find((button) => button.text() === "删除")!;
    await remove.trigger("click");
    await save.trigger("click");
    await flushPromises();
    saved = JSON.parse(ipcMock.agentProfileSave.mock.calls.at(-1)![0]) as AgentProfileV1;
    expect(saved.actions.map((action) => action.actionId)).toEqual(["builtin.utilities.base64"]);
  });

  it("uses the same recommended order as the GUI action catalog for a new profile", async () => {
    const { wrapper: panel } = await mountPanel(null);
    const actionIds = panel.findAll("article.agent-action").map((card) => card.attributes("data-action-id"));
    expect(actionIds.slice(0, 4)).toEqual([
      "builtin.utilities.json",
      "builtin.utilities.base64",
      "builtin.utilities.hash",
      "builtin.utilities.url",
    ]);
    expect(actionIds.slice(-5)).toEqual([
      "builtin.office.docx",
      "builtin.office.pptx",
      "builtin.office.spreadsheet",
      "builtin.office.pdf",
      "builtin.office.markdown",
    ]);
  });

  it("keeps optional integer defaults unset, supports preset lifecycle, and previews the fixed path", async () => {
    const profile = profileFor("builtin.utilities.json");
    profile.actions[0].presets = [{
      presetId: "format",
      name: "格式化",
      defaults: { operation: "format", indent: 2 },
    }];
    const { wrapper: panel } = await mountPanel(profile);
    let preset = panel.get("fieldset.preset-card");
    expect(preset.text()).toContain("--preset format");
    expect(preset.text()).toContain("'C:\\Data Folder\\agent\\useful.agent-profile.v1.json'");

    const indentToggle = preset.findAll<HTMLInputElement>('input[type="checkbox"]')
      .find((input) => input.element.parentElement?.textContent?.includes("缩进"))!;
    expect(indentToggle.element.checked).toBe(true);
    const number = preset.get<HTMLInputElement>('input[type="number"]');
    await number.setValue("4");
    await number.setValue("");
    await nextTick();
    expect(indentToggle.element.checked).toBe(false);
    expect(preset.find('input[type="number"]').exists()).toBe(false);

    const create = panel.findAll("button").find((button) => button.text().includes("新建方案"))!;
    await create.trigger("click");
    preset = panel.findAll("fieldset.preset-card")[1];
    const textInputs = preset.findAll<HTMLInputElement>("input");
    await textInputs[1].setValue("格式化方案");
    expect(preset.get("legend").text()).toBe("格式化方案");
    await preset.findAll("button").find((button) => button.text() === "复制方案")!.trigger("click");
    expect(panel.findAll("fieldset.preset-card")).toHaveLength(3);
    preset = panel.findAll("fieldset.preset-card")[2];
    await preset.findAll("button").find((button) => button.text() === "删除")!.trigger("click");
    expect(panel.findAll("fieldset.preset-card")).toHaveLength(2);
  });

  it("only copies commands from a saved profile", async () => {
    const profile = profileFor("builtin.utilities.json");
    profile.actions[0].presets = [{
      presetId: "format",
      name: "Format",
      defaults: { operation: "format" },
    }];
    const { wrapper: panel } = await mountPanel(profile);
    const copyCli = () => panel.findAll("button").find((button) => button.text().includes("复制 CLI"))!;
    const copyMcp = () => panel.findAll("button").find((button) => button.text().includes("复制 MCP 启动命令"))!;
    expect(copyCli().attributes("disabled")).toBeUndefined();
    await copyCli().trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);

    const profileName = panel.findAll<HTMLInputElement>(".agent-panel__meta input")[0];
    await profileName.setValue("Edited profile");
    expect(copyCli().attributes("disabled")).toBeDefined();
    expect(copyMcp().attributes("disabled")).toBeDefined();
    copyCli().element.removeAttribute("disabled");
    copyMcp().element.removeAttribute("disabled");
    await copyCli().trigger("click");
    await copyMcp().trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(panel.text()).toContain("请先保存 profile，再复制命令。");

    const presetId = panel.find("fieldset.preset-card input");
    await presetId.setValue("compact");
    const save = panel.findAll("button").find((button) => button.text() === "保存")!;
    await save.trigger("click");
    await flushPromises();
    expect(copyCli().attributes("disabled")).toBeUndefined();
    await copyCli().trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining("--preset compact"));
  });

  it("keeps new and failed-save profiles blocked while catalog search stays clean", async () => {
    const { wrapper: newPanel } = await mountPanel(null);
    const newCopyMcp = newPanel.findAll("button").find((button) => button.text().includes("复制 MCP 启动命令"))!;
    expect(newCopyMcp.attributes("disabled")).toBeDefined();
    const newSave = newPanel.findAll("button").find((button) => button.text() === "保存")!;
    await newSave.trigger("click");
    await flushPromises();
    expect(newCopyMcp.attributes("disabled")).toBeUndefined();

    newPanel.unmount();
    const stored = profileFor("builtin.utilities.base64");
    const { wrapper: storedPanel } = await mountPanel(stored);
    const storedCopyMcp = storedPanel.findAll("button").find((button) => button.text().includes("复制 MCP 启动命令"))!;
    const search = storedPanel.get<HTMLInputElement>('input[type="search"]');
    await search.setValue("hash");
    expect(storedCopyMcp.attributes("disabled")).toBeUndefined();

    ipcMock.agentProfileSave.mockRejectedValueOnce(new Error("SAVE_FAILED"));
    await storedPanel.findAll<HTMLInputElement>(".agent-panel__meta input")[0].setValue("Unsaved");
    const save = storedPanel.findAll("button").find((button) => button.text() === "保存")!;
    await save.trigger("click");
    await flushPromises();
    expect(storedCopyMcp.attributes("disabled")).toBeDefined();
    await storedCopyMcp.trigger("click");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
