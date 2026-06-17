import { dashboardApi } from "../api.js";
import { $, $$, escapeHtml, setText } from "../dom.js";
import { errorMessage } from "../format.js";
import { withButtonLoading } from "../loading.js";
import { connectCdpViewer, openPlatformViewer, reconnectCdpViewer } from "./cdpViewer.js";
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
      await refreshPlatformLoginList();
      appendClientLog(`成功 · MCP 登录状态：${el.textContent}`);
    } catch (error) {
      setText("mcpState", "MCP 不可用");
      el.classList.remove("is-checking");
      el.classList.add("warn");
      await refreshPlatformLoginList();
      appendClientLog(`失败 · MCP 登录状态：${errorMessage(error)}`);
    }
  });
}

export async function openCdpLogin(button) {
  return openPlatformLogin("xhs", button);
}

export async function openPlatformLogin(platform, button) {
  const label = platformLabel(platform);
  appendClientLog(`开始 · 打开${label}登录`);
  return withButtonLoading(button, "打开中", async () => {
    try {
      setText("mcpState", `${label}登录页已打开`);
      $("mcpState").className = "mcp-state is-checking";
      appendClientLog(`提示 · 请在浏览器接管 Tab 内完成${label}扫码/验证；远程画面通过 noVNC 显示容器 Chrome`);
      activateTab("browser");
      await openPlatformViewer(platform);
    } catch (error) {
      appendClientLog(`失败 · 打开${label}登录：${errorMessage(error)}`);
    }
  });
}

export async function openPlatformChallenge(platform, button) {
  const label = platformLabel(platform);
  const url = platformChallengeUrl(platform);
  appendClientLog(`开始 · 打开${label}验证页`);
  return withButtonLoading(button, "打开中", async () => {
    try {
      setChallengeFlowStatus(`${label}验证页已打开，通过后点击同步状态`);
      appendClientLog(`提示 · 请在 noVNC 中完成${label}验证码/安全验证，通过后点击“同步状态”`);
      activateTab("browser");
      await openPlatformViewer(platform, { url });
    } catch (error) {
      setChallengeFlowStatus(`${label}验证页打开失败`);
      appendClientLog(`失败 · 打开${label}验证页：${errorMessage(error)}`);
    }
  });
}

export async function restartMcpBrowser(button) {
  appendClientLog("开始 · 重启容器 Chromium");
  return withButtonLoading(button, "重启中", async () => {
    try {
      const result = await dashboardApi.restartMcpBrowser();
      const browser = result.data?.browser || result.browser || {};
      setText("mcpState", browser.running ? "浏览器已重启" : "浏览器重启完成");
      $("mcpState").className = browser.running ? "mcp-state ok" : "mcp-state warn";
      appendClientLog("成功 · 容器 Chrome 已重启，远程画面将重新连接");
      activateTab("browser");
      await reconnectCdpViewer();
    } catch (error) {
      setText("mcpState", "浏览器重启失败");
      $("mcpState").className = "mcp-state warn";
      appendClientLog(`失败 · 重启容器 Chromium：${errorMessage(error)}`);
    }
  });
}

export async function syncCdpCookies(button) {
  return syncPlatformCookies("xhs", button);
}

export async function syncPlatformCookies(platform, button) {
  const label = platformLabel(platform);
  appendClientLog(`开始 · 同步${label}登录态`);
  return withButtonLoading(button, "同步中", async () => {
    try {
      const result = await dashboardApi.syncPlatformCookies(platform);
      setText("mcpState", `${label}登录态已同步`);
      $("mcpState").className = "mcp-state ok";
      setChallengeFlowStatus(`${label}状态已同步，可以重试刚才的任务`);
      appendClientLog(
        `成功 · ${label}已导出 ${result.exportedCookies ?? 0} 个 cookies${result.exportedStorageOrigins !== undefined ? ` / ${result.exportedStorageOrigins} 个 storage origin` : ""} 到 ${result.cookiesPath || "持久化目录"}`
      );
      await refreshPlatformLoginList();
    } catch (error) {
      setChallengeFlowStatus(`${label}状态同步失败`);
      appendClientLog(`失败 · 同步${label}登录态：${errorMessage(error)}`);
    }
  });
}

export function bindPlatformLoginActions() {
  $$("[data-open-platform-login]").forEach((button) => {
    button.addEventListener("click", () => openPlatformLogin(button.dataset.openPlatformLogin, button));
  });
  $$("[data-open-platform-challenge]").forEach((button) => {
    button.addEventListener("click", () => openPlatformChallenge(button.dataset.openPlatformChallenge, button));
  });
  $$("[data-sync-platform-cookies]").forEach((button) => {
    button.addEventListener("click", () => syncPlatformCookies(button.dataset.syncPlatformCookies, button));
  });
}

async function refreshPlatformLoginList() {
  const list = $("platformLoginList");
  if (!list) return;
  try {
    const result = await dashboardApi.getPlatformLoginStatuses();
    const platforms = (result.platforms || []).filter((platform) => platform.capabilities?.login !== false);
    list.innerHTML = platforms.map(renderPlatformStatus).join("");
  } catch (error) {
    list.innerHTML = `<div class="platform-login-row warn"><span>平台登录态</span><strong>${escapeHtml(errorMessage(error))}</strong></div>`;
  }
}

function renderPlatformStatus(platform) {
  const label = platform.label || platformLabel(platform.platform);
  const state = platform.error ? "warn" : platform.is_logged_in ? "ok" : "warn";
  const text = platform.error ? "不可用" : platform.is_logged_in ? "已登录" : "未登录";
  const detail = platform.username || (platform.cookie_count !== undefined ? `${platform.cookie_count} cookies` : "");
  return `
    <div class="platform-login-row ${state}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(text)}</strong>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </div>
  `;
}

function platformLabel(platform) {
  if (platform === "douyin") return "抖音";
  if (platform === "bilibili") return "B站";
  return "小红书";
}

function platformChallengeUrl(platform) {
  if (platform === "douyin") return "https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F?type=video";
  if (platform === "bilibili") return "https://search.bilibili.com/all?keyword=%E8%AF%BE%E7%A8%8B";
  return "https://www.xiaohongshu.com/explore";
}

function setChallengeFlowStatus(text) {
  const el = $("challengeFlowStatus");
  if (el) el.textContent = text;
}
