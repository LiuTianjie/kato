import { getDefaultCdpPort, openCdpLoginWindow, restartContainerBrowser } from "./cdpLogin.js";
import type { AppConfig } from "../config.js";

const DEFAULT_HOST = "127.0.0.1";
const XHS_WEB_URL = "https://www.xiaohongshu.com/explore";

interface CdpTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse<T = unknown> {
  id?: number;
  result?: T;
  error?: { message?: string };
}

interface Viewport {
  width: number;
  height: number;
}

interface ScreencastOptions {
  port?: number;
  ensure?: boolean;
  width?: number;
  height?: number;
  signal?: AbortSignal;
  onFrame: (frame: { image: string; title: string; url: string; viewport: Viewport; capturedAt: string }) => void;
  onInfo?: (info: { title: string; url: string; viewport: Viewport }) => void;
}

export async function getCdpLoginTarget(
  config: AppConfig,
  options: { port?: number; ensure?: boolean } = {}
): Promise<{ id: string; title: string; url: string; cdpUrl: string; viewport: Viewport }> {
  const port = options.port ?? getDefaultCdpPort();
  if (options.ensure && !(await isCdpOpen(port))) {
    await openCdpLoginWindow(config, { port });
  }
  const target = await findUsablePageTarget(config, port, options.ensure === true);
  const viewport = await getViewport(target.webSocketDebuggerUrl);
  return {
    id: target.id ?? "",
    title: target.title ?? "",
    url: target.url ?? "",
    cdpUrl: `http://${DEFAULT_HOST}:${port}`,
    viewport
  };
}

export async function captureCdpLoginFrame(
  config: AppConfig,
  options: { port?: number; ensure?: boolean; width?: number; height?: number } = {}
): Promise<{ image: string; title: string; url: string; viewport: Viewport; capturedAt: string }> {
  const port = options.port ?? getDefaultCdpPort();
  if (options.ensure && !(await isCdpOpen(port))) {
    await openCdpLoginWindow(config, { port });
  }
  const target = await findUsablePageTarget(config, port, options.ensure === true);
  if (options.width || options.height) {
    await setViewport(target.webSocketDebuggerUrl, options.width, options.height);
  }
  const viewport = await getViewport(target.webSocketDebuggerUrl);
  const screenshot = await sendCdpCommand<{ data?: string }>(target.webSocketDebuggerUrl, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 78,
    captureBeyondViewport: false,
    fromSurface: true
  });
  if (!screenshot.data) throw new Error("CDP 截图为空。");
  return {
    image: `data:image/jpeg;base64,${screenshot.data}`,
    title: target.title ?? "",
    url: target.url ?? "",
    viewport,
    capturedAt: new Date().toISOString()
  };
}

export async function dispatchCdpLoginInput(
  config: AppConfig,
  input: Record<string, unknown>,
  options: { port?: number } = {}
): Promise<{ ok: true }> {
  const port = options.port ?? getDefaultCdpPort();
  return withCdpActionRecovery(config, port, "input", async () => {
    const target = await findUsablePageTarget(config, port, true);
    const type = String(input.type ?? "");

    if (type === "click") {
      const x = numberInRange(input.x, 0, 100_000, "x");
      const y = numberInRange(input.y, 0, 100_000, "y");
      await sendCdpCommand(target.webSocketDebuggerUrl, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1
      });
      await sendCdpCommand(target.webSocketDebuggerUrl, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1
      });
      return { ok: true };
    }

    if (type === "wheel") {
      const x = numberInRange(input.x, 0, 100_000, "x");
      const y = numberInRange(input.y, 0, 100_000, "y");
      const deltaX = numberInRange(input.deltaX ?? 0, -20_000, 20_000, "deltaX");
      const deltaY = numberInRange(input.deltaY ?? 0, -20_000, 20_000, "deltaY");
      await sendCdpCommand(target.webSocketDebuggerUrl, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY
      });
      return { ok: true };
    }

    if (type === "text") {
      const text = String(input.text ?? "");
      if (text) await sendCdpCommand(target.webSocketDebuggerUrl, "Input.insertText", { text });
      return { ok: true };
    }

    if (type === "key") {
      const key = String(input.key ?? "");
      const code = String(input.code ?? "");
      const keyCode = keyToWindowsVirtualKeyCode(key);
      const params = {
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers: Number(input.modifiers ?? 0)
      };
      await sendCdpCommand(target.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { ...params, type: "keyDown" });
      await sendCdpCommand(target.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { ...params, type: "keyUp" });
      return { ok: true };
    }

    throw new Error("不支持的 CDP 输入类型。");
  });
}

