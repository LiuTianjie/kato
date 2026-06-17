import { $, escapeHtml, setText } from "../dom.js";

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

function toggleLogPanel() {
  setLogPanelOpen(!$("logDrawer").classList.contains("is-open"));
}

function setLogPanelOpen(isOpen) {
  $("logDrawer").classList.toggle("is-open", isOpen);
  $("logDrawer").setAttribute("aria-expanded", isOpen ? "true" : "false");
  if (isOpen) $("logDrawer").classList.remove("has-activity");
}
