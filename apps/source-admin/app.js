const baseUrl = document.querySelector("#base-url");
const token = document.querySelector("#token");
const health = document.querySelector("#health");
const result = document.querySelector("#result");
const message = document.querySelector("#message");
const resultTitle = document.querySelector("#result-title");

function normalizedBaseUrl() {
  const value = baseUrl.value.trim().replace(/\/$/, "");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new Error("非本机地址必须使用 HTTPS");
  }
  return url.href.replace(/\/$/, "");
}

async function request(path, isPublic = false) {
  const headers = { Accept: "application/json" };
  if (!isPublic) {
    const value = token.value.trim();
    if (!value) throw new Error("请输入本次会话使用的 Beta 管理 Token");
    headers.Authorization = `Bearer ${value}`;
  }
  const response = await fetch(`${normalizedBaseUrl()}${path}`, { headers, cache: "no-store" });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // health/metrics 允许文本响应。
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  return body;
}

async function run(path, isPublic, title) {
  message.textContent = "正在读取…";
  result.textContent = "";
  resultTitle.textContent = title;
  try {
    const body = await request(path, isPublic);
    result.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    message.textContent = "读取成功。";
  } catch (error) {
    message.textContent = String(error);
  }
}

document.querySelector("#check").addEventListener("click", async () => {
  health.textContent = "检查中";
  health.className = "badge";
  try {
    await request("/health", true);
    await request("/ready", true);
    health.textContent = "健康且就绪";
    health.className = "badge ok";
  } catch (error) {
    health.textContent = "不可用";
    health.className = "badge error";
    message.textContent = String(error);
  }
});

document.querySelectorAll("[data-path]").forEach((button) => {
  button.addEventListener("click", () =>
    run(button.dataset.path, button.dataset.public === "true", button.textContent.trim()),
  );
});

document.querySelector("#clear").addEventListener("click", () => {
  result.textContent = "";
  message.textContent = "已清空；Token 仍只保留在本页内存。";
});

window.addEventListener("pagehide", () => {
  token.value = "";
});