export async function dispatchCdpBrowserAction(
  config: AppConfig,
  input: Record<string, unknown>,
  options: { port?: number } = {}
): Promise<{ ok: true; title: string; url: string; viewport: Viewport }> {
  const port = options.port ?? getDefaultCdpPort();
  if (!(await isCdpOpen(port))) {
    await openCdpLoginWindow(config, { port });
  }
  return withCdpActionRecovery(config, port, "browser-action", async () => {
    const action = String(input.action ?? "");
    let target = await findUsablePageTarget(config, port, true);

    if (action === "navigate") {
      const url = normalizeNavigationUrl(input.url);
      await sendCdpCommand(target.webSocketDebuggerUrl, "Page.navigate", { url });
      await waitForPageSettle(target.webSocketDebuggerUrl);
    } else if (action === "back") {
      await sendCdpCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "history.back()" });
      await waitForPageSettle(target.webSocketDebuggerUrl);
    } else if (action === "forward") {
      await sendCdpCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "history.forward()" });
      await waitForPageSettle(target.webSocketDebuggerUrl);
    } else if (action === "reload") {
      await sendCdpCommand(target.webSocketDebuggerUrl, "Page.reload", { ignoreCache: input.ignoreCache === true });
      await waitForPageSettle(target.webSocketDebuggerUrl);
    } else {
      throw new Error("不支持的浏览器动作。");
    }

    target = await findUsablePageTarget(config, port, true);
    const viewport = await getViewport(target.webSocketDebuggerUrl);
    return {
      ok: true,
      title: target.title ?? "",
      url: target.url ?? "",
      viewport
    };
  });
}

export async function streamCdpBrowserFrames(config: AppConfig, options: ScreencastOptions): Promise<void> {
  const port = options.port ?? getDefaultCdpPort();
  if (options.ensure && !(await isCdpOpen(port))) {
    await openCdpLoginWindow(config, { port });
  }
  let target = await findUsablePageTarget(config, port, options.ensure === true);
  if (options.width || options.height) {
    await setViewport(target.webSocketDebuggerUrl, options.width, options.height);
  }
  let viewport = await getViewport(target.webSocketDebuggerUrl);
  options.onInfo?.({ title: target.title ?? "", url: target.url ?? "", viewport });

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    let nextId = 0;
    let isOpen = false;
    let isClosed = false;
    let title = target.title ?? "";
    let url = target.url ?? "";
    let infoTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      if (infoTimer) clearInterval(infoTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    const close = () => {
      cleanup();
      if (isOpen) {
        try {
          socket.send(JSON.stringify({ id: ++nextId, method: "Page.stopScreencast" }));
        } catch {
          // best effort
        }
      }
      socket.close();
    };
    const abort = () => close();
    const send = (method: string, params?: Record<string, unknown>) => {
      socket.send(JSON.stringify({ id: ++nextId, method, params }));
    };

    infoTimer = setInterval(async () => {
      if (isClosed) return;
      const latestTarget = await findPageTarget(port, true).catch(() => undefined);
      if (!latestTarget?.webSocketDebuggerUrl) return;
      target = latestTarget;
      title = latestTarget.title ?? title;
      url = latestTarget.url ?? url;
      viewport = await getViewport(latestTarget.webSocketDebuggerUrl).catch(() => viewport);
      options.onInfo?.({ title, url, viewport });
    }, 1800);

    options.signal?.addEventListener("abort", abort, { once: true });

    socket.addEventListener("open", () => {
      isOpen = true;
      send("Page.enable");
      send("Page.startScreencast", {
        format: "jpeg",
        quality: 74,
        maxWidth: viewport.width,
        maxHeight: viewport.height,
        everyNthFrame: 1
      });
    });

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as CdpResponse<{ data?: string; sessionId?: number }> & {
        method?: string;
        params?: { data?: string; sessionId?: number };
      };
      if (payload.method !== "Page.screencastFrame") return;
      const data = payload.params?.data;
      const sessionId = payload.params?.sessionId;
      if (sessionId != null) {
        send("Page.screencastFrameAck", { sessionId });
      }
      if (!data) return;
      options.onFrame({
        image: `data:image/jpeg;base64,${data}`,
        title,
        url,
        viewport,
        capturedAt: new Date().toISOString()
      });
    });

    socket.addEventListener("close", () => {
      cleanup();
      resolve();
    });

    socket.addEventListener("error", () => {
      cleanup();
      reject(new Error("连接容器 CDP Screencast 失败。"));
    });
  });
}

async function isCdpOpen(port: number): Promise<boolean> {
  const response = await fetch(`http://${DEFAULT_HOST}:${port}/json/version`).catch(() => null);
  return Boolean(response?.ok);
}

