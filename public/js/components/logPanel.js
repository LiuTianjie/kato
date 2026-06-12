import { dashboardApi } from "../api.js";
import { $, escapeHtml, setHtml, setText } from "../dom.js";
import { stateLabel } from "../format.js";

export function bindLogPanel() {
  $("toggleLogPanel").addEventListener("click", () => toggleLogPanel());
  $("closeLogPanel").addEventListener("click", () => setLogPanelOpen(false));
}

export function appendClientLog(message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  setText("operationState", "记录");
  $("logDrawer").classList.add("has-activity");
  $("operationLog").insertAdjacentHTML("beforeend", `<div>${escapeHtml(`[${time}] ${message}`)}</div>`);
  $("operationLog").scrollTop = $("operationLog").scrollHeight;
}

export async function watchOperation(operationId, options = {}) {
  setText("operationState", "运行中");
  setHtml("operationLog", "");
  setLogPanelOpen(true);
  const startedAt = Date.now();
  const timeoutMs = Number(options.timeoutMs || 0);
  while (true) {
    if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
      throw new Error("任务仍在后台运行，已停止等待。请刷新结果列表查看最新状态。");
    }
    const operation = await dashboardApi.getOperation(operationId);
    setText("operationState", stateLabel(operation.state));
    setHtml("operationLog", operation.logs.map((line) => `<div>${escapeHtml(line)}</div>`).join(""));
    $("operationLog").scrollTop = $("operationLog").scrollHeight;
    await options.onTick?.(operation);
    if (operation.state === "completed") return operation;
    if (operation.state === "cancelled") return operation;
    if (operation.state === "failed") throw new Error(operation.error || "任务失败");
    await sleep(900);
  }
}

function toggleLogPanel() {
  setLogPanelOpen(!$("logDrawer").classList.contains("is-open"));
}

function setLogPanelOpen(isOpen) {
  $("logDrawer").classList.toggle("is-open", isOpen);
  $("logDrawer").setAttribute("aria-expanded", isOpen ? "true" : "false");
  if (isOpen) $("logDrawer").classList.remove("has-activity");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
