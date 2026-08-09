import { useful } from "@useful/sdk";
import { diffJson, summarize } from "./diff-core.mjs";

type Change = { path: string; kind: string; before?: unknown; after?: unknown; beforeType?: string; afterType?: string };
const left = document.querySelector<HTMLTextAreaElement>("#left")!;
const right = document.querySelector<HTMLTextAreaElement>("#right")!;
const status = document.querySelector<HTMLElement>("#status")!;
const results = document.querySelector<HTMLElement>("#results")!;
const body = document.querySelector<HTMLTableSectionElement>("#diff-body")!;
const filter = document.querySelector<HTMLInputElement>("#filter")!;
let changes: Change[] = [];

const labels: Record<string, string> = { added: "新增", removed: "删除", changed: "值变化", "type-changed": "类型变化" };
function format(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}
function cell(text: string, className = ""): HTMLTableCellElement {
  const element = document.createElement("td");
  element.className = className;
  element.textContent = text;
  return element;
}
function renderRows(): void {
  const query = filter.value.trim().toLocaleLowerCase();
  const visible = changes.filter((change) => !query || `${change.path} ${format(change.before)} ${format(change.after)}`.toLocaleLowerCase().includes(query));
  body.replaceChildren(...visible.map((change) => {
    const row = document.createElement("tr");
    row.append(cell(change.path, "path"));
    const kind = cell("");
    const badge = document.createElement("span"); badge.className = "kind"; badge.textContent = labels[change.kind] ?? change.kind; kind.append(badge); row.append(kind);
    row.append(cell(format(change.before), "value"));
    row.append(cell(format(change.after), "value"));
    return row;
  }));
  document.querySelector<HTMLElement>("#visible-count")!.textContent = `显示 ${visible.length} / ${changes.length}`;
}
function compare(): void {
  status.classList.remove("error");
  try {
    if (left.value.length > 5_000_000 || right.value.length > 5_000_000) throw new Error("单份输入不能超过 5 MB");
    const diff = diffJson(JSON.parse(left.value), JSON.parse(right.value));
    changes = diff.changes;
    const summary = summarize(changes);
    for (const [id, value] of Object.entries({ total: summary.total, added: summary.added, removed: summary.removed, changed: summary.changed, typed: summary.typeChanged })) {
      document.querySelector<HTMLElement>(`#${id}`)!.textContent = String(value);
    }
    results.hidden = false;
    filter.value = "";
    renderRows();
    status.textContent = diff.truncated ? "差异超过 10,000 项，已安全截断。" : changes.length ? `比较完成：发现 ${changes.length} 项结构差异。` : "两份 JSON 在结构和值上完全一致。";
  } catch (error) {
    results.hidden = true;
    status.classList.add("error");
    status.textContent = `无法比较：${error instanceof Error ? error.message : error}`;
  }
}

document.querySelector("#compare")!.addEventListener("click", compare);
document.querySelector("#swap")!.addEventListener("click", () => { [left.value, right.value] = [right.value, left.value]; });
document.querySelector("#clear")!.addEventListener("click", () => { left.value = ""; right.value = ""; changes = []; results.hidden = true; status.textContent = "输入两份 JSON 后开始比较。"; });
document.querySelector("#sample")!.addEventListener("click", () => {
  left.value = JSON.stringify({ service: "useful", version: 1, flags: { offline: true }, tools: ["json", "base64"] }, null, 2);
  right.value = JSON.stringify({ service: "useful-pro", version: "2", flags: { offline: true, signed: true }, tools: ["json", "diff"] }, null, 2);
  compare();
});
filter.addEventListener("input", renderRows);
void useful.ready({ capability: "json-structural-diff", version: document.querySelector("#version")!.textContent, permissions: 0, offline: true })
  .catch(() => { /* Standalone dev preview has no parent host bridge. */ });
