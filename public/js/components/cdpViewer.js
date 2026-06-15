import { dashboardApi } from "../api.js";
import { $, setText } from "../dom.js";
import { errorMessage } from "../format.js";
import { appendClientLog } from "./logPanel.js";

let stream = null;
let connected = false;
let pendingFrame = false;
let lastViewport = { width: 800, height: 600 };
let lastRequestedViewport = null;
let resizeTimer = null;

export function bindCdpViewer() {
  $("connectCdpViewer").addEventListener("click", connectCdpViewer);
  $("cdpBack").addEventListener("click", () => runBrowserAction("back"));
  $("cdpForward").addEventListener("click", () => runBrowserAction("forward"));
  $("cdpReload").addEventListener("click", () => runBrowserAction("reload"));
  $("cdpAddressForm").addEventListener("submit", handleAddressSubmit);
  $("cdpScreen").addEventListener("click", handleScreenClick);
  $("cdpScreen").addEventListener("wheel", handleScreenWheel, { passive: false });
  $("cdpScreenWrap").addEventListener("keydown", handleKeyDown);
  $("cdpScreenWrap").addEventListener("paste", handlePaste);
  observeViewerSize();
  document.querySelector('[data-tab="browser"]')?.addEventListener("click", connectCdpViewer);
}

export async function connectCdpViewer() {
  if (connected) return;
  connected = true;
  setViewerStatus("连接中");
  $("cdpScreenWrap").focus();
  appendClientLog("开始 · 连接容器 Chromium 实时画面");
  try {
    const target = await dashboardApi.getCdpTarget();
    lastViewport = target.viewport || lastViewport;
    setTargetText(target);
    setAddressValue(target.url);
    startStream();
    appendClientLog(`成功 · 已连接容器浏览器：${target.url || target.title || "page"}`);
  } catch (error) {
    connected = false;
    stopStream();
    setViewerStatus(`连接失败：${errorMessage(error)}`, true);
    appendClientLog(`失败 · 容器浏览器画面：${errorMessage(error)}`);
  }
}

export async function reconnectCdpViewer() {
  connected = false;
  stopStream();
  $("cdpScreen").removeAttribute("src");
  return connectCdpViewer();
}

function startStream() {
  stopStream();
  const requestedViewport = getRequestedViewport();
  lastRequestedViewport = requestedViewport;
  stream = new EventSource(dashboardApi.getCdpScreencastUrl(requestedViewport));
  stream.addEventListener("open", () => {
    setViewerStatus("已连接");
  });
  stream.addEventListener("info", (event) => {
    const info = JSON.parse(event.data);
    lastViewport = info.viewport || lastViewport;
    setTargetText(info);
    setAddressValue(info.url);
  });
  stream.addEventListener("frame", (event) => {
    const frame = JSON.parse(event.data);
    lastViewport = frame.viewport || lastViewport;
    $("cdpScreen").src = frame.image;
    setTargetText(frame);
    setAddressValue(frame.url);
    setViewerStatus("实时连接");
  });
  stream.addEventListener("error", () => {
    setViewerStatus("视频流重连中", true);
  });
}

function observeViewerSize() {
  const wrap = $("cdpScreenWrap");
  const observer = new ResizeObserver(() => {
    if (!connected) return;
    const nextViewport = getRequestedViewport();
    if (!isMeaningfulViewportChange(nextViewport)) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      setViewerStatus("调整画面");
      startStream();
    }, 220);
  });
  observer.observe(wrap);
}

function isMeaningfulViewportChange(nextViewport) {
  if (!lastRequestedViewport) return true;
  return (
    Math.abs(nextViewport.width - lastRequestedViewport.width) >= 24 ||
    Math.abs(nextViewport.height - lastRequestedViewport.height) >= 24
  );
}

function stopStream() {
  if (stream) {
    stream.close();
    stream = null;
  }
}

