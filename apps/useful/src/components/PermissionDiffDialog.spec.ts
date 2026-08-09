// 权限对话框测试（需求十八：权限对话框）。
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PermissionDiffDialog from "@/components/PermissionDiffDialog.vue";

describe("PermissionDiffDialog", () => {
  it("open=false 时不渲染", () => {
    const wrapper = mount(PermissionDiffDialog, {
      props: { open: false, packageName: "com.example.a v1.0.0", permissions: [] },
    });
    expect(wrapper.find('[data-testid="perm-dialog"]').exists()).toBe(false);
  });

  it("展示全部权限，敏感权限高亮", () => {
    const wrapper = mount(PermissionDiffDialog, {
      props: {
        open: true,
        mode: "install",
        packageName: "com.example.a v1.0.0",
        permissions: ["dialog.open", "process.launch.declared", "network.fetch:example.com"],
      },
    });
    const items = wrapper.findAll('[data-testid="perm-item"]');
    expect(items).toHaveLength(3);
    expect(wrapper.text()).toContain("dialog.open");
    // 敏感权限有 2 个（进程启动 + 网络）
    const sensitive = wrapper.findAll(".perm-dialog__item--sensitive");
    expect(sensitive).toHaveLength(2);
    expect(wrapper.text()).toContain("敏感权限");
    // 安装模式标题
    expect(wrapper.text()).toContain("安装权限确认");
  });

  it("diff 模式显示更新新增权限标题", () => {
    const wrapper = mount(PermissionDiffDialog, {
      props: {
        open: true,
        mode: "diff",
        packageName: "com.example.a v2.0.0",
        permissions: ["clipboard.write"],
      },
    });
    expect(wrapper.text()).toContain("更新新增权限确认");
  });

  it("确认与取消触发对应事件", async () => {
    const wrapper = mount(PermissionDiffDialog, {
      props: { open: true, packageName: "x", permissions: ["dialog.open"] },
    });
    await wrapper.find('[data-testid="perm-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")).toHaveLength(1);
    await wrapper.find('[data-testid="perm-cancel"]').trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("无权限时显示无权限提示", () => {
    const wrapper = mount(PermissionDiffDialog, {
      props: { open: true, packageName: "x", permissions: [] },
    });
    expect(wrapper.text()).toContain("该工具不需要任何权限");
  });
});
