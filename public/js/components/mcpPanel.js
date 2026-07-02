import { dashboardApi } from "../api.js";
import { $, $$, escapeHtml, setText } from "../dom.js";
import { errorMessage } from "../format.js";
import { withButtonLoading } from "../loading.js";
import { openPlatformViewer } from "./cdpViewer.js";
import { appendClientLog } from "./logPanel.js";
import { activateTab } from "./tabs.js";

let selectedWorkerPlatform = "xhs";

export async function refreshMcp(button) {
  const el = $("mcpState");
  el.textContent = "检查中";
  el.className = "mcp-state is-checking";
  appendClientLog("开始 · 检查平台登录状态");
  return withButtonLoading(button, "检查中", async () => {
    try {
      const platforms = await refreshPlatformLoginList();
      const loggedIn = platforms.filter((platform) => platform.is_logged_in && !platform.error);
      const failed = platforms.filter((platform) => platform.error);
      const statusText = failed.length
        ? `${failed.length} 个平台不可用`
        : loggedIn.length
          ? `已登录 · ${loggedIn.map((platform) => platform.label || platformLabel(platform.platform)).join("、")}`
          : "等待平台登录";
      setText("mcpState", statusText);
      el.classList.remove("is-checking");
      el.classList.add(failed.length ? "warn" : loggedIn.length ? "ok" : "warn");
      await refreshWorkerQueues();
      appendClientLog(`成功 · 平台登录状态：${el.textContent}`);
    } catch (error) {
      setText("mcpState", "平台状态不可用");
      el.classList.remove("is-checking");
      el.classList.add("warn");
      await refreshWorkerQueues();
      appendClientLog(`失败 · 平台登录状态：${errorMessage(error)}`);
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
  return openPlatformChallengeRuntime(platform, "viewer", button);
}

export async function openPlatformWorkerChallenge(platform, button) {
  return openPlatformChallengeRuntime(platform, "worker", button);
}

async function openPlatformChallengeRuntime(platform, kind, button) {
  const label = platformLabel(platform);
  const url = platformChallengeUrl(platform);
  const kindLabel = kind === "worker" ? "Worker " : "";
  appendClientLog(`开始 · 打开${label}${kindLabel}验证页`);
  return withButtonLoading(button, "打开中", async () => {
    try {
      setChallengeFlowStatus(`${label}${kindLabel}验证页已打开`);
      appendClientLog(
        kind === "worker"
          ? `提示 · 这是接口任务实际使用的${label} Worker 浏览器。请在 noVNC 中完成验证，通过后直接重试任务。`
          : `提示 · 请在 noVNC 中完成${label}验证码/安全验证，通过后点击“同步状态”`
      );
      activateTab("browser");
      await openPlatformViewer(platform, { url, kind });
    } catch (error) {
      setChallengeFlowStatus(`${label}${kindLabel}验证页打开失败`);
      appendClientLog(`失败 · 打开${label}${kindLabel}验证页：${errorMessage(error)}`);
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
      await refreshWorkerQueues();
    } catch (error) {
      setChallengeFlowStatus(`${label}状态同步失败`);
      appendClientLog(`失败 · 同步${label}登录态：${errorMessage(error)}`);
    }
  });
}

export async function clearPlatformAuth(platform, button) {
  const label = platformLabel(platform);
  if (!window.confirm(`确认清理${label}在 Kato 浏览器中的登录态和站点数据？`)) return;
  appendClientLog(`开始 · 清理${label}平台登录态`);
  return withButtonLoading(button, "清理中", async () => {
    try {
      const result = await dashboardApi.clearPlatformAuth(platform);
      setChallengeFlowStatus(`${label}登录态已清理，请重新登录并同步状态`);
      appendClientLog(`成功 · ${label}平台登录态已清理：${JSON.stringify(result.data || result).slice(0, 240)}`);
      await refreshPlatformLoginList();
      await refreshWorkerQueues();
    } catch (error) {
      setChallengeFlowStatus(`${label}登录态清理失败`);
      appendClientLog(`失败 · 清理${label}登录态：${errorMessage(error)}`);
    }
  });
}

export async function resetPlatformProfile(platform, button) {
  const label = platformLabel(platform);
  if (!window.confirm(`确认重建${label} viewer/worker 浏览器 Profile？旧 Profile 会归档，通常只在重度风控或环境污染时使用。`)) return;
  appendClientLog(`开始 · 重建${label}浏览器 Profile`);
  return withButtonLoading(button, "重建中", async () => {
    try {
      const result = await dashboardApi.resetPlatformProfile({
        platform,
        runtimeKind: "both",
        archiveProfile: true,
        clearCookieFiles: true,
        reason: "kato dashboard platform profile reset"
      });
      setChallengeFlowStatus(`${label}浏览器 Profile 已重建，请重新打开登录并同步状态`);
      appendClientLog(`成功 · ${label}浏览器 Profile 已重建：${JSON.stringify(result.data || result).slice(0, 240)}`);
      await refreshPlatformLoginList();
      await refreshWorkerQueues();
    } catch (error) {
      setChallengeFlowStatus(`${label}浏览器 Profile 重建失败`);
      appendClientLog(`失败 · 重建${label}浏览器 Profile：${errorMessage(error)}`);
    }
  });
}

export async function refreshWorkerQueues(button) {
  const list = $("workerQueueList");
  if (!list) return;
  setWorkerQueueStatus("刷新 Worker 队列状态中");
  if (button) {
    return withButtonLoading(button, "刷新中", async () => {
      await loadWorkerQueues(list);
    });
  }
  await loadWorkerQueues(list);
}

export async function recoverPlatformWorker(platform, button) {
  const label = platformLabel(platform);
  appendClientLog(`开始 · 恢复${label} Worker 队列`);
  return withButtonLoading(button, "恢复中", async () => {
    try {
      setWorkerQueueStatus(`${label}恢复中：重置队列并重启 worker 浏览器`);
      const result = await dashboardApi.recoverPlatformWorker(platform);
      appendClientLog(`成功 · ${label} Worker 已恢复`);
      const queue = result.status?.queue;
      if (queue) appendClientLog(`状态 · ${label} 队列 pending=${queue.pending ?? 0} active=${queue.active?.label || "无"}`);
      await refreshWorkerQueues();
    } catch (error) {
      setWorkerQueueStatus(`${label}恢复失败`);
      appendClientLog(`失败 · 恢复${label} Worker：${errorMessage(error)}`);
      await refreshWorkerQueues().catch(() => undefined);
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
  $$("[data-open-platform-worker-challenge]").forEach((button) => {
    button.addEventListener("click", () => openPlatformWorkerChallenge(button.dataset.openPlatformWorkerChallenge, button));
  });
  $$("[data-sync-platform-cookies]").forEach((button) => {
    button.addEventListener("click", () => syncPlatformCookies(button.dataset.syncPlatformCookies, button));
  });
  $$("[data-clear-platform-auth]").forEach((button) => {
    button.addEventListener("click", () => clearPlatformAuth(button.dataset.clearPlatformAuth, button));
  });
  $$("[data-reset-platform-profile]").forEach((button) => {
    button.addEventListener("click", () => resetPlatformProfile(button.dataset.resetPlatformProfile, button));
  });
  $$("[data-recover-platform-worker]").forEach((button) => {
    button.addEventListener("click", () => recoverPlatformWorker(button.dataset.recoverPlatformWorker, button));
  });
}

async function refreshPlatformLoginList() {
  const list = $("platformLoginList");
  if (!list) return [];
  try {
    const result = await dashboardApi.getPlatformLoginStatuses();
    const platforms = (result.platforms || []).filter((platform) => platform.capabilities?.login !== false);
    list.innerHTML = platforms.map(renderPlatformStatus).join("");
    return platforms;
  } catch (error) {
    list.innerHTML = `<div class="platform-login-row warn"><span>平台登录态</span><strong>${escapeHtml(errorMessage(error))}</strong></div>`;
    throw error;
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

async function loadWorkerQueues(list) {
  try {
    const result = await dashboardApi.getPlatformWorkerStatuses();
    const platforms = (result.platforms || []).filter((platform) => platform.implemented !== false);
    if (!platforms.some((platform) => platform.platform === selectedWorkerPlatform)) {
      selectedWorkerPlatform = platforms[0]?.platform || "xhs";
    }
    renderWorkerPlatformTabs(platforms);
    const selected = platforms.filter((platform) => platform.platform === selectedWorkerPlatform);
    list.innerHTML = selected.map(renderWorkerQueueStatus).join("") || `<article class="worker-platform-card warn"><div class="worker-platform-head"><div class="worker-platform-title"><h4>Worker</h4><p>当前平台不可用</p></div><strong>不可用</strong></div></article>`;
    bindWorkerRecoveryButtons(list);
    const busyCount = platforms.filter((platform) => platform.queue?.active || Number(platform.queue?.pending || 0) > 0).length;
    const selectedLabel = selected[0]?.label || platformLabel(selectedWorkerPlatform);
    setWorkerQueueStatus(busyCount ? `${busyCount} 个平台 worker 正在执行或排队 · 当前 ${selectedLabel}` : `所有平台 worker 空闲 · 当前 ${selectedLabel}`);
  } catch (error) {
    list.innerHTML = `<article class="worker-platform-card warn"><div class="worker-platform-head"><div class="worker-platform-title"><h4>Worker</h4><p>${escapeHtml(errorMessage(error))}</p></div><strong>不可用</strong></div></article>`;
    setWorkerQueueStatus("Worker 队列状态读取失败");
  }
}

function renderWorkerPlatformTabs(platforms) {
  const root = $("workerPlatformTabs");
  if (!root) return;
  root.innerHTML = platforms
    .map((platform) => {
      const isActive = platform.platform === selectedWorkerPlatform;
      const pending = Number(platform.queue?.pending || 0);
      const active = platform.queue?.active;
      const runtime = platform.workerRuntime || {};
      const busy = pending > 0 || Boolean(active) || runtime.lease?.active === true;
      const warn = platform.service?.ok === false || runtime.ok === false;
      const badge = warn ? "异常" : busy ? "忙碌" : "空闲";
      return `<button class="worker-platform-tab ${isActive ? "active" : ""} ${warn ? "warn" : busy ? "busy" : "ok"}" data-worker-platform="${escapeHtml(platform.platform)}" type="button"><span>${escapeHtml(platform.label || platformLabel(platform.platform))}</span><strong>${escapeHtml(badge)}</strong></button>`;
    })
    .join("");
  root.querySelectorAll("[data-worker-platform]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedWorkerPlatform = button.dataset.workerPlatform || selectedWorkerPlatform;
      refreshWorkerQueues().catch((error) => appendClientLog(`失败 · 切换任务队列平台：${errorMessage(error)}`));
    });
  });
}

function bindWorkerRecoveryButtons(root) {
  root.querySelectorAll("[data-recover-platform-worker]").forEach((button) => {
    button.addEventListener("click", () => recoverPlatformWorker(button.dataset.recoverPlatformWorker, button));
  });
  root.querySelectorAll("[data-open-platform-worker-challenge]").forEach((button) => {
    button.addEventListener("click", () => openPlatformWorkerChallenge(button.dataset.openPlatformWorkerChallenge, button));
  });
}

function renderWorkerQueueStatus(platform) {
  const label = platform.label || platformLabel(platform.platform);
  const queue = platform.queue || {};
  const runtime = platform.workerRuntime || {};
  const chromeRunning = runtime.chrome?.running === true;
  const cdpReady = runtime.cdp?.ready === true;
  const lease = runtime.lease || {};
  const pending = Number(queue.pending || 0);
  const active = queue.active;
  const isBusy = pending > 0 || Boolean(active) || lease.active === true;
  const isHealthy = platform.service?.ok !== false && runtime.ok !== false && (chromeRunning || cdpReady);
  const state = !isHealthy ? "warn" : isBusy ? "busy" : "ok";
  const statusText = !isHealthy ? "异常" : isBusy ? "忙碌" : "空闲";
  const summary = [
    `排队 ${pending}${queue.maxPending ? ` / 最多 ${queue.maxPending}` : ""}`,
    `运行 ${active?.label || "无"}`
  ];
  const runtimeDetails = [
    `Lease ${lease.active ? `${lease.owner || "runtime"}:${lease.label || ""}` : "无"}`,
    `Chrome ${chromeRunning ? "运行中" : "未运行"}`,
    `CDP ${cdpReady ? "就绪" : "断开"}`,
    `重置代数 ${queue.generation ?? "-"}`,
    runtime.chrome?.pid ? `PID ${runtime.chrome.pid}` : ""
  ].filter(Boolean);
  const tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  const recent = Array.isArray(queue.recent) ? queue.recent : [];
  const error = platform.service?.error || runtime.error;
  return `
    <article class="worker-platform-card ${state}">
      <div class="worker-platform-head">
        <div class="worker-platform-title">
          <h4>${escapeHtml(label)}</h4>
          <p>${escapeHtml(runtimeDetails.join(" · "))}${error ? ` · ${escapeHtml(error)}` : ""}</p>
        </div>
        <span class="worker-status-pill ${state}">${escapeHtml(statusText)}</span>
        <div class="worker-platform-actions">
          <button class="secondary small" data-open-platform-worker-challenge="${escapeHtml(platform.platform)}" type="button">打开 Worker 验证</button>
          <button class="secondary small danger-soft" data-recover-platform-worker="${escapeHtml(platform.platform)}" type="button">重启 Worker</button>
        </div>
      </div>
      <div class="worker-metrics" aria-label="${escapeHtml(label)} worker 指标">
        ${summary.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      </div>
      ${renderCurrentWorkerTasks(tasks)}
      ${renderRecentWorkerTasks(recent)}
    </article>
  `;
}

function renderCurrentWorkerTasks(tasks) {
  if (!tasks.length) {
    return `<div class="worker-task-empty">当前没有运行中或排队中的任务。</div>`;
  }
  return `
    <div class="worker-task-table" aria-label="当前 worker 任务">
      <div class="worker-task-row is-head">
        <span>ID</span>
        <span>状态</span>
        <span>任务</span>
        <span>等待</span>
        <span>运行</span>
        <span>Lease</span>
        <span>信息</span>
      </div>
      ${tasks.map(renderWorkerTaskRow).join("")}
    </div>
  `;
}

function renderRecentWorkerTasks(tasks) {
  if (!tasks.length) return "";
  return `
    <details class="worker-task-recent">
      <summary>最近完成 / 失败任务（${tasks.length}）</summary>
      <div class="worker-task-table">
        ${tasks.slice(0, 8).map(renderWorkerTaskRow).join("")}
      </div>
    </details>
  `;
}

function renderWorkerTaskRow(task) {
  const status = workerTaskStatusLabel(task.status);
  const info = task.cancelReason || task.error || task.finishedAt || task.queuedAt || "";
  const badClass = task.status === "failed" || task.status === "cancelled" || task.cancelled ? " task-bad" : "";
  return `
    <div class="worker-task-row" title="${escapeHtml(workerTaskTitle(task))}">
      <span>#${escapeHtml(String(task.id ?? "-"))}</span>
      <span class="${badClass.trim()}">${escapeHtml(status)}</span>
      <span>${escapeHtml(task.label || "-")}</span>
      <span class="task-muted">${escapeHtml(formatMs(task.waitMs ?? task.ageMs))}</span>
      <span class="task-muted">${escapeHtml(formatMs(task.activeMs ?? task.durationMs))}</span>
      <span class="task-muted">${escapeHtml(task.leaseId ? String(task.leaseId).slice(0, 12) : "无")}</span>
      <span class="${badClass.trim()}">${escapeHtml(String(info || "-"))}</span>
    </div>
  `;
}

function workerTaskStatusLabel(status) {
  if (status === "queued") return "排队";
  if (status === "running") return "运行";
  if (status === "cancelling") return "取消中";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "取消";
  return status || "未知";
}

function workerTaskTitle(task) {
  return [
    `id=${task.id ?? "-"}`,
    `label=${task.label || "-"}`,
    `status=${task.status || "-"}`,
    `queuedAt=${task.queuedAt || "-"}`,
    task.startedAt ? `startedAt=${task.startedAt}` : "",
    task.finishedAt ? `finishedAt=${task.finishedAt}` : "",
    task.leaseId ? `lease=${task.leaseId}` : "",
    task.cancelReason ? `cancel=${task.cancelReason}` : "",
    task.error ? `error=${task.error}` : ""
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatMs(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m${rest}s` : `${minutes}m`;
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

function setWorkerQueueStatus(text) {
  const el = $("workerQueueStatus");
  if (el) el.textContent = text;
}
