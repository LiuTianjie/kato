import { $, escapeHtml } from "../dom.js";
import { state } from "../state.js";

export function renderRunOptions() {
  const options =
    `<option value="">全部 Run</option>` +
    state.runs
      .map((run) => `<option value="${run.id}">Run ${run.id} · ${run.total || 0} 条</option>`)
      .join("");
  const queueValue = $("runFilter").value;
  const historyValue = $("historyRunFilter").value;
  $("runFilter").innerHTML = options;
  $("historyRunFilter").innerHTML = options;
  $("runFilter").value = queueValue;
  $("historyRunFilter").value = historyValue;
}

export function renderRunSnapshot() {
  const latest = state.runs[0];
  if (!latest) return "";
  return `
    <div class="run-snapshot">
      <span>最新 Run</span>
      <strong>#${latest.id}</strong>
      <em>${escapeHtml(latest.total || 0)} 条候选</em>
    </div>
  `;
}
