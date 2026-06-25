import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { initSchema } from "../db/schema.js";
import { getDefaultCdpPort, openCdpLoginWindow, syncCdpCookiesToMcp } from "../auth/cdpLogin.js";
import {
  captureCdpLoginFrame,
  dispatchCdpBrowserAction,
  dispatchCdpLoginInput,
  getCdpLoginTarget,
  streamCdpBrowserFrames
} from "../auth/cdpRemote.js";
import { handlePublicXhsApi, isPublicXhsApiPath } from "./publicXhsApi.js";
import { handlePublicDouyinApi, isPublicDouyinApiPath } from "./publicDouyinApi.js";
import { handlePublicBilibiliApi, isPublicBilibiliApiPath } from "./publicBilibiliApi.js";
import { getConfiguredApiToken, isAuthorizedRequest, isValidApiToken } from "./apiAuth.js";
import { getPlatformSpec, listPlatformSpecs, normalizePlatformViewerUrl, requirePlatformSpec } from "../platforms/registry.js";
import type { PlatformId } from "../platforms/types.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.outputDir, { recursive: true });
const db = openDb(config);
initSchema(db);

const publicDir = path.join(config.rootDir, "public");
const port = Number(process.env.PORT ?? 4173);
const defaultBrowserRuntimeUrl =
  process.env.BROWSER_RUNTIME_URL ||
  process.env.XHS_BROWSER_RUNTIME_URL ||
  `http://127.0.0.1:${process.env.BROWSER_RUNTIME_PORT || process.env.XHS_BROWSER_RUNTIME_PORT || 18100}`;
const douyinServiceUrl = process.env.DOUYIN_SERVICE_URL || `http://127.0.0.1:${process.env.DOUYIN_SERVICE_PORT || 18070}`;
const bilibiliServiceUrl = process.env.BILIBILI_SERVICE_URL || `http://127.0.0.1:${process.env.BILIBILI_SERVICE_PORT || 18080}`;
const defaultNoVncHost = process.env.BROWSER_NOVNC_HOST || process.env.XHS_NOVNC_HOST || "127.0.0.1";
const legacyCdpLoginEnabled =
  process.env.KATO_ENABLE_LEGACY_CDP_LOGIN === "1" || process.env.XHS_LEGACY_CDP_LOGIN_ENABLED === "1";
type RuntimeKind = "viewer" | "worker";

const noVncViewerTickets = new Map<string, { platform: PlatformId; kind: RuntimeKind; expiresAt: number }>();
const NO_VNC_VIEWER_TICKET_TTL_MS = 12 * 60 * 60 * 1000;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/novnc")) {
      if (isNoVncProtectedPath(url) && !isAuthorizedNoVncRequest(req, url)) {
        sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "Missing or invalid noVNC viewer token." } });
        return;
      }
      proxyNoVncHttp(req, res, url);
      return;
    }
    if (
      url.pathname.startsWith("/api/") ||
      isPublicXhsApiPath(url.pathname) ||
      isPublicDouyinApiPath(url.pathname) ||
      isPublicBilibiliApiPath(url.pathname)
    ) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/novnc") || !isAuthorizedNoVncRequest(req, url)) {
    socket.destroy();
    return;
  }
  proxyNoVncUpgrade(req, socket, head, url);
});

server.listen(port, () => {
  console.log(`Dashboard: http://localhost:${port}`);
});

