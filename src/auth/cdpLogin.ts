import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";

const DEFAULT_PORT = 9224;
const DEFAULT_HOST = "127.0.0.1";
const XHS_CREATOR_URL = "https://creator.xiaohongshu.com";
const XHS_WEB_URL = "https://www.xiaohongshu.com/explore";

export interface CdpLoginOptions {
  account?: string;
  port?: number;
  restart?: boolean;
  wait?: boolean;
  syncCookies?: boolean;
  timeoutMs?: number;
}

export interface CdpLoginResult {
  account: string;
  cdpUrl: string;
  profileDir: string;
  loginUrl: string;
  devtoolsUrl: string;
  mcpBaseUrl: string;
  alreadyRunning: boolean;
  restarted: boolean;
  loggedIn?: boolean;
  cookiesPath?: string;
  exportedCookies?: number;
}

export interface BrowserViewerLoginResult {
  account: string;
  mcpBaseUrl: string;
  dashboardUrl: string;
  viewerUrl: string;
  loginUrl: string;
  opened: boolean;
}

export function getDefaultCdpPort(): number {
  const value = Number(process.env.XHS_CDP_PORT || DEFAULT_PORT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PORT;
}

export async function openCdpLoginWindow(config: AppConfig, options: CdpLoginOptions = {}): Promise<CdpLoginResult> {
  const port = options.port ?? getDefaultCdpPort();
  const mcpBaseUrl = getMcpRestBaseUrl(config);
  const cdpUrl = `http://${DEFAULT_HOST}:${port}`;
  let alreadyRunning = await isCdpOpen(port);
  let restarted = false;

  if (alreadyRunning && options.restart) {
    await restartContainerBrowser(config, "cdp-login", port);
    alreadyRunning = false;
    restarted = true;
  }

  if (!alreadyRunning) {
    await requestContainerLoginBrowser(mcpBaseUrl);
    await waitForCdp(port, true, 15_000);
  }

  await openCdpTab(port, XHS_WEB_URL);

  const result: CdpLoginResult = {
    account: options.account?.trim() || "mcp-container",
    cdpUrl,
    profileDir: "mcp/xiaohongshu/data/cookies.json",
    loginUrl: XHS_WEB_URL,
    devtoolsUrl: `${cdpUrl}/json`,
    mcpBaseUrl,
    alreadyRunning,
    restarted
  };

  if (options.wait) {
    result.loggedIn = await waitForLogin(port, options.timeoutMs ?? 5 * 60_000);
  }

  if (options.syncCookies) {
    const syncResult = await syncCdpCookiesToMcp(config, port);
    result.cookiesPath = syncResult.cookiesPath;
    result.exportedCookies = syncResult.exportedCookies;
  }

  return result;
}

export async function openBrowserViewerLogin(config: AppConfig, account?: string): Promise<BrowserViewerLoginResult> {
  const mcpBaseUrl = getMcpRestBaseUrl(config);
  await requestContainerLoginBrowser(mcpBaseUrl);
  const dashboardPort = Number(process.env.PORT || 4173);
  const dashboardUrl = process.env.KATO_DASHBOARD_URL || `http://localhost:${dashboardPort}`;
  return {
    account: account?.trim() || "mcp-container",
    mcpBaseUrl,
    dashboardUrl,
    viewerUrl: `${dashboardUrl.replace(/\/$/, "")}/#browser`,
    loginUrl: XHS_WEB_URL,
    opened: true
  };
}

export async function syncBrowserViewerCookiesToMcp(config: AppConfig): Promise<{ cookiesPath: string; exportedCookies: number }> {
  const mcpBaseUrl = getMcpRestBaseUrl(config);
  const response = await fetch(`${mcpBaseUrl}/api/v1/browser/sync-cookies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(payload)) {
    throw new Error(mcpErrorMessage(payload, `Kato cookie 同步失败：HTTP ${response.status}`));
  }
  const data = payload && typeof payload === "object" && "data" in payload ? (payload as { data: unknown }).data : payload;
  if (!data || typeof data !== "object") {
    throw new Error("Kato cookie 同步返回为空。");
  }
  const cookiesPath = String((data as { cookiesPath?: unknown }).cookiesPath ?? "mcp/xiaohongshu/data/cookies.json");
  const exportedCookies = Number((data as { exportedCookies?: unknown }).exportedCookies ?? 0);
  return { cookiesPath, exportedCookies: Number.isFinite(exportedCookies) ? exportedCookies : 0 };
}

export async function restartContainerBrowser(config: AppConfig, reason = "manual", port = getDefaultCdpPort()): Promise<unknown> {
  const mcpBaseUrl = getMcpRestBaseUrl(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 130_000);
  try {
    const response = await fetch(`${mcpBaseUrl}/api/v1/browser/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Kato 容器浏览器重启失败：HTTP ${response.status} ${JSON.stringify(payload)}`);
    }
    await waitForCdp(port, true, 15_000);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncCdpCookiesToMcp(
  config: AppConfig,
  port = getDefaultCdpPort()
): Promise<{ cookiesPath: string; exportedCookies: number }> {
  if (!(await isCdpOpen(port))) {
    throw new Error(`Chrome CDP 端口 ${port} 不可用，请先运行 auth:cdp 打开登录窗口。`);
  }

  const target = await findCookieTarget(port);
  const cookies = await getAllCookies(target.webSocketDebuggerUrl);
  const xhsCookies = cookies.filter((cookie) => {
    const domain = String(cookie.domain ?? "").toLowerCase();
    return domain.includes("xiaohongshu") || domain.includes("xhs") || domain.includes("rednote");
  });
  if (!xhsCookies.some((cookie) => cookie.name === "web_session" || cookie.name === "id_token")) {
    throw new Error("CDP 浏览器里还没有检测到小红书登录 cookie，请先在 Chrome 窗口完成登录 / 二次验证。");
  }

  const cookiesPath = path.join(config.rootDir, "mcp", "xiaohongshu", "data", "cookies.json");
  mkdirSync(path.dirname(cookiesPath), { recursive: true });
  writeFileSync(cookiesPath, JSON.stringify(xhsCookies), "utf8");
  return { cookiesPath, exportedCookies: xhsCookies.length };
}

export function resolveCdpProfile(config: AppConfig, account?: string): { account: string; profileDir: string } {
  return { account: account?.trim() || "mcp-container", profileDir: "mcp/xiaohongshu/data/cookies.json" };
}

function getMcpRestBaseUrl(config: AppConfig): string {
  return config.xhs.mcp?.url ? new URL(config.xhs.mcp.url).origin : "http://localhost:18060";
}

async function requestContainerLoginBrowser(mcpBaseUrl: string): Promise<unknown> {
  const response = await fetch(`${mcpBaseUrl}/api/v1/login/qrcode`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || isMcpFailure(payload)) {
    throw new Error(mcpErrorMessage(payload, `Kato 容器浏览器接管启动失败：HTTP ${response.status} ${JSON.stringify(payload)}`));
  }
  return payload;
}

function isMcpFailure(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "success" in payload && (payload as { success?: unknown }).success === false);
}

function mcpErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown; message?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

async function waitForLogin(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://${DEFAULT_HOST}:${port}/json`).then((res) => res.json()).catch(() => []);
    if (Array.isArray(targets)) {
      const loggedInTarget = targets.find((target) => {
        if (!target || typeof target !== "object") return false;
        const url = String((target as { url?: unknown }).url ?? "").toLowerCase();
        return url.startsWith(XHS_CREATOR_URL) && !url.includes("login");
      });
      if (loggedInTarget) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return false;
}

async function openCdpTab(port: number, url: string): Promise<void> {
  const encoded = encodeURIComponent(url);
  const endpoints = [`http://${DEFAULT_HOST}:${port}/json/new?${encoded}`, `http://${DEFAULT_HOST}:${port}/json/new?${url}`];
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, { method: "PUT" }).catch(() => null);
    if (response?.ok) return;
  }
}

