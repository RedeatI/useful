// 零 native 权限示例：一次性 fragment secret 只用于交换 MessageChannel。
const out = document.getElementById("out");
const capability = new URLSearchParams(location.hash.slice(1)).get("usefulCapability");
if (!capability || !/^[0-9a-f]{64}$/.test(capability)) throw new Error("缺少 Useful 宿主 bootstrap secret");

let seq = 0;
const pending = new Map();
const portPromise = new Promise((resolve, reject) => {
  const channel = new MessageChannel();
  const port = channel.port1;
  const timeout = setTimeout(() => {
    port.close();
    reject(new Error("宿主 bootstrap 超时"));
  }, 5000);
  port.onmessage = ({ data }) => {
    if (!data || data.__usefulBootstrap !== true || data.capability !== capability || data.ok !== true) return;
    clearTimeout(timeout);
    port.onmessage = ({ data: response }) => {
      if (!response || response.__usefulRpc !== true || !("ok" in response)) return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      response.ok ? request.resolve(response.result) : request.reject(new Error(response.error));
    };
    port.start();
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* opaque origin */ }
    resolve(port);
  };
  port.start();
  window.parent.postMessage({ __usefulBootstrap: true, capability }, "*", [channel.port2]);
});

async function call(method, params) {
  const port = await portPromise;
  const id = String(seq++);
  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ __usefulRpc: true, id, method, params });
  });
}

function log(message) {
  out.textContent = typeof message === "string" ? message : JSON.stringify(message, null, 2);
}

void call("plugin.ready", { permissions: [] });
document.getElementById("theme").addEventListener("click", async () => {
  try {
    const theme = await call("getTheme");
    document.body.setAttribute("data-theme", theme === "dark" ? "dark" : "");
    log("当前主题: " + theme);
  } catch (error) {
    log("错误: " + error.message);
  }
});
