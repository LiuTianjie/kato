import { dashboardApi } from "../api.js";
import { $, setText } from "../dom.js";
import { errorMessage } from "../format.js";
import { appendClientLog } from "./logPanel.js";

let connected = false;
let viewerUrl = "";

export function bindCdpViewer() {
  $("connectCdpViewer").addEventListener("click", connectCdpViewer);
  $("cdpBack").addEventListener("click", () => runBrowserAction("back"));
  $("cdpForward").addEventListener("click", () => runBrowserAction("forward"));
  $("cdpReload").addEventListener("click", () => runBrowserAction("reload"));
  $("cdpAddressForm").addEventListener("submit", handleAddressSubmit);
  document.querySelector('[data-tab="browser"]')?.addEventListener("click", connectCdpViewer);
  if (window.location.hash === "#browser") window.setTimeout(connectCdpViewer, 0);
  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#browser") connectCdpViewer();
  });
}

export async function connectCdpViewer() {
  if (connected) return;
  connected = true;
  setViewerStatus("连接中");
  appendClientLog("开始 · 连接容器浏览器远程画面");
  try {
    const result = await dashboardApi.openBrowserViewer();
    viewerUrl = result.viewerUrl || "/novnc/vnc.html?autoconnect=1&resize=scale&path=websockify";
    ensureViewerFrame(viewerUrl);
    setAddressValue(result.loginUrl || "https://www.xiaohongshu.com/explore");
    setViewerStatus("远程画面已连接");
    appendClientLog("成功 · 已连接容器浏览器远程画面");
  } catch (error) {
    connected = false;
    setViewerStatus(`连接失败：${errorMessage(error)}`, true);
    appendClientLog(`失败 · 容器浏览器远程画面：${errorMessage(error)}`);
  }
}

export async function reconnectCdpViewer() {
  connected = false;
  clearViewerFrame();
  return connectCdpViewer();
}

async function handleAddressSubmit(event) {
  event.preventDefault();
  const url = $("cdpAddressInput").value.trim();
  await runBrowserAction("navigate", { url });
}

async function runBrowserAction(action, extra = {}) {
  if (!connected) {
    await connectCdpViewer();
  }
  setViewerStatus(action === "navigate" ? "打开中" : "处理中");
  setNavButtonsBusy(true);
  try {
    await dashboardApi.sendBrowserViewerAction({ action, ...extra });
    if (action === "navigate") setAddressValue(extra.url || "");
    setViewerStatus("远程画面已连接");
  } catch (error) {
    setViewerStatus(`操作失败：${errorMessage(error)}`, true);
  } finally {
    setNavButtonsBusy(false);
  }
}

function ensureViewerFrame(url) {
  const wrap = $("cdpScreenWrap");
  let frame = $("browserViewerFrame");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = "browserViewerFrame";
    frame.className = "browser-viewer-frame";
    frame.title = "容器浏览器远程画面";
    frame.allow = "clipboard-read; clipboard-write";
    wrap.replaceChildren(frame);
  }
  if (frame.src !== new URL(url, window.location.origin).href) {
    frame.src = url;
  }
}

function clearViewerFrame() {
  const wrap = $("cdpScreenWrap");
  wrap.replaceChildren();
}

function setAddressValue(url) {
  const input = $("cdpAddressInput");
  if (document.activeElement === input) return;
  input.value = url || "";
}

function setNavButtonsBusy(isBusy) {
  ["cdpBack", "cdpForward", "cdpReload"].forEach((id) => {
    $(id).disabled = isBusy;
  });
}

function setViewerStatus(text, warn = false) {
  setText("cdpViewerStatus", text);
  $("cdpViewerStatus").className = warn ? "status-pill warn" : "status-pill ok";
}
