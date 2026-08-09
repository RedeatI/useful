import { describe, expect, it, vi } from "vitest";
import { requestOpenFile, subscribeOpenFile } from "@/lib/openFileBus";

describe("openFileBus", () => {
  it("delivers pending open requests after subscribe", () => {
    const received: string[] = [];
    requestOpenFile({ toolId: "builtin.video-trim", file: "C:\\a b.mp4" });
    const stop = subscribeOpenFile((detail) => {
      received.push(`${detail.toolId}|${detail.file}`);
    });
    expect(received).toEqual(["builtin.video-trim|C:\\a b.mp4"]);
    requestOpenFile({ toolId: "builtin.video-trim", file: "C:\\b.mp4" });
    expect(received).toEqual([
      "builtin.video-trim|C:\\a b.mp4",
      "builtin.video-trim|C:\\b.mp4",
    ]);
    stop();
  });

  it("does not keep delivering after unsubscribe", () => {
    const spy = vi.fn();
    const stop = subscribeOpenFile(spy);
    stop();
    requestOpenFile({ toolId: "builtin.video-trim", file: "C:\\c.mp4" });
    // queued for next subscriber
    const spy2 = vi.fn();
    const stop2 = subscribeOpenFile(spy2);
    expect(spy).not.toHaveBeenCalled();
    expect(spy2).toHaveBeenCalledWith({ toolId: "builtin.video-trim", file: "C:\\c.mp4" });
    stop2();
  });
});