async function findUsablePageTarget(
  config: AppConfig,
  port: number,
  allowRestart: boolean
): Promise<Required<Pick<CdpTarget, "webSocketDebuggerUrl">> & CdpTarget> {
  try {
    const target = await findPageTarget(port, true);
    await getViewport(target.webSocketDebuggerUrl);
    return target;
  } catch (error) {
    if (!allowRestart || !isRecoverableCdpError(error)) throw error;
    await restartContainerBrowser(config, `cdp-remote: ${errorMessage(error).slice(0, 180)}`, port);
    const target = await findPageTarget(port, true);
    await getViewport(target.webSocketDebuggerUrl);
    return target;
  }
}

async function withCdpActionRecovery<T>(
  config: AppConfig,
  port: number,
  label: string,
  task: () => Promise<T>
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (!isRecoverableCdpError(error)) throw error;
    await restartContainerBrowser(config, `cdp-${label}: ${errorMessage(error).slice(0, 180)}`, port);
    return task();
  }
}

async function findPageTarget(port: number, createIfMissing: boolean): Promise<Required<Pick<CdpTarget, "webSocketDebuggerUrl">> & CdpTarget> {
  const targets = await fetchTargets(port);
  let page =
    targets.find((target) => {
      const url = String(target.url ?? "").toLowerCase();
      return target.type === "page" && url.includes("xiaohongshu.com");
    }) ?? targets.find((target) => target.type === "page");

  if (!page && createIfMissing) {
    await openCdpTab(port, XHS_WEB_URL);
    page = (await fetchTargets(port)).find((target) => target.type === "page");
  }

  if (!page?.webSocketDebuggerUrl) throw new Error("找不到可视化用的容器 Chromium 页面。");
  return { ...page, webSocketDebuggerUrl: normalizeWebSocketUrl(page.webSocketDebuggerUrl) };
}

function isRecoverableCdpError(error: unknown): boolean {
  return /Target page, context or browser has been closed|Target closed|Page\.getLayoutMetrics|CDP .*超时|WebSocket|ECONNREFUSED|Failed to fetch|Internal error|已关闭|closed|timeout/i.test(
    errorMessage(error)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://${DEFAULT_HOST}:${port}/json`);
  if (!response.ok) throw new Error(`CDP targets 不可用：HTTP ${response.status}`);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error("CDP targets 格式异常。");
  return targets as CdpTarget[];
}

async function openCdpTab(port: number, url: string): Promise<void> {
  const encoded = encodeURIComponent(url);
  const endpoints = [`http://${DEFAULT_HOST}:${port}/json/new?${encoded}`, `http://${DEFAULT_HOST}:${port}/json/new?${url}`];
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, { method: "PUT" }).catch(() => null);
    if (response?.ok) return;
  }
}

async function getViewport(wsUrl: string): Promise<Viewport> {
  const metrics = await sendCdpCommand<{
    cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    visualViewport?: { clientWidth?: number; clientHeight?: number };
  }>(wsUrl, "Page.getLayoutMetrics");
  const viewport = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
  const width = Math.round(Number(viewport.clientWidth ?? 800));
  const height = Math.round(Number(viewport.clientHeight ?? 600));
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

async function setViewport(wsUrl: string, widthValue?: number, heightValue?: number): Promise<void> {
  const width = Math.round(numberInRange(widthValue ?? 1280, 360, 3840, "viewport width"));
  const height = Math.round(numberInRange(heightValue ?? 720, 360, 2160, "viewport height"));
  await sendCdpCommand(wsUrl, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
}

async function waitForPageSettle(wsUrl: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
  await sendCdpCommand(wsUrl, "Runtime.evaluate", {
    expression: "document.readyState",
    returnByValue: true
  }).catch(() => undefined);
}

function normalizeNavigationUrl(value: unknown): string {
  const rawUrl = String(value ?? "").trim();
  if (!rawUrl) throw new Error("地址不能为空。");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只支持 http/https 地址。");
  return url.toString();
}

function sendCdpCommand<T = unknown>(wsUrl: string, method: string, params?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const id = 1;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP ${method} 超时。`));
    }, 10_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id, method, params }));
    });

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as CdpResponse<T>;
      if (payload.id !== id) return;
      clearTimeout(timeout);
      socket.close();
      if (payload.error) {
        reject(new Error(`CDP ${method} 失败：${payload.error.message ?? "unknown error"}`));
        return;
      }
      resolve((payload.result ?? {}) as T);
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("连接容器 CDP WebSocket 失败。"));
    });
  });
}

function normalizeWebSocketUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.hostname = DEFAULT_HOST;
  return url.toString();
}

function numberInRange(value: unknown, min: number, max: number, name: string): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    throw new Error(`无效的 ${name} 坐标。`);
  }
  return numberValue;
}

function keyToWindowsVirtualKeyCode(key: string): number {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  const codes: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Escape: 27,
    " ": 32,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46
  };
  return codes[key] ?? 0;
}
