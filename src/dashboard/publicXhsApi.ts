import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { Note, ScoredPost, XhsPost } from "../domain/types.js";
import { createXhsAdapter } from "../adapters/xhsMcp.js";
import { listActiveNotes } from "../notes/importNotes.js";
import { syncMyXhsNotes } from "../notes/syncXhs.js";
import { generateInteractionDraft } from "../runs/commentProvider.js";
import { DEFAULT_KEYWORDS, parseKeywordArg } from "../runs/keywords.js";
import { scorePost } from "../runs/scorer.js";
import { searchOnlyPosts } from "../runs/searchOnly.js";

interface PublicXhsApiContext {
  config: AppConfig;
  db: Db;
}

interface ApiErrorPayload {
  code: string;
  message: string;
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

const idempotencyResults = new Map<string, Promise<unknown>>();

export async function handlePublicXhsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: PublicXhsApiContext
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/xhs/")) return false;

  try {
    assertAuthorized(req);
    const body = req.method === "POST" ? await readJson(req) : {};
    const data = await routePublicXhsApi(req, url, body, context);
    sendApiSuccess(res, data);
  } catch (error) {
    const apiError = normalizeApiError(error);
    sendApiError(res, apiError.status, { code: apiError.code, message: apiError.message });
  }
  return true;
}

async function routePublicXhsApi(
  req: IncomingMessage,
  url: URL,
  body: Record<string, unknown>,
  context: PublicXhsApiContext
): Promise<unknown> {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/v1/xhs/health") {
    return getPublicHealth(context.config);
  }

  if (req.method === "GET" && path === "/api/v1/xhs/auth/status") {
    return fetchMcpJson(context.config, "/api/v1/login/status");
  }

  if (req.method === "POST" && path === "/api/v1/xhs/posts/search") {
    const keywords = normalizeKeywords(body);
    const limit = normalizeLimit(body.limit, 20);
    return searchOnlyPosts(context.config, { keywords, limit });
  }

  if (req.method === "POST" && path === "/api/v1/xhs/posts/detail") {
    return getPostDetail(context.config, body);
  }

  if (req.method === "POST" && path === "/api/v1/xhs/notes/sync") {
    const result = await syncMyXhsNotes(context.db, context.config, { limit: normalizeLimit(body.limit, 30) });
    return result;
  }

  if (req.method === "POST" && path === "/api/v1/xhs/comments/draft") {
    return draftComment(context.db, body);
  }

  if (req.method === "POST" && path === "/api/v1/xhs/comments/publish") {
    assertConfirmed(body);
    const idempotencyKey = requireIdempotencyKey(body);
    return runIdempotent(`publish:${idempotencyKey}`, () => publishComment(context.config, body));
  }

  if (req.method === "POST" && path === "/api/v1/xhs/posts/like") {
    assertConfirmed(body);
    const idempotencyKey = requireIdempotencyKey(body);
    return runIdempotent(`like:${idempotencyKey}`, () => likePost(context.config, body));
  }

  throw new PublicApiError(404, "NOT_FOUND", "API endpoint not found.");
}

async function getPublicHealth(config: AppConfig): Promise<Record<string, unknown>> {
  const mcpHealth = await fetchMcpJson(config, "/health").catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  const authStatus = await fetchMcpJson(config, "/api/v1/login/status").catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  return {
    service: "kato",
    status: "ok",
    mcp: mcpHealth,
    auth: authStatus
  };
}

async function getPostDetail(config: AppConfig, body: Record<string, unknown>): Promise<XhsPost> {
  const adapter = createXhsAdapter(config);
  try {
    const input = normalizePostInput(body);
    const detail = await adapter.getPost(input);
    if (!detail) throw new PublicApiError(404, "POST_NOT_FOUND", "Post detail not found.");
    return detail;
  } finally {
    await adapter.close?.();
  }
}

async function draftComment(db: Db, body: Record<string, unknown>): Promise<{ post: ScoredPost; note: Note | null; comment: string; rationale: string }> {
  const post = scorePost(normalizePostInput(body), normalizeKeywords(body));
  const notes = listActiveNotes(db);
  const draft = await generateInteractionDraft(post, notes);
  return { post, ...draft };
}

async function publishComment(config: AppConfig, body: Record<string, unknown>): Promise<{ published: true; post: XhsPost }> {
  const post = normalizePostInput(body);
  const content = String(body.content ?? body.comment ?? "").trim();
  if (!content) throw new PublicApiError(400, "CONTENT_REQUIRED", "content is required.");
  if (!post.xsecToken) throw new PublicApiError(400, "XSEC_TOKEN_REQUIRED", "post.xsecToken is required.");
  const adapter = createXhsAdapter(config);
  try {
    await adapter.publishComment(post, content);
    return { published: true, post };
  } finally {
    await adapter.close?.();
  }
}