async function captureFrame() {
  if (pendingFrame) return;
  pendingFrame = true;
  try {
    const requestedViewport = getRequestedViewport();
    const frame = await dashboardApi.getCdpFrame(requestedViewport);
    lastViewport = frame.viewport || lastViewport;
    $("cdpScreen").src = frame.image;
    setTargetText(frame);
    setAddressValue(frame.url);
    setViewerStatus("已连接");
  } catch (error) {
    setViewerStatus(`刷新失败：${errorMessage(error)}`, true);
  } finally {
    pendingFrame = false;
  }
}

function getRequestedViewport() {
  const wrap = $("cdpScreenWrap");
  const rect = wrap.getBoundingClientRect();
  const style = getComputedStyle(wrap);
  const horizontalPadding = parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
  const verticalPadding = parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0");
  const availableWidth = Math.max(1, Math.round((rect.width || 1280) - horizontalPadding));
  const availableHeight = Math.max(1, Math.round((rect.height || 720) - verticalPadding));
  return {
    width: Math.max(720, Math.min(2200, availableWidth)),
    height: Math.max(480, Math.min(1400, availableHeight))
  };
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
    const target = await dashboardApi.sendCdpBrowserAction({ action, ...extra });
    lastViewport = target.viewport || lastViewport;
    setTargetText(target);
    setAddressValue(target.url);
  } catch (error) {
    setViewerStatus(`操作失败：${errorMessage(error)}`, true);
  } finally {
    setNavButtonsBusy(false);
  }
}

async function handleScreenClick(event) {
  $("cdpScreenWrap").focus();
  const point = getBrowserPointFromEvent(event);
  if (!point) return;
  try {
    await dashboardApi.sendCdpInput({ type: "click", x: point.x, y: point.y });
  } catch (error) {
    setViewerStatus(`点击失败：${errorMessage(error)}`, true);
  }
}

async function handleScreenWheel(event) {
  if (!connected) return;
  const point = getBrowserPointFromEvent(event, { clamp: true });
  if (!point) return;
  event.preventDefault();
  const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? lastViewport.height : 1;
  try {
    await dashboardApi.sendCdpInput({
      type: "wheel",
      x: point.x,
      y: point.y,
      deltaX: event.deltaX * multiplier,
      deltaY: event.deltaY * multiplier
    });
  } catch (error) {
    setViewerStatus(`滚动失败：${errorMessage(error)}`, true);
  }
}

function getBrowserPointFromEvent(event, options = {}) {
  const image = $("cdpScreen");
  if (!image.src) return null;
  const contentRect = getRenderedFrameRect(image);
  const rawX = event.clientX - contentRect.left;
  const rawY = event.clientY - contentRect.top;
  if (!options.clamp && (rawX < 0 || rawY < 0 || rawX > contentRect.width || rawY > contentRect.height)) {
    return null;
  }
  const clampedX = Math.max(0, Math.min(contentRect.width, rawX));
  const clampedY = Math.max(0, Math.min(contentRect.height, rawY));
  return {
    x: (clampedX / contentRect.width) * lastViewport.width,
    y: (clampedY / contentRect.height) * lastViewport.height
  };
}

function getRenderedFrameRect(image) {
  const rect = image.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}

async function handleKeyDown(event) {
  if (!connected) return;
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  try {
    if (event.key.length === 1) {
      await dashboardApi.sendCdpInput({ type: "text", text: event.key });
    } else {
      await dashboardApi.sendCdpInput({
        type: "key",
        key: event.key,
        code: event.code,
        modifiers: event.altKey ? 1 : event.shiftKey ? 8 : 0
      });
    }
  } catch (error) {
    setViewerStatus(`输入失败：${errorMessage(error)}`, true);
  }
}

async function handlePaste(event) {
  if (!connected) return;
  const text = event.clipboardData?.getData("text");
  if (!text) return;
  event.preventDefault();
  try {
    await dashboardApi.sendCdpInput({ type: "text", text });
  } catch (error) {
    setViewerStatus(`粘贴失败：${errorMessage(error)}`, true);
  }
}

function setTargetText(target) {
  const title = $("cdpViewerTitle");
  const url = $("cdpViewerUrl");
  if (title) title.textContent = target.title || "容器 Chromium";
  if (url) url.textContent = target.url || "";
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
