import { POSTED_STATUSES } from "./state.js";

export function interactionLabel(value) {
  if (POSTED_STATUSES.has(value)) return "已互动";
  if (value === "skipped") return "已跳过";
  return "未互动";
}

export function formatTime(value) {
  if (!value) return "";
  return new Date(value.replace(" ", "T")).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function toDateKey(value) {
  if (!value) return "";
  return value.slice(0, 10);
}

export function stateLabel(value) {
  if (value === "completed") return "完成";
  if (value === "failed") return "失败";
  if (value === "cancelled") return "已取消";
  return "运行中";
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
