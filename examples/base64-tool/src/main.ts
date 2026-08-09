import { useful } from "@useful/sdk";

const input = document.querySelector<HTMLTextAreaElement>("#input")!;
const output = document.querySelector<HTMLElement>("#output")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
let mode: "encode" | "decode" = "encode";

function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(text: string): string {
  const binary = atob(text.trim());
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function render(): void {
  statusElement.textContent = "";
  try {
    output.textContent = input.value ? (mode === "encode" ? encode(input.value) : decode(input.value)) : "";
  } catch (error) {
    output.textContent = "";
    statusElement.textContent = `输入无效：${error instanceof Error ? error.message : error}`;
  }
}

document.querySelector("#encode")!.addEventListener("click", () => { mode = "encode"; render(); });
document.querySelector("#decode")!.addEventListener("click", () => { mode = "decode"; render(); });
document.querySelector("#swap")!.addEventListener("click", () => {
  input.value = output.textContent ?? "";
  mode = mode === "encode" ? "decode" : "encode";
  render();
});
document.querySelector("#clear")!.addEventListener("click", () => { input.value = ""; render(); });
input.addEventListener("input", render);
render();
void useful.ready({ capability: "base64", permissions: 0 });
