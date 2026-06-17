import { dashboardApi, getApiToken, setApiToken } from "./js/api.js";
import { $, $$ } from "./js/dom.js";
import { appendClientLog, bindLogPanel } from "./js/components/logPanel.js";
import { bindCdpViewer } from "./js/components/cdpViewer.js";
import { bindPlatformLoginActions, openCdpLogin, refreshMcp, refreshWorkerQueues } from "./js/components/mcpPanel.js";
import { bindTabs } from "./js/components/tabs.js";
import { withButtonLoading } from "./js/loading.js";

bindEvents();
await bootstrapAuth();

function bindEvents() {
  bindTabs();
  bindLogPanel();
  bindCdpViewer();
  bindPlatformLoginActions();
  window.addEventListener("kato:unauthorized", () => {
    setApiToken("");
    showLogin(true);
  });
  $("refreshAll").addEventListener("click", () => withButtonLoading($("refreshAll"), "刷新中", refreshAll));
  $("refreshMcp").addEventListener("click", () => refreshMcp($("refreshMcp")));
  $("refreshWorkerQueues").addEventListener("click", () => refreshWorkerQueues($("refreshWorkerQueues")));
  $("loginForm").addEventListener("submit", loginConsole);
  $("logoutConsole").addEventListener("click", logoutConsole);
  $("openCdpLogin").addEventListener("click", () => openCdpLogin($("openCdpLogin")));
}

async function bootstrapAuth() {
  const token = getApiToken();
  if (token) $("apiTokenInput").value = token;
  try {
    if (!token) throw new Error("missing token");
    const status = await dashboardApi.getAuthStatus();
    if (!status.authenticated) throw new Error("invalid token");
    showLogin(false);
    await refreshAll();
  } catch {
    showLogin(true);
  }
}

async function loginConsole(event) {
  event.preventDefault();
  const token = $("apiTokenInput").value.trim();
  const message = $("loginMessage");
  message.textContent = "";
  if (!token) {
    message.textContent = "请输入 Kato API Token";
    return;
  }
  try {
    setApiToken(token);
    await dashboardApi.login(token);
  } catch (error) {
    setApiToken("");
    message.textContent = error instanceof Error ? error.message : String(error);
    showLogin(true);
    return;
  }

  showLogin(false);
  appendClientLog("成功 · Kato Console 已登录");
  await refreshAll();
}

function logoutConsole() {
  setApiToken("");
  appendClientLog("提示 · 已退出 Kato Console");
  showLogin(true);
}

function showLogin(show) {
  $("loginGate").classList.toggle("is-hidden", !show);
  document.body.classList.toggle("is-authenticated", !show);
  if (show) $("apiTokenInput").focus();
}

async function refreshAll() {
  setWorkspaceBusy(true);
  try {
    await refreshMcp($("refreshMcp"));
  } catch (error) {
    appendClientLog(`失败 · 刷新状态：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setWorkspaceBusy(false);
  }
}

function setWorkspaceBusy(isBusy) {
  $$(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-region-loading", isBusy);
    panel.setAttribute("aria-busy", isBusy ? "true" : "false");
  });
}
