import type { IncomingMessage, ServerResponse } from "node:http";
import { createDouyinAdapter } from "../adapters/douyin.js";

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

const DEFAULT_API_TOKEN = "LiuTao0.1";
const FETCH_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_PUBLIC_FETCH_TIMEOUT_MS", 600_000);

export async function handlePublicDouyinApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!isPublicDouyinApiPath(url.pathname)) return false;

  const requestSignal = createRequestAbortSignal(req, res);
  try {
    assertAuthorized(req);
    const body = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
    const data = await routePublicDouyinApi(req, url, body, { signal: requestSignal });
    sendApiSuccess(res, data);
  } catch (error) {
    const apiError = normalizeApiError(error);
    sendApiError(res, apiError.status, { code: apiError.code, message: apiError.message });
  }
  return true;
}

export function isPublicDouyinApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/v1/douyin/");
}

async function routePublicDouyinApi(
  req: IncomingMessage,
  url: URL,
  body: Record<string, unknown>,
  options: RouteOptions
): Promise<unknown> {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/v1/douyin/health") {
    return fetchServiceJson(`/health${url.search || ""}`, {}, options.signal);
  }

  if (req.method === "GET" && path === "/api/v1/douyin/login/status") {
    return fetchServiceJson("/api/v1/login/status", {}, options.signal);
  }

  if (req.method === "GET" && path === "/api/v1/douyin/browser/logs") {
    return fetchServiceJson(`/api/v1/browser/logs${url.search || ""}`, {}, options.signal);
  }

  if (req.method === "POST" && path === "/api/v1/douyin/links/resolve") {
    return postServiceJson("/api/v1/links/resolve", body, options.signal);
  }

  if ((req.method === "GET" || req.method === "POST") && path === "/api/v1/douyin/posts/search") {
    const adapter = createDouyinAdapter();
    const keyword = String(body.keyword ?? body.query ?? "").trim();
    const limit = normalizeLimit(body.limit, 20);
    const posts = await adapter.searchPosts(keyword, limit, options);
    return { posts, items: posts, count: posts.length };
  }

  if (req.method === "POST" && path === "/api/v1/douyin/posts/detail") {
    const adapter = createDouyinAdapter();
    const post = await adapter.getPost(normalizePostInput(body), options);
    if (!post) throw new PublicApiError(404, "POST_NOT_FOUND", "Douyin post detail not found.");
    return { post, item: post, items: [post] };
  }

  if (req.method === "POST" && path === "/api/v1/douyin/posts/comments") {
    return postServiceJson("/api/v1/posts/comments", body, options.signal);
  }

  if (req.method === "POST" && path === "/api/v1/douyin/posts/comment_replies") {
    return postServiceJson("/api/v1/posts/comment_replies", body, options.signal);
  }

  throw new PublicApiError(404, "NOT_FOUND", "API endpoint not found.");
}

function normalizePostInput(body: Record<string, unknown>): string {
  const url = String(body.url ?? body.share_url ?? body.source_url ?? "").trim();
  if (url) return url;
  const id = String(body.aweme_id ?? body.awemeId ?? body.item_id ?? body.id ?? "").trim();
  if (!id) throw new PublicApiError(400, "POST_IDENTIFIER_REQUIRED", "aweme_id, id or url is required.");
  return id;
}

async function fetchServiceJson(endpoint: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchWithTimeout(new URL(endpoint, douyinServiceUrl()), init, FETCH_TIMEOUT_MS, signal);
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
    throw new PublicApiError(response.ok ? 502 : response.status, "UPSTREAM_ERROR", errorMessage(payload, `Douyin service ${endpoint} failed.`));
  }
  return unwrapData(payload);
}

function assertAuthorized(req: IncomingMessage): void {
  const expectedToken = process.env.XHS_API_TOKEN?.trim() || DEFAULT_API_TOKEN;
  const authorization = req.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!token || token !== expectedToken) {
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
  const timeout = setTimeout(() => controller.abort(new Error(`Douyin public request timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function sendApiSuccess(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { success: true, data });
}

function sendApiError(res: ServerResponse, status: number, error: { code: string; message: string }): void {
  sendJson(res, status, { success: false, error });
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

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function isFailure(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "success" in payload && (payload as { success?: unknown }).success === false);
}

function unwrapData(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload) return (payload as { data: unknown }).data;
  return payload;
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

function douyinServiceUrl(): string {
  return normalizeBaseUrl(process.env.DOUYIN_SERVICE_URL || "http://localhost:18070");
}

function normalizePositiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
