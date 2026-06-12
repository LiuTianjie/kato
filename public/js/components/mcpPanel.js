import { dashboardApi } from "../api.js";
import { $, setText } from "../dom.js";
import { errorMessage } from "../format.js";
import { withButtonLoading } from "../loading.js";
import { connectCdpViewer } from "./cdpViewer.js";
import { appendClientLog } from "./logPanel.js";
import { activateTab } from "./tabs.js";

export async function refreshMcp(button) {
  const el = $("mcpState");
  el.textContent = "检查中";
  el.className = "mcp-state is-checking";
  appendClientLog("开始 · MCP 检查登录状态");
  return withButtonLoading(button, "检查中", async () => {
    try {
      const result = await dashboardApi.getMcpStatus();
      const data = result.data || {};
      setText("mcpState", data.is_logged_in ? `已登录 · ${data.username || "小红书"}` : "未登录");
      el.classList.remove("is-checking");
      el.classList.add(data.is_logged_in ? "ok" : "warn");
      appendClientLog(`成功 · MCP 登录状态：${el.textContent}`);
    } catch (error) {
      setText("mcpState", "MCP 不可用");
      el.classList.remove("is-checking");
      el.classList.add("warn");
      appendClientLog(`失败 · MCP 登录状态：${errorMessage(error)}`);
    }
  });
}

export async function openCdpLogin(button) {
  appendClientLog("开始 · 打开浏览器接管");
  return withButtonLoading(button, "打开中", async () => {
    try {
      const result = await dashboardApi.openCdpLogin();
      setText("mcpState", "浏览器接管已打开");
      $("mcpState").className = "mcp-state is-checking";
      appendClientLog(`成功 · 容器浏览器已打开：${result.cdpUrl}`);
      appendClientLog("提示 · 请在浏览器接管 Tab 内扫码/验证；XHS service 和画面使用同一个容器 Chromium");
      activateTab("browser");
      await connectCdpViewer();
    } catch (error) {
      appendClientLog(`失败 · 浏览器接管：${errorMessage(error)}`);
    }
  });
}

export async function syncCdpCookies(button) {
  appendClientLog("开始 · 同步 CDP 登录态到 MCP");
  return withButtonLoading(button, "同步中", async () => {
    try {
      const result = await dashboardApi.syncCdpCookies();
      setText("mcpState", "CDP 登录态已同步");
      $("mcpState").className = "mcp-state ok";
      appendClientLog(`成功 · 已导出 ${result.exportedCookies} 个 cookies 到 ${result.cookiesPath}`);
      appendClientLog("提示 · 如果 Kato 容器正在运行，刷新登录状态即可复查");
    } catch (error) {
      appendClientLog(`失败 · 同步 CDP 登录态：${errorMessage(error)}`);
    }
  });
}
