import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

const parserMock = vi.hoisted(() => vi.fn());
vi.mock("@useful/protocol/useful-cli-verify-all-browser", () => ({
  USEFUL_CLI_VERIFY_ALL_MAX_UTF8_BYTES: 1048576,
  parseUsefulCliVerifyAllJson: parserMock,
}));

import AgentConnectionPanel from "./AgentConnectionPanel.vue";

const targets = ["codex", "claude-code", "claude-desktop", "mcp-servers-json"] as const;

function validSet(marker = "safe"): ReturnType<typeof makeSet> {
  return makeSet(marker);
}

function makeSet(marker: string) {
  return {
    schemaVersion: "useful.agent-connection-verification-set.v1",
    kind: "mcp-stdio-connection-verification-set",
    status: "candidate-ready" as const,
    claimScope: "useful-mcp-local-stdio-connection-candidates-self-reported",
    claims: {
      documentAuthenticated: false as const,
      externalAgentInstalledAttested: false as const,
      externalAgentConfiguredAttested: false as const,
      externalAgentConnectedAttested: false as const,
    },
    verifications: targets.map((target, index) => ({
      connection: {
        plan: {
          target,
          scope: "user" as const,
          server: { nodePath: `C:\\Node\\${marker}.exe`, launcherPath: `C:\\Useful\\${marker}.mjs`, env: {} },
        },
        output: index === 0
          ? { kind: "host-command" as const, powershellCommand: `& '${marker}'` }
          : { kind: "merge-fragment" as const, format: "json" as const, mergeFragment: { marker, target } },
      },
    })),
  };
}

