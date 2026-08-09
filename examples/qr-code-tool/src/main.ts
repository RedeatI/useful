import { useful } from "@useful/sdk";
import qrcode from "qrcode-generator";

const input = document.querySelector<HTMLTextAreaElement>("#input")!;
const level = document.querySelector<HTMLSelectElement>("#level")!;
const output = document.querySelector<HTMLElement>("#output")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;

function generate(): void {
  try {
    const qr = qrcode(0, level.value as "L" | "M" | "Q" | "H");
    qr.addData(input.value, "Byte");
    qr.make();
    output.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
    statusElement.textContent = `已离线生成 ${qr.getModuleCount()} × ${qr.getModuleCount()} 二维码`;
  } catch (error) {
    output.replaceChildren();
    statusElement.textContent = `生成失败：${error instanceof Error ? error.message : error}`;
  }
}

document.querySelector("#generate")!.addEventListener("click", generate);
input.addEventListener("input", generate);
level.addEventListener("change", generate);
generate();
void useful.ready({ capability: "offline-qrcode", dependency: "qrcode-generator@1.4.4" });