process.on("SIGINT", () => {
  db.close();
  server.close(() => process.exit(0));
});

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (await handlePublicXhsApi(req, res, url, { config, db })) return;
  if (await handlePublicDouyinApi(req, res, url)) return;
  if (await handlePublicBilibiliApi(req, res, url)) return;

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(res, 200, { authenticated: isAuthorizedRequest(req), tokenConfigured: Boolean(getConfiguredApiToken()) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req);
    const token = String(body.token || "").trim();
    if (!token || !isValidApiToken(token)) {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "API token 不正确" } });
      return;
    }
    sendJson(res, 200, { authenticated: true });
    return;
  }

  if (!isAuthorizedRequest(req)) {
    sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "Missing or invalid Kato API token." } });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(res, 200, {
      service: "kato",
      purpose: "serverx-platform-api",
      platforms: listPlatformSpecs().map((platform) => ({
        id: platform.id,
        label: platform.label,
        implemented: platform.implemented,
        capabilities: platform.capabilities
      }))
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/platforms") {
    sendJson(res, 200, {
      platforms: listPlatformSpecs().map((platform) => ({
        id: platform.id,
        label: platform.label,
        implemented: platform.implemented,
        homeUrl: platform.homeUrl,
        capabilities: platform.capabilities
      }))
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/platforms/login-status") {
    sendJson(res, 200, { platforms: await Promise.all(listPlatformSpecs().map((platform) => getPlatformLoginStatus(platform.id))) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/platforms/sync-cookies") {
    const body = await readJson(req);
    const platform = requirePlatformSpec(body.platform);
    sendJson(res, 200, await syncPlatformCookies(platform.id));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/platforms/export-auth") {
    const body = await readJson(req);
    const platform = requirePlatformSpec(body.platform);
    sendJson(res, 200, { success: true, data: await exportPlatformAuth(platform.id) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/collection/jobs") {
    const body = await readJson(req);
    const platform = requirePlatformSpec(body.platform);
    sendJson(res, 200, { success: true, data: await postPlatformCollectionJob(platform.id, body) });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/v1/collection/jobs/")) {
    const platform = requirePlatformSpec(url.searchParams.get("platform") || "bilibili");
    const jobId = url.pathname.split("/").pop() || "";
    sendJson(res, 200, { success: true, data: await fetchPlatformCollectionJob(platform.id, jobId) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/platforms/worker-status") {
    sendJson(res, 200, { platforms: await Promise.all(listPlatformSpecs().map((platform) => getPlatformWorkerStatus(platform.id))) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/platforms/worker/recover") {
    const body = await readJson(req);
    const platform = requirePlatformSpec(body.platform);
    sendJson(res, 200, await recoverPlatformWorker(platform.id));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/hybrid/update_cookie") {
    if (!hasSharedApiToken(req)) {
      sendJson(res, 401, { code: 40101, message: "Missing or invalid API token.", data: null });
      return;
    }
    try {
      const body = await readJson(req);
      const service = String(body.service || body.platform || "").trim().toLowerCase();
      if (service === "douyin" || service === "dy" || service === "抖音") {
        await postDouyinJson("/api/v1/browser/update-cookie", body, 35_000);
        sendJson(res, 200, { code: 200, message: "success", data: { message: "Cookie for douyin updated successfully" } });
        return;
      }
      if (service === "bilibili" || service === "bili" || service === "b站") {
        await postBilibiliJson("/api/v1/browser/update-cookie", body, 35_000);
        sendJson(res, 200, { code: 200, message: "success", data: { message: "Cookie for bilibili updated successfully" } });
        return;
      }
      sendJson(res, 400, { code: 40001, message: "invalid service", data: null });
    } catch (error) {
      sendJson(res, 500, { code: 50001, message: error instanceof Error ? error.message : String(error), data: null });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/browser-runtime/logs") {
    sendJson(res, 200, await browserRuntimeLogs(url));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser-viewer/open") {
    const body = await readJson(req);
    const platform = getPlatformSpec(body.platform);
    const kind = normalizeRuntimeKind(body.kind ?? body.runtimeKind);
    const targetUrl = normalizePlatformViewerUrl(platform, String(body.url ?? body.query ?? ""));
    await postRuntimeJson(runtimeUrlForKind(platform, kind), "/browser/open", { url: targetUrl }, 45_000);
    await waitForBrowserViewerReady(platform.id, kind, 10_000);
    sendJson(res, 200, {
      opened: true,
      platform: platform.id,
      kind,
      viewerUrl: noVncViewerUrl(platform.id, kind),
      loginUrl: targetUrl,
      homeUrl: platform.homeUrl
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser-viewer/action") {
    const body = await readJson(req);
    sendJson(res, 200, await runBrowserViewerAction(body));
    return;
  }

  if (url.pathname.startsWith("/api/cdp-login/") && !legacyCdpLoginEnabled) {
    sendJson(res, 410, { error: "Legacy CDP login API is disabled. Use /api/browser-viewer/* instead." });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cdp-login/open") {
    const body = await readJson(req);
    const result = await openCdpLoginWindow(config, {
      account: typeof body.account === "string" ? body.account : undefined,
      port: Number(body.port ?? getDefaultCdpPort()),
      restart: body.restart === true
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cdp-login/sync-cookies") {
    const body = await readJson(req);
    const result = await syncCdpCookiesToMcp(config, Number(body.port ?? getDefaultCdpPort()));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cdp-login/target") {
    sendJson(res, 200, await getCdpLoginTarget(config, { ensure: url.searchParams.get("ensure") === "1" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cdp-login/frame") {
    sendJson(
      res,
      200,
      await captureCdpLoginFrame(config, {
        ensure: url.searchParams.get("ensure") === "1",
        width: Number(url.searchParams.get("width") || 0) || undefined,
        height: Number(url.searchParams.get("height") || 0) || undefined
      })
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cdp-login/screencast") {
    await streamCdpSse(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cdp-login/input") {
    const body = await readJson(req);
    sendJson(res, 200, await dispatchCdpLoginInput(config, body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cdp-login/browser-action") {
    const body = await readJson(req);
    sendJson(res, 200, await dispatchCdpBrowserAction(config, body));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function streamCdpSse(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");

  const sendEvent = (event: string, data: unknown) => {
    if (res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await streamCdpBrowserFrames(config, {
      ensure: url.searchParams.get("ensure") === "1",
      width: Number(url.searchParams.get("width") || 0) || undefined,
      height: Number(url.searchParams.get("height") || 0) || undefined,
      signal: controller.signal,
      onInfo: (info) => sendEvent("info", info),
      onFrame: (frame) => sendEvent("frame", frame)
    });
  } catch (error) {
    if (!res.destroyed) {
      sendEvent("error", { error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    if (!res.destroyed) res.end();
  }
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  res.setHeader("Content-Type", contentType(filePath));
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  createReadStream(filePath).pipe(res);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function hasSharedApiToken(req: IncomingMessage): boolean {
  return isAuthorizedRequest(req);
}

async function fetchMcpJson(endpoint: string, timeoutMs = 20_000): Promise<unknown> {
  const base = config.xhs.mcp?.url ? new URL(config.xhs.mcp.url).origin : "http://localhost:18060";
  const response = await fetchWithTimeout(`${base}${endpoint}`, {}, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `MCP ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function postMcpJson(endpoint: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<unknown> {
  const base = config.xhs.mcp?.url ? new URL(config.xhs.mcp.url).origin : "http://localhost:18060";
  const response = await fetchWithTimeout(`${base}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `MCP ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function fetchDouyinJson(endpoint: string, timeoutMs = 20_000): Promise<unknown> {
  const response = await fetchWithTimeout(`${douyinServiceUrl.replace(/\/$/, "")}${endpoint}`, {}, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `Douyin ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function postDouyinJson(endpoint: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<unknown> {
  const response = await fetchWithTimeout(`${douyinServiceUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `Douyin ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function fetchBilibiliJson(endpoint: string, timeoutMs = 20_000): Promise<unknown> {
  const response = await fetchWithTimeout(`${bilibiliServiceUrl.replace(/\/$/, "")}${endpoint}`, {}, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `Bilibili ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function postBilibiliJson(endpoint: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<unknown> {
  const response = await fetchWithTimeout(`${bilibiliServiceUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `Bilibili ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function postPlatformCollectionJob(platform: PlatformId, body: Record<string, unknown>): Promise<unknown> {
  if (platform === "bilibili") {
    return unwrapMcpData(await postBilibiliJson("/api/v1/collection/jobs", body, 35_000));
  }
  throw new Error(`Collection jobs for ${platform} are not implemented yet.`);
}

async function fetchPlatformCollectionJob(platform: PlatformId, jobId: string): Promise<unknown> {
  if (!jobId) throw new Error("job_id is required.");
  if (platform === "bilibili") {
    return unwrapMcpData(await fetchBilibiliJson(`/api/v1/collection/jobs/${encodeURIComponent(jobId)}`, 20_000));
  }
  throw new Error(`Collection jobs for ${platform} are not implemented yet.`);
}

async function fetchRuntimeJson(baseUrl: string, endpoint: string, timeoutMs = 20_000): Promise<unknown> {
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {}, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `Browser runtime ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function postRuntimeJson(baseUrl: string, endpoint: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<unknown> {
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `Browser runtime ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
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

function unwrapMcpData(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

async function getPlatformLoginStatus(platform: PlatformId): Promise<Record<string, unknown>> {
  const spec = getPlatformSpec(platform);
  if (!spec.implemented || !spec.capabilities.login) {
    return { platform: spec.id, label: spec.label, implemented: false, is_logged_in: false, error: "未接入登录能力" };
  }
  try {
    const payload =
      platform === "douyin"
        ? await fetchDouyinJson("/api/v1/login/status", 35_000)
        : platform === "bilibili"
          ? await fetchBilibiliJson("/api/v1/login/status", 35_000)
          : await fetchMcpJson("/api/v1/login/status", 35_000);
    const data = unwrapMcpData(payload) as Record<string, unknown>;
    return { platform: spec.id, label: spec.label, implemented: true, ...data };
  } catch (error) {
    return {
      platform: spec.id,
      label: spec.label,
      implemented: true,
      is_logged_in: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function syncPlatformCookies(platform: PlatformId): Promise<Record<string, unknown>> {
  const spec = getPlatformSpec(platform);
  if (!spec.implemented || !spec.capabilities.login) {
    return { platform: spec.id, label: spec.label, synced: false, error: "未接入登录能力" };
  }
  const payload =
    platform === "douyin"
      ? await postDouyinJson("/api/v1/browser/sync-cookies", {}, 35_000)
      : platform === "bilibili"
        ? await postBilibiliJson("/api/v1/browser/sync-cookies", {}, 35_000)
        : await postMcpJson("/api/v1/browser/sync-cookies", {}, 35_000);
  const data = unwrapMcpData(payload) as Record<string, unknown>;
  return { platform: spec.id, label: spec.label, synced: true, ...data };
}

async function exportPlatformAuth(platform: PlatformId): Promise<Record<string, unknown>> {
  const spec = getPlatformSpec(platform);
  if (!spec.implemented || !spec.capabilities.login) {
    return { platform: spec.id, label: spec.label, exported: false, error: "未接入登录能力" };
  }
  const [cookiesPayload, storagePayload] = await Promise.all([
    postRuntimeJson(
      runtimeUrlForKind(spec, "viewer"),
      "/browser/cookies/export",
      { domains: spec.cookieDomains },
      35_000
    ),
    postRuntimeJson(
      runtimeUrlForKind(spec, "viewer"),
      "/browser/storage/export",
      { domains: spec.cookieDomains, origins: spec.cookieDomains },
      35_000
    ).catch(() => ({}))
  ]);
  const cookiesData = unwrapMcpData(cookiesPayload) as Record<string, unknown>;
  const storageData = unwrapMcpData(storagePayload) as Record<string, unknown>;
  const cookies = Array.isArray(cookiesData.cookies) ? cookiesData.cookies : [];
  const storage = Array.isArray(storageData.storage) ? storageData.storage : [];
  return {
    platform: spec.id,
    label: spec.label,
    exported: true,
    cookie: cookiesToHeader(cookies),
    cookies,
    storage,
    storage_json: JSON.stringify(storage),
    cookie_count: cookies.length,
    storage_origin_count: storage.length
  };
}

function cookiesToHeader(cookies: unknown[]): string {
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const item of cookies) {
    if (!item || typeof item !== "object") continue;
    const cookie = item as Record<string, unknown>;
    const name = String(cookie.name || "").trim();
    const value = String(cookie.value || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    pairs.push(`${name}=${value}`);
  }
  return pairs.join("; ");
}

async function getPlatformWorkerStatus(platform: PlatformId): Promise<Record<string, unknown>> {
  const spec = getPlatformSpec(platform);
  if (!spec.implemented) {
    return { platform: spec.id, label: spec.label, implemented: false, error: "未接入平台服务" };
  }
  const [service, workerRuntime] = await Promise.all([safePlatformServiceHealth(platform), safeWorkerRuntimeHealth(platform)]);
  const servicePayload = service.payload as { ok?: unknown; service?: unknown; browser?: unknown; auth?: unknown } | undefined;
  const browser = servicePayload?.browser && typeof servicePayload.browser === "object" ? (servicePayload.browser as Record<string, unknown>) : undefined;
  const queue = browser?.queue && typeof browser.queue === "object" ? (browser.queue as Record<string, unknown>) : undefined;
  const runtimePayload = workerRuntime.payload as { ok?: unknown; runtime?: unknown } | undefined;
  const runtime =
    runtimePayload?.runtime && typeof runtimePayload.runtime === "object" ? (runtimePayload.runtime as Record<string, unknown>) : undefined;
  return {
    platform: spec.id,
    label: spec.label,
    implemented: spec.implemented,
    service: {
      ok: service.ok,
      name: servicePayload?.service || spec.serviceName,
      error: service.error
    },
    queue: queue || null,
    auth: servicePayload?.auth || null,
    workerRuntime: {
      ok: workerRuntime.ok,
      error: workerRuntime.error,
      chrome: runtime && typeof runtime.chrome === "object" ? runtime.chrome : null,
      cdp: runtime && typeof runtime.cdp === "object" ? runtime.cdp : null,
      lease: runtime && typeof runtime.lease === "object" ? runtime.lease : null,
      logs: runtime && typeof runtime.logs === "object" ? runtime.logs : null
    }
  };
}

async function recoverPlatformWorker(platform: PlatformId): Promise<Record<string, unknown>> {
  const spec = getPlatformSpec(platform);
  if (!spec.implemented) {
    return { platform: spec.id, label: spec.label, recovered: false, error: "未接入平台服务" };
  }
  const steps: Record<string, unknown> = {};
  const reason = `dashboard worker recovery: ${spec.id}`;

  if (platform === "xhs" || platform === "douyin") {
    steps.queueReset = await resetPlatformWorkerQueue(platform, reason);
    await delay(800);
  }

  steps.workerRestart = await restartPlatformWorkerWithRetry(platform, reason);
  await delay(600);
  const status = await getPlatformWorkerStatus(platform);
  return {
    platform: spec.id,
    label: spec.label,
    recovered: true,
    steps,
    status
  };
}

async function safePlatformServiceHealth(platform: PlatformId): Promise<{ ok: boolean; payload?: unknown; error?: string }> {
  try {
    const payload =
      platform === "douyin"
        ? await fetchDouyinJson("/health?ensure=0", 8_000)
        : platform === "bilibili"
          ? await fetchBilibiliJson("/health", 8_000)
          : await fetchMcpJson("/health?ensure=0", 8_000);
    const ok = payload && typeof payload === "object" && "ok" in payload ? (payload as { ok?: unknown }).ok !== false : true;
    return { ok, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function safeWorkerRuntimeHealth(platform: PlatformId): Promise<{ ok: boolean; payload?: unknown; error?: string }> {
  const spec = getPlatformSpec(platform);
  if (!spec.workerRuntimeUrl) return { ok: false, error: "未配置 worker runtime" };
  try {
    const payload = await fetchRuntimeJson(spec.workerRuntimeUrl, "/health", 5_000);
    const ok = payload && typeof payload === "object" && "ok" in payload ? (payload as { ok?: unknown }).ok !== false : true;
    return { ok, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function resetPlatformWorkerQueue(platform: PlatformId, reason: string): Promise<unknown> {
  const payload =
    platform === "douyin"
      ? await postDouyinJson("/api/v1/browser/queue/reset", { reason }, 20_000)
      : await postMcpJson("/api/v1/browser/queue/reset", { reason }, 20_000);
  return unwrapMcpData(payload);
}

async function restartPlatformWorkerWithRetry(platform: PlatformId, reason: string): Promise<unknown> {
  try {
    return await restartPlatformWorker(platform, reason);
  } catch (error) {
    if (!isLeaseBusyError(error)) throw error;
    await delay(1_500);
    return restartPlatformWorker(platform, `${reason} retry after lease release`);
  }
}

async function restartPlatformWorker(platform: PlatformId, reason: string): Promise<unknown> {
  if (platform === "douyin") {
    const payload = await postDouyinJson("/api/v1/browser/restart", { reason }, 130_000);
    return unwrapMcpData(payload);
  }
  if (platform === "xhs") {
    const payload = await postMcpJson("/api/v1/browser/restart", { reason }, 130_000);
    return unwrapMcpData(payload);
  }
  const spec = getPlatformSpec(platform);
  if (!spec.workerRuntimeUrl) throw new Error(`${spec.label} 未配置 worker runtime`);
  return postRuntimeJson(spec.workerRuntimeUrl, "/browser/restart", { reason }, 130_000);
}

function isLeaseBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /423|lease|busy|blocked by active lease/i.test(message);
}

async function runBrowserViewerAction(body: Record<string, unknown>): Promise<{ ok: true }> {
  const action = String(body.action ?? "");
  const platform = getPlatformSpec(body.platform);
  const kind = normalizeRuntimeKind(body.kind ?? body.runtimeKind);
  const payload = action === "navigate" ? { ...body, url: normalizePlatformViewerUrl(platform, String(body.url ?? "")) } : body;
  await postRuntimeJson(runtimeUrlForKind(platform, kind), "/browser/action", payload, 20_000);
  return { ok: true };
}

async function browserRuntimeLogs(url: URL): Promise<Record<string, unknown>> {
  const platformParam = url.searchParams.get("platform");
  const kindParam = url.searchParams.get("kind");
  const query = `/browser/logs${url.search}`;
  const targets = platformParam
    ? runtimeLogTargets(getPlatformSpec(platformParam), kindParam)
    : listPlatformSpecs()
        .filter((platform) => platform.implemented)
        .flatMap((platform) => runtimeLogTargets(platform, kindParam));

  const results = await Promise.all(
    targets.map(async (target) => {
      try {
        const payload = await fetchRuntimeJson(target.baseUrl, query, 5_000);
        const data = unwrapMcpData(payload) as { logs?: unknown[]; cursor?: unknown };
        return {
          source: target.source,
          cursor: Number(data.cursor || 0),
          logs: (Array.isArray(data.logs) ? data.logs : []).map((entry) =>
            entry && typeof entry === "object" ? { sourceRuntime: target.source, ...entry } : { sourceRuntime: target.source, message: String(entry) }
          )
        };
      } catch (error) {
        return {
          source: target.source,
          cursor: 0,
          logs: [
            {
              sourceRuntime: target.source,
              level: "error",
              message: error instanceof Error ? error.message : String(error)
            }
          ]
        };
      }
    })
  );
  return {
    success: true,
    data: {
      logs: results.flatMap((result) => result.logs),
      cursor: Math.max(0, ...results.map((result) => result.cursor)),
      sources: results.map((result) => result.source)
    }
  };
}

function runtimeLogTargets(platform: ReturnType<typeof getPlatformSpec>, kindParam?: string | null): Array<{ source: string; baseUrl: string }> {
  const targets: Array<{ source: string; baseUrl: string }> = [];
  if (kindParam !== "worker" && platform.viewerRuntimeUrl) targets.push({ source: `${platform.id}:viewer`, baseUrl: platform.viewerRuntimeUrl });
  if (kindParam !== "viewer" && platform.workerRuntimeUrl) targets.push({ source: `${platform.id}:worker`, baseUrl: platform.workerRuntimeUrl });
  return targets;
}

async function waitForBrowserViewerReady(platform: PlatformId, kind: RuntimeKind, timeoutMs: number): Promise<void> {
  const spec = getPlatformSpec(platform);
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const runtime = await fetchRuntimeJson(runtimeUrlForKind(spec, kind), "/health?ensure=1", 3_000);
      const ready = (runtime as { runtime?: { noVnc?: { ready?: boolean } } }).runtime?.noVnc?.ready === true;
      if (ready) return;
      lastError = "runtime noVNC not ready";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(400);
  }
  throw new Error(`noVNC 未就绪：${lastError || "等待超时"}`);
}

function probeTcpPort(port: number, host: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, host);
    const done = (error?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`${host}:${port} 连接超时`)));
    socket.on("connect", () => done());
    socket.on("error", (error) => done(error));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proxyNoVncHttp(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const target = noVncTarget(url);
  const proxyReq = httpRequest(
    {
      hostname: target.host,
      port: target.port,
      method: req.method,
      path: target.path,
      headers: { ...req.headers, host: `${target.host}:${target.port}` }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", (error) => {
    if (!res.headersSent) sendJson(res, 502, { error: `noVNC 不可用：${error.message}` });
    else res.destroy(error);
  });
  req.pipe(proxyReq);
}

function proxyNoVncUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
  const target = noVncTarget(url);
  const upstream = connectTcp(target.port, target.host);
  upstream.on("connect", () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}`)
      .join("\r\n");
    upstream.write(`${req.method ?? "GET"} ${target.path} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
}

function noVncViewerUrl(platform: PlatformId, kind: RuntimeKind): string {
  const ticket = createNoVncViewerTicket(platform, kind);
  const websocketPath = `novnc/${platform}/${kind}/websockify?kato_viewer_ticket=${encodeURIComponent(ticket)}`;
  const query = new URLSearchParams({
    autoconnect: "1",
    resize: "scale",
    path: websocketPath,
    kato_viewer_ticket: ticket
  });
  return `/novnc/${platform}/${kind}/vnc.html?${query.toString()}`;
}

function noVncTarget(url: URL): { host: string; port: number; path: string } {
  const parts = url.pathname.split("/").filter(Boolean);
  const parsedPlatform = parts[0] === "novnc" ? parts[1] : "";
  const platform = (parsedPlatform === "douyin" || parsedPlatform === "bilibili" || parsedPlatform === "xhs" ? parsedPlatform : "xhs") as PlatformId;
  const maybeKind = platform === parsedPlatform ? parts[2] : "";
  const kind = normalizeRuntimeKind(maybeKind);
  const rest = platform === parsedPlatform ? (maybeKind === "viewer" || maybeKind === "worker" ? parts.slice(3) : parts.slice(2)) : parts.slice(1);
  return {
    host: defaultNoVncHost,
    port: noVncPortForPlatform(platform, kind),
    path: `/${rest.join("/") || ""}${url.search}`
  };
}

function createNoVncViewerTicket(platform: PlatformId, kind: RuntimeKind): string {
  cleanupNoVncViewerTickets();
  const ticket = randomUUID();
  noVncViewerTickets.set(ticket, { platform, kind, expiresAt: Date.now() + NO_VNC_VIEWER_TICKET_TTL_MS });
  return ticket;
}

function cleanupNoVncViewerTickets(): void {
  const now = Date.now();
  for (const [ticket, state] of noVncViewerTickets.entries()) {
    if (state.expiresAt <= now) noVncViewerTickets.delete(ticket);
  }
}

function isNoVncProtectedPath(url: URL): boolean {
  const pathname = url.pathname.toLowerCase();
  return pathname.endsWith("/vnc.html") || pathname.endsWith("/websockify");
}

function isAuthorizedNoVncRequest(req: IncomingMessage, url: URL): boolean {
  if (isAuthorizedRequest(req)) return true;
  cleanupNoVncViewerTickets();
  const ticket = url.searchParams.get("kato_viewer_ticket") || "";
  const state = noVncViewerTickets.get(ticket);
  if (!state) return false;
  if (state.expiresAt <= Date.now()) {
    noVncViewerTickets.delete(ticket);
    return false;
  }
  const target = platformAndKindFromNoVncUrl(url);
  return state.platform === target.platform && state.kind === target.kind;
}

function platformFromNoVncUrl(url: URL): PlatformId {
  return platformAndKindFromNoVncUrl(url).platform;
}

function platformAndKindFromNoVncUrl(url: URL): { platform: PlatformId; kind: RuntimeKind } {
  const parts = url.pathname.split("/").filter(Boolean);
  const parsedPlatform = parts[0] === "novnc" ? parts[1] : "";
  const platform = (parsedPlatform === "douyin" || parsedPlatform === "bilibili" || parsedPlatform === "xhs" ? parsedPlatform : "xhs") as PlatformId;
  return { platform, kind: normalizeRuntimeKind(platform === parsedPlatform ? parts[2] : undefined) };
}

function noVncPortForPlatform(platform: PlatformId, kind: RuntimeKind): number {
  if (platform === "douyin") {
    return kind === "worker" ? Number(process.env.DOUYIN_WORKER_NOVNC_PORT || 6091) : Number(process.env.DOUYIN_VIEWER_NOVNC_PORT || 6090);
  }
  if (platform === "bilibili") {
    return kind === "worker" ? Number(process.env.BILIBILI_WORKER_NOVNC_PORT || 6101) : Number(process.env.BILIBILI_VIEWER_NOVNC_PORT || 6100);
  }
  if (kind === "worker") return Number(process.env.XHS_WORKER_NOVNC_PORT || 6081);
  return Number(process.env.XHS_VIEWER_NOVNC_PORT || process.env.BROWSER_NOVNC_PORT || process.env.XHS_NOVNC_PORT || 6080);
}

function normalizeRuntimeKind(value: unknown): RuntimeKind {
  return String(value || "").trim().toLowerCase() === "worker" ? "worker" : "viewer";
}

function runtimeUrlForKind(platform: ReturnType<typeof getPlatformSpec>, kind: RuntimeKind): string {
  return kind === "worker" ? platform.workerRuntimeUrl || platform.viewerRuntimeUrl || defaultBrowserRuntimeUrl : platform.viewerRuntimeUrl || defaultBrowserRuntimeUrl;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}