describe("AgentConnectionPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parserMock.mockReturnValue(validSet());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("does not parse, invoke, read, copy, or execute on mount and input", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    const wrapper = mount(AgentConnectionPanel);
    expect(parserMock).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="agent-connections-input"]').setValue('{"pasted":true}');
    expect(parserMock).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="agent-connections-state"]').text()).toBe("可检查");
  });

  it("shows exactly four user-scope empty-env candidates and explicit trust boundaries after inspection", async () => {
    const wrapper = mount(AgentConnectionPanel);
    await wrapper.get('[data-testid="agent-connections-input"]').setValue("full envelope");
    await wrapper.get('[data-testid="agent-connections-inspect"]').trigger("click");

    expect(parserMock).toHaveBeenCalledOnce();
    expect(parserMock).toHaveBeenCalledWith("full envelope");
    expect(wrapper.findAll(".connection-card")).toHaveLength(4);
    for (const target of targets) {
      const card = wrapper.get(`[data-testid="agent-connection-${target}"]`);
      expect(card.text()).toContain("user");
      expect(card.text()).toContain("{}");
    }
    const boundary = wrapper.get('[data-testid="agent-connections-boundary"]').text();
    expect(wrapper.get('[data-testid="agent-connections-boundary"]').attributes("role")).toBe("status");
    expect(wrapper.get('[data-testid="agent-connections-boundary"]').attributes("aria-live")).toBe("polite");
    expect(boundary).toContain("candidate-ready");
    expect(boundary).toContain("documentAuthenticated: false");
    expect(boundary).toContain("externalAgentInstalledAttested: false");
    expect(wrapper.text()).not.toMatch(/已安装|已连接/);
    const buttonLabels = wrapper.findAll("button").map((button) => button.text());
    expect(buttonLabels.join(" ")).not.toMatch(/运行|应用|安装|打开配置|保存|历史/);
    expect(buttonLabels).toEqual([
      "检查 JSON", "复制规范化集合 JSON", ...targets.map(() => "复制连接输出"),
    ]);
    expect(targets.map((target) => wrapper.get(`[data-testid="copy-output-${target}"]`).attributes("aria-label")))
      .toEqual(["复制 Codex 的连接输出", "复制 Claude Code 的连接输出", "复制 Claude Desktop 的连接输出", "复制 mcp-servers.json 的连接输出"]);
  });

  it("retains the previous result as stale without reparsing when input changes", async () => {
    const wrapper = mount(AgentConnectionPanel);
    await wrapper.get("textarea").setValue("first");
    await wrapper.get('[data-testid="agent-connections-inspect"]').trigger("click");
    await wrapper.get("textarea").setValue("second");
    expect(parserMock).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-testid="agent-connections-stale"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="agent-connections-result"]').text()).toContain("safe.exe");
    for (const button of wrapper.findAll('[data-testid^="copy-output-"]')) {
      expect(button.attributes()).toHaveProperty("disabled");
    }
    expect(wrapper.get('[data-testid="copy-verification-set"]').attributes()).toHaveProperty("disabled");
    expect(wrapper.get('[data-testid="agent-connections-boundary"]').attributes("aria-live")).toBeUndefined();

    await wrapper.get("textarea").setValue("x".repeat(1024 * 1024 + 1));
    expect(wrapper.get('[data-testid="agent-connections-state"]').text()).toBe("无效");
    expect(wrapper.get('[data-testid="copy-verification-set"]').attributes()).toHaveProperty("disabled");
    expect(wrapper.find('[data-testid="agent-connections-error"]').exists()).toBe(false);
  });

  it("shows invalid and budget states without passing over-budget text to the parser", async () => {
    parserMock.mockImplementation(() => { throw new Error("BAD_ENVELOPE"); });
    const wrapper = mount(AgentConnectionPanel);
    await wrapper.get("textarea").setValue("bad");
    await wrapper.get('[data-testid="agent-connections-inspect"]').trigger("click");
    expect(wrapper.get('[data-testid="agent-connections-error"]').text()).toContain("BAD_ENVELOPE");

    parserMock.mockClear();
    await wrapper.get("textarea").setValue("x".repeat(1024 * 1024 + 1));
    expect(wrapper.get('[data-testid="agent-connections-budget"]').attributes("role")).toBe("alert");
    expect(wrapper.get('[data-testid="agent-connections-state"]').text()).toBe("无效");
    expect(wrapper.get('[data-testid="agent-connections-inspect"]').attributes()).toHaveProperty("disabled");
    expect(parserMock).not.toHaveBeenCalled();
  });

  it("copies only on explicit actions and reports clipboard failure without losing valid state", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    const wrapper = mount(AgentConnectionPanel);
    await wrapper.get("textarea").setValue("valid");
    await wrapper.get('[data-testid="agent-connections-inspect"]').trigger("click");
    await wrapper.get('[data-testid="copy-verification-set"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(validSet(), null, 2));
    expect(wrapper.get('[data-testid="agent-connections-copy-status"]').text()).toContain("已复制");

    writeText.mockRejectedValueOnce(new Error("SENSITIVE_CLIPBOARD_SENTINEL"));
    await wrapper.get('[data-testid="copy-output-codex"]').trigger("click");
    expect(wrapper.get('[data-testid="agent-connections-copy-status"]').text()).toBe("写入剪贴板失败。请检查剪贴板权限后重试。");
    expect(wrapper.text()).not.toContain("SENSITIVE_CLIPBOARD_SENTINEL");
    expect(wrapper.get('[data-testid="agent-connections-state"]').text()).toBe("有效");
    expect(wrapper.find('[data-testid="agent-connections-result"]').exists()).toBe(true);
  });

  it("fail-closes stale and invalid copy handlers before clipboard writes", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    const wrapper = mount(AgentConnectionPanel);
    await wrapper.get("textarea").setValue("valid");
    await wrapper.get('[data-testid="agent-connections-inspect"]').trigger("click");
    await wrapper.get("textarea").setValue("changed");
    const staleCopy = wrapper.get('[data-testid="copy-output-codex"]');
    staleCopy.element.removeAttribute("disabled");
    await staleCopy.trigger("click");
    expect(writeText).not.toHaveBeenCalled();

    parserMock.mockImplementationOnce(() => { throw new Error("INVALID"); });
    await wrapper.get('[data-testid="agent-connections-inspect"]').trigger("click");
    expect(wrapper.get('[data-testid="agent-connections-state"]').text()).toBe("无效");
    expect(wrapper.find('[data-testid="agent-connections-stale"]').exists()).toBe(true);
    const invalidCopy = wrapper.get('[data-testid="copy-verification-set"]');
    expect(invalidCopy.attributes()).toHaveProperty("disabled");
    invalidCopy.element.removeAttribute("disabled");
    await invalidCopy.trigger("click");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("ignores old clipboard resolution after input changes", async () => {
    let resolveCopy!: () => void;
    const pending = new Promise<void>((resolve) => { resolveCopy = resolve; });
    vi.mocked(navigator.clipboard.writeText).mockReturnValueOnce(pending);
    const wrapper = mount(AgentConnectionPanel);
    await wrapper.get("textarea").setValue("valid");
    await wrapper.get('[data-testid="agent-connections-inspect"]').trigger("click");
    const click = wrapper.get('[data-testid="copy-output-codex"]').trigger("click");
    await wrapper.get("textarea").setValue("changed");
    resolveCopy();
    await click;
    expect(wrapper.get('[data-testid="agent-connections-copy-status"]').text()).toBe("");
  });

  it("ignores an older rejected copy after a newer copy succeeds", async () => {
    let rejectOld!: (error: Error) => void;
    const oldCopy = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    const writeText = vi.mocked(navigator.clipboard.writeText);
    writeText.mockReturnValueOnce(oldCopy).mockResolvedValueOnce(undefined);
    const wrapper = mount(AgentConnectionPanel);
    await wrapper.get("textarea").setValue("valid");
    await wrapper.get('[data-testid="agent-connections-inspect"]').trigger("click");
    const firstClick = wrapper.get('[data-testid="copy-output-codex"]').trigger("click");
    await wrapper.get('[data-testid="copy-output-claude-code"]').trigger("click");
    expect(wrapper.get('[data-testid="agent-connections-copy-status"]').text()).toContain("Claude Code");
    rejectOld(new Error("OLD_SENSITIVE_SENTINEL"));
    await firstClick;
    expect(wrapper.get('[data-testid="agent-connections-copy-status"]').text()).toContain("Claude Code");
    expect(wrapper.text()).not.toContain("OLD_SENSITIVE_SENTINEL");
  });

  it("renders untrusted strings as text rather than HTML", async () => {
    const attack = '<img src=x onerror="alert(1)">';
    parserMock.mockReturnValue(validSet(attack));
    const wrapper = mount(AgentConnectionPanel);
    await wrapper.get("textarea").setValue("valid");
    await wrapper.get('[data-testid="agent-connections-inspect"]').trigger("click");
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.text()).toContain(attack);
  });
});
