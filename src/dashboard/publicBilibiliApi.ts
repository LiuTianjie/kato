import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestApiToken, isValidApiToken } from "./apiAuth.js";

interface RouteOptions {
  signal?: AbortSignal;
}

class PublicApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PublicApiError";
  }
}

class PublicRequestCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicRequestCancelledError";
  }
}

const FETCH_TIMEOUT_MS = normalizePositiveEnv("BILIBILI_PUBLIC_FETCH_TIMEOUT_MS", 600_000);

export async function handlePublicBilibiliApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!isPublicBilibiliApiPath(url.pathname)) return false;

  const requestSignal = createRequestAbortSignal(req, res);
  try {
    assertAuthorized(req);
    const body = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
    const data = await routePublicBilibiliApi(req, url, body, { signal: requestSignal });
    sendServerxSuccess(res, data);
  } catch (error) {
    sendServerxError(res, normalizeApiError(error));
  }
  return true;
}

export function isPublicBilibiliApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/bilibili/web/");
}

async function routePublicBilibiliApi(
  req: IncomingMessage,
  url: URL,
  body: Record<string, unknown>,
  options: RouteOptions
): Promise<unknown> {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/bilibili/web/search_videos") {
    return fetchServiceJson(`/api/v1/videos/search${queryString(body, {
      keyword: body.keyword ?? body.query,
      pn: body.pn ?? body.page,
      ps: body.ps ?? body.page_size ?? body.limit,
      order: body.order ?? orderFromSortLabel(body.sort_label, "totalrank")
    })}`, {}, options.signal);
  }

  if (req.method === "GET" && path === "/api/bilibili/web/fetch_one_video") {
    return fetchServiceJson(`/api/v1/videos/detail${queryString(body, normalizeBilibiliVideoRequest(body))}`, {}, options.signal);
  }

  if (req.method === "GET" && path === "/api/bilibili/web/fetch_video_comments") {
    return fetchServiceJson(`/api/v1/videos/comments${queryString(body, {
      ...normalizeBilibiliVideoRequest(body),
      pn: body.pn ?? body.page ?? body.num,
      ps: body.ps ?? body.page_size ?? body.limit ?? body.size,
      order: body.order ?? orderFromSortLabel(body.sort_label, "hot")
    })}`, {}, options.signal);
  }

  if (req.method === "GET" && path === "/api/bilibili/web/fetch_comment_reply") {
    return fetchServiceJson(`/api/v1/videos/comment_replies${queryString(body, {
      ...normalizeBilibiliVideoRequest(body),
      root: body.root ?? body.root_id ?? body.rpid ?? body.comment_id,
      pn: body.pn ?? body.page ?? body.num,
      ps: body.ps ?? body.page_size ?? body.limit ?? body.size,
      order: body.order ?? orderFromSortLabel(body.sort_label, "hot")
    })}`, {}, options.signal);
  }

  if (req.method === "POST" && path === "/api/bilibili/web/update_cookie") {
    await postServiceJson("/api/v1/browser/update-cookie", body, options.signal);
    return { message: "Cookie for bilibili updated successfully" };
  }

  throw new PublicApiError(404, "NOT_FOUND", "API endpoint not found.");
}

function normalizeBilibiliVideoRequest(body: Record<string, unknown>): Record<string, unknown> {
  return {
    bvid: body.bvid ?? body.bv_id ?? body.bvId,
    aid: body.aid ?? body.oid ?? body.id,
    url: body.url
  };
}

function queryString(source: Record<string, unknown>, fields: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const merged = { ...source, ...fields };
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function orderFromSortLabel(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "latest") return fallback === "totalrank" ? "pubdate" : "time";
  if (normalized === "hot") return fallback === "totalrank" ? "click" : "hot";
  return fallback;
}

async function fetchServiceJson(endpoint: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchWithTimeout(new URL(endpoint, bilibiliServiceUrl()), init, FETCH_TIMEOUT_MS, signal);
  return parseServiceResponse(response, endpoint);
}

async function postServiceJson(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return fetchServiceJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, signal);
}

async function parseServiceResponse(response: Response, endpoint: string): Promise<unknown> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || isFailure(payload)) {
    const status = response.status === 401 ? 401 : response.ok ? 502 : response.status;
    throw new PublicApiError(status, errorCode(payload, status), errorMessage(payload, `Bilibili service ${endpoint} failed.`));
  }
  return unwrapData(payload);
}

function assertAuthorized(req: IncomingMessage): void {
  const token = getRequestApiToken(req);
  if (!token || !isValidApiToken(token)) {
    throw new PublicApiError(401, "UNAUTHORIZED", "Missing or invalid API token.");
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function createRequestAbortSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new PublicRequestCancelledError("Client disconnected before the request completed."));
  };
  req.on("aborted", abort);
  res.on("close", () => {
    if (!res.writableEnded) abort();
  });
  return controller.signal;
}

async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason ?? new PublicRequestCancelledError("Request was cancelled."));
  };
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`Bilibili public request timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function sendServerxSuccess(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { code: 200, message: "success", data });
}

function sendServerxError(res: ServerResponse, error: PublicApiError): void {
  const code =
    error.code === "CHALLENGE_REQUIRED"
      ? 40102
      : error.status === 401 || error.status === 403
        ? 40101
        : error.status === 400
          ? 40001
          : 50001;
  sendJson(res, error.status >= 400 && error.status < 600 ? error.status : 500, {
    code,
    message: error.message,
    data: null
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function normalizeApiError(error: unknown): PublicApiError {
  if (error instanceof PublicApiError) return error;
  if (error instanceof PublicRequestCancelledError) return new PublicApiError(499, "CLIENT_CLOSED_REQUEST", error.message);
  return new PublicApiError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}

function isFailure(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "success" in payload && (payload as { success?: unknown }).success === false);
}

function unwrapData(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload) return (payload as { data: unknown }).data;
  return payload;
}

function errorCode(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.trim()) return code;
    }
  }
  return status === 401 ? "COOKIE_EXPIRED" : "UPSTREAM_ERROR";
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown; message?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
}

function bilibiliServiceUrl(): string {
  return normalizeBaseUrl(process.env.BILIBILI_SERVICE_URL || "http://localhost:18080");
}

function normalizePositiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