async function likePost(config: AppConfig, body: Record<string, unknown>): Promise<{ liked: boolean; post: XhsPost }> {
  const post = normalizePostInput(body);
  if (!post.xsecToken) throw new PublicApiError(400, "XSEC_TOKEN_REQUIRED", "post.xsecToken is required.");
  const adapter = createXhsAdapter(config);
  try {
    const liked = adapter.likePost ? await adapter.likePost(post) : false;
    return { liked, post };
  } finally {
    await adapter.close?.();
  }
}

function assertAuthorized(req: IncomingMessage): void {
  const expectedToken = process.env.XHS_API_TOKEN?.trim();
  const actualToken = getRequestToken(req);
  if (!actualToken) throw new PublicApiError(401, "UNAUTHORIZED", "Missing API token.");
  if (!expectedToken) throw new PublicApiError(503, "API_TOKEN_NOT_CONFIGURED", "XHS_API_TOKEN is not configured.");
  if (actualToken !== expectedToken) throw new PublicApiError(403, "FORBIDDEN", "Invalid API token.");
}

function getRequestToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice("bearer ".length).trim();
  }
  const apiKey = req.headers["x-api-key"];
  return Array.isArray(apiKey) ? String(apiKey[0] ?? "").trim() : String(apiKey ?? "").trim();
}

function normalizeKeywords(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.keywords)) return body.keywords.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof body.keywords === "string") return parseKeywordArg(body.keywords);
  if (typeof body.keyword === "string" && body.keyword.trim()) return [body.keyword.trim()];
  return DEFAULT_KEYWORDS.slice(0, 1);
}

function normalizeLimit(value: unknown, fallback: number): number {
  const numberValue = Number(value ?? fallback);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(numberValue)));
}

function normalizePostInput(body: Record<string, unknown>): XhsPost {
  const raw = (body.post && typeof body.post === "object" ? body.post : body) as Record<string, unknown>;
  const id = String(raw.id ?? raw.feedId ?? raw.feed_id ?? "").trim();
  const url = String(raw.url ?? "").trim();
  if (!id && !url) throw new PublicApiError(400, "POST_IDENTIFIER_REQUIRED", "post.id or post.url is required.");
  return {
    id: id || url,
    url: url || buildXhsUrl(id, raw.xsecToken ?? raw.xsec_token),
    title: String(raw.title ?? ""),
    snippet: String(raw.snippet ?? raw.desc ?? raw.description ?? ""),
    author: optionalString(raw.author),
    xsecToken: optionalString(raw.xsecToken ?? raw.xsec_token),
    likeCount: optionalNumber(raw.likeCount ?? raw.like_count),
    commentCount: optionalNumber(raw.commentCount ?? raw.comment_count),
    publishedAt: optionalString(raw.publishedAt ?? raw.published_at)
  };
}

function buildXhsUrl(id: string, rawToken: unknown): string {
  const url = new URL(`https://www.xiaohongshu.com/explore/${encodeURIComponent(id || "unknown")}`);
  const token = optionalString(rawToken);
  if (token) url.searchParams.set("xsec_token", token);
  return url.toString();
}

function assertConfirmed(body: Record<string, unknown>): void {
  if (body.confirm !== true) throw new PublicApiError(400, "CONFIRM_REQUIRED", "confirm:true is required.");
}

function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = String(body.idempotencyKey ?? "").trim();
  if (!key) throw new PublicApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.");
  return key;
}

async function runIdempotent(key: string, task: () => Promise<unknown>): Promise<unknown> {
  const existing = idempotencyResults.get(key);
  if (existing) return existing;
  const promise = task();
  idempotencyResults.set(key, promise);
  return promise;
}

async function fetchMcpJson(config: AppConfig, endpoint: string): Promise<unknown> {
  const base = config.xhs.mcp?.url ? new URL(config.xhs.mcp.url).origin : "http://localhost:18060";
  const response = await fetch(`${base}${endpoint}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new PublicApiError(502, "MCP_ERROR", `MCP ${endpoint} failed: HTTP ${response.status}`);
  return data;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendApiSuccess(res: ServerResponse, data: unknown): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ success: true, data }));
}

function sendApiError(res: ServerResponse, status: number, error: ApiErrorPayload): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ success: false, error }));
}

function normalizeApiError(error: unknown): PublicApiError {
  if (error instanceof PublicApiError) return error;
  if (error instanceof SyntaxError) return new PublicApiError(400, "INVALID_JSON", "Invalid JSON body.");
  return new PublicApiError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}

function optionalString(value: unknown): string | undefined {
  const stringValue = String(value ?? "").trim();
  return stringValue || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}
