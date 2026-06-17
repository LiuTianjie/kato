import { dashboardApi, getApiToken, setApiToken } from "./js/api.js";
import { $, $$ } from "./js/dom.js";
import {
  renderDebugScreenshots,
  renderDebugScreenshotsError,
  renderDebugScreenshotsLoading,
} from "./js/components/debugScreenshots.js";
import { bindContentWorkspace, refreshContentWorkspace } from "./js/components/content.js";
import { renderHistory, renderHistoryLoading, renderMetrics, clearHistoryFilters } from "./js/components/history.js";
import { appendClientLog, bindLogPanel } from "./js/components/logPanel.js";
import { bindCdpViewer } from "./js/components/cdpViewer.js";
import { bindPlatformLoginActions, openCdpLogin, refreshMcp, refreshWorkerQueues, restartMcpBrowser } from "./js/components/mcpPanel.js";
import { configureNotes, renderNotes, renderNotesLoading } from "./js/components/notes.js";
import { bindPostSearch, renderPostSearchEmpty } from "./js/components/postSearch.js";
import {
  configureQueue,
  invertSelection,
  renderQueue,
  renderQueueLoading,
  selectAllVisible,
} from "./js/components/queue.js";
import { renderRunOptions } from "./js/components/runFilters.js";
import { bindTabs } from "./js/components/tabs.js";
import { createOperations } from "./js/operations.js";
import { ACTIVE_STATUSES, ARCHIVED_STATUSES, state } from "./js/state.js";
import { withButtonLoading } from "./js/loading.js";

const operations = createOperations({ refreshAll, refreshQueue, refreshHistory, refreshDebugScreenshots });

bindEvents();
configureQueue({
  onRowAction: operations.runRowAction,
  onSaveDraft: operations.saveDraft,
});
configureNotes({
  onToggleNote: operations.toggleNote,
});

await bootstrapAuth();

function bindEvents() {
  bindTabs();
  bindLogPanel();
  bindCdpViewer();
  bindPlatformLoginActions();
  bindContentWorkspace();
  bindPostSearch();
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
  $("restartMcpBrowser").addEventListener("click", () => restartMcpBrowser($("restartMcpBrowser")));
  $("startRun").addEventListener("click", () => operations.startRun($("startRun")));
  $("syncNotes").addEventListener("click", () => operations.syncNotes($("syncNotes")));
  $("refreshDebugScreenshots").addEventListener("click", () =>
    withButtonLoading($("refreshDebugScreenshots"), "刷新中", refreshDebugScreenshots)
  );
  $("runFilter").addEventListener("change", refreshQueue);
  $("historyRunFilter").addEventListener("change", refreshHistory);
  $("historyDateFilter").addEventListener("change", renderHistory);
  $("historyKeywordFilter").addEventListener("input", renderHistory);
  $("clearHistoryFilters").addEventListener("click", () => {
    clearHistoryFilters();
    refreshHistory();
  });
  $("selectAllVisible").addEventListener("click", selectAllVisible);
  $("invertSelection").addEventListener("click", invertSelection);
  $("generatePublishSelected").addEventListener("click", () =>
    operations.generatePublishSelected($("generatePublishSelected"))
  );
  $("skipSelected").addEventListener("click", () => operations.bulkStatus($("skipSelected"), "skipped"));
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
    await refreshMcp($("refreshMcp"));
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
    showLogin(false);
    appendClientLog("成功 · Kato Console 已登录");
    await refreshAll();
    await refreshMcp($("refreshMcp"));
  } catch (error) {
    setApiToken("");
    message.textContent = error instanceof Error ? error.message : String(error);
    showLogin(true);
  }
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
  renderNotesLoading();
  renderQueueLoading();
  renderHistoryLoading();
  renderDebugScreenshotsLoading();
  renderPostSearchEmpty();
  try {
    const dashboard = await dashboardApi.getDashboard();
    state.dashboard = dashboard;
    state.notes = dashboard.notes || [];
    state.runs = dashboard.recentRuns || [];
    renderRunOptions();
    renderNotes();
    renderMetrics();
    await Promise.all([refreshQueue(), refreshHistory(), refreshDebugScreenshots(), refreshContentWorkspace()]);
  } catch (error) {
    appendClientLog(`失败 · 刷新数据：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setWorkspaceBusy(false);
  }
}

async function refreshDebugScreenshots() {
  renderDebugScreenshotsLoading();
  try {
    const result = await dashboardApi.getDebugScreenshots();
    state.debugScreenshots = result.screenshots || [];
    renderDebugScreenshots();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderDebugScreenshotsError(message);
    appendClientLog(`失败 · 读取调试截图：${message}`);
  }
}

async function refreshQueue(options = {}) {
  if (options.showLoading !== false) renderQueueLoading();
  const params = new URLSearchParams({ status: "active", limit: "180" });
  const runId = $("runFilter").value;
  if (runId) params.set("runId", runId);
  try {
    const result = await dashboardApi.getInteractions(params);
    state.queue = (result.interactions || []).filter((row) => ACTIVE_STATUSES.has(row.status));
    state.selected.clear();
    renderQueue();
  } catch (error) {
    appendClientLog(`失败 · 读取互动队列：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function refreshHistory(options = {}) {
  if (options.showLoading !== false) renderHistoryLoading();
  const params = new URLSearchParams({ status: "all", limit: "400" });
  const runId = $("historyRunFilter").value;
  if (runId) params.set("runId", runId);
  try {
    const result = await dashboardApi.getInteractions(params);
    state.history = (result.interactions || []).filter((row) => ARCHIVED_STATUSES.has(row.status));
    renderHistory();
  } catch (error) {
    appendClientLog(`失败 · 读取历史数据：${error instanceof Error ? error.message : String(error)}`);
  }
}

function setWorkspaceBusy(isBusy) {
  $$(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-region-loading", isBusy);
    panel.setAttribute("aria-busy", isBusy ? "true" : "false");
  });
}