async function findCookieTarget(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  await openCdpTab(port, XHS_CREATOR_URL);
  const targets = await fetch(`http://${DEFAULT_HOST}:${port}/json`).then((res) => res.json());
  if (!Array.isArray(targets)) throw new Error("无法读取 Chrome CDP 页面列表。");

  const page =
    targets.find((target) => {
      const url = String((target as { url?: unknown }).url ?? "").toLowerCase();
      return url.includes("xiaohongshu.com") && (target as { type?: unknown }).type === "page";
    }) ?? targets.find((target) => (target as { type?: unknown }).type === "page");

  const wsUrl = (page as { webSocketDebuggerUrl?: unknown } | undefined)?.webSocketDebuggerUrl;
  if (typeof wsUrl !== "string") throw new Error("找不到可用于导出 cookie 的 Chrome 页面。");
  return { webSocketDebuggerUrl: normalizeWebSocketUrl(wsUrl) };
}

function getAllCookies(wsUrl: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 0;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("读取 Chrome cookie 超时。"));
    }, 10_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: ++nextId, method: "Network.enable" }));
      socket.send(JSON.stringify({ id: ++nextId, method: "Network.getAllCookies" }));
    });

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as {
        id?: number;
        result?: { cookies?: Array<Record<string, unknown>> };
        error?: { message?: string };
      };
      if (payload.error) {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(payload.error.message ?? "Chrome CDP cookie export failed."));
      }
      if (payload.id === 2) {
        clearTimeout(timeout);
        socket.close();
        resolve(payload.result?.cookies ?? []);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("连接 Chrome CDP WebSocket 失败。"));
    });
  });
}

async function closeBrowser(port: number): Promise<void> {
  const response = await fetch(`http://${DEFAULT_HOST}:${port}/json/version`).catch(() => null);
  if (!response?.ok) return;
  const data = (await response.json().catch(() => ({}))) as { webSocketDebuggerUrl?: string };
  if (!data.webSocketDebuggerUrl) return;
  await sendBrowserClose(normalizeWebSocketUrl(data.webSocketDebuggerUrl));
}

async function isCdpOpen(port: number): Promise<boolean> {
  const response = await fetch(`http://${DEFAULT_HOST}:${port}/json/version`).catch(() => null);
  return Boolean(response?.ok);
}

async function waitForCdp(port: number, shouldBeOpen: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isCdpOpen(port)) === shouldBeOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(shouldBeOpen ? `Chrome CDP 端口 ${port} 未就绪。` : `Chrome CDP 端口 ${port} 未释放。`);
}

function normalizeWebSocketUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    url.hostname = DEFAULT_HOST;
    return url.toString();
  } catch {
    return wsUrl;
  }
}

function sendBrowserClose(wsUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("关闭容器浏览器超时。"));
    }, 5_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });
    socket.addEventListener("message", () => {
      clearTimeout(timeout);
      socket.close();
      resolve();
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("连接容器 CDP WebSocket 失败。"));
    });
  });
}
