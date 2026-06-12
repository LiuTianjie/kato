import { escapeAttr, escapeHtml, loadingBlock, setHtml, setText } from "../dom.js";
import { formatTime } from "../format.js";
import { state } from "../state.js";

export function renderDebugScreenshotsLoading() {
  setText("debugScreenshotCount", "加载中");
  setHtml("debugScreenshots", loadingBlock("正在读取调试截图"));
}

export function renderDebugScreenshots() {
  setText("debugScreenshotCount", `${state.debugScreenshots.length} 张`);
  setHtml(
    "debugScreenshots",
    state.debugScreenshots.map(renderScreenshot).join("") ||
      `<div class="empty">暂无调试截图。MCP 遇到不可访问页面后会自动保存 PNG 到 debug 目录。</div>`
  );
}

export function renderDebugScreenshotsError(message) {
  setText("debugScreenshotCount", "读取失败");
  setHtml(
    "debugScreenshots",
    `<div class="empty">调试截图读取失败：${escapeHtml(message || "未知错误")}</div>`
  );
}

function renderScreenshot(item) {
  return `
    <a class="debug-shot" href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">
      <img src="${escapeAttr(item.url)}" alt="${escapeAttr(item.name)}" loading="lazy" />
      <span class="debug-shot-meta">
        <strong>${escapeHtml(item.name)}</strong>
        <em>${formatTime(item.mtime)} · ${formatSize(item.size)}</em>
      </span>
    </a>
  `;
}

function formatSize(value) {
  const size = Number(value || 0);
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size > 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}
