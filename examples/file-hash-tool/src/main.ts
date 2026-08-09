import { useful } from "@useful/sdk";
import { createSHA256 } from "hash-wasm";

const choose = document.querySelector<HTMLButtonElement>("#choose")!;
const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
const fileLabel = document.querySelector<HTMLElement>("#file")!;
const progress = document.querySelector<HTMLProgressElement>("#progress")!;
const percent = document.querySelector<HTMLElement>("#percent")!;
const digest = document.querySelector<HTMLTextAreaElement>("#digest")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
let canceled = false;

void useful.ready({ capability: "streaming-sha256", chunkBytes: 512 * 1024 });

cancel.addEventListener("click", () => { canceled = true; statusElement.textContent = "正在取消…"; });
choose.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  canceled = false; digest.value = ""; progress.value = 0; percent.textContent = "0%";
  choose.disabled = true; cancel.disabled = false;
  try {
    fileLabel.textContent = file.name;
    const size = file.size;
    const hasher = await createSHA256();
    const chunkSize = 512 * 1024;
    let offset = 0;
    while (offset < size) {
      if (canceled) { statusElement.textContent = "计算已取消"; return; }
      const chunk = new Uint8Array(await file.slice(offset, offset + Math.min(chunkSize, size - offset)).arrayBuffer());
      if (chunk.length === 0) throw new Error("文件在读取过程中意外结束");
      hasher.update(chunk);
      offset += chunk.length;
      const value = size === 0 ? 100 : Math.round((offset / size) * 100);
      progress.value = value; percent.textContent = `${value}%`;
      await useful.reportProgress(value, "计算 SHA-256");
    }
    if (size === 0) progress.value = 100;
    digest.value = hasher.digest();
    percent.textContent = "100%"; statusElement.textContent = "计算完成";
  } catch (error) {
    statusElement.textContent = `失败：${error instanceof Error ? error.message : error}`;
  } finally {
    choose.disabled = false; cancel.disabled = true;
    fileInput.value = "";
  }
});
