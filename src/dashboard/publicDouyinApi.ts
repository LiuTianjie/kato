import type { IncomingMessage, ServerResponse } from "node:http";
import { createDouyinAdapter } from "../adapters/douyin.js";
import { getRequestApiToken, isValidApiToken } from "./apiAuth.js";
import { captureRawPayload } from "../diagnostics/rawCapture.js";

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

const FETCH_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_PUBLIC_FETCH_TIMEOUT_MS", 600_000);

export async function handlePublicDouyinApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!isPublicDouyinApiPath(url.pathname)) return false;

  const requestSignal = createRequestAbortSignal(req, res);
  const serverxShape = isServerxDouyinApiPath(url.pathname);
  try {
    assertAuthorized(req);
    const body = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
    const data = await routePublicDouyinApi(req, url, body, { signal: requestSignal });
    if (serverxShape) sendServerxSuccess(res, data);
    else sendApiSuccess(res, data);
  } catch (error) {
    const apiError = normalizeApiError(error);
    if (serverxShape) sendServerxError(res, apiError);
    else sendApiError(res, apiError.status, { code: apiError.code, message: apiError.message });
  }
  return true;
}

export function isPublicDouyinApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/v1/douyin/") || isServerxDouyinApiPath(pathname);
}

function isServerxDouyinApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/douyin/web/");
}

async function routePublicDouyinApi(
  req: IncomingMessage,
  url: URL,
  body: Record<string, unknown>,
  options: RouteOptions
): Promise<unknown> {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/douyin/web/search_videos") {
    const keyword = String(body.keyword ?? body.query ?? body.keyword_query ?? "").trim();
    const limit = normalizeLimit(body.count ?? body.limit ?? body.page_size ?? body.ps, 20);
    const page = normalizePositiveInt(body.page ?? body.pn, 1);
    const cursor = normalizeNonNegativeInt(body.cursor, (page - 1) * limit);
    const payload = await postServiceJson(
      "/api/v1/posts/search",
      { keyword, limit, page, cursor, sort_label: body.sort_label, sort_type: body.sort_type, publish_time: body.publish_time },
      options.signal
    );
    const posts = sortByCreateTimeDesc(extractList(payload, ["posts", "items", "data"]).map(toServerxDouyinVideo));
    if (posts.length === 0 && hasUpstreamContent(payload)) {
      await captureRawPayload({
        platform: "douyin",
        kind: "search",
        reason: "empty-result",
        request: { keyword, limit, page, cursor },
        payload
      });
    }
    return {
      videos: posts,
      cursor: String(cursor + limit),
      has_more: posts.length >= limit
    };
  }

  if (req.method === "GET" && path === "/api/douyin/web/get_aweme_id") {
    const input = String(body.url ?? body.share_url ?? body.text ?? body.aweme_id ?? body.id ?? "").trim();
    const payload = await postServiceJson("/api/v1/links/resolve", { url: input, text: input }, options.signal);
    const data = asRecord(payload);
    return data.aweme_id ?? data.awemeId ?? data.id ?? input;
  }

  if (req.method === "GET" && path === "/api/douyin/web/fetch_one_video") {
    const payload = await postServiceJson("/api/v1/posts/detail", normalizeDouyinVideoRequest(body), options.signal);
    const post = extractList(payload, ["items", "posts", "data"])[0] ?? asRecord(payload).post ?? asRecord(payload).item ?? payload;
    const detail = toServerxDouyinVideo(post);
    if (!detail.aweme_id && hasUpstreamContent(payload)) {
      await captureRawPayload({
        platform: "douyin",
        kind: "detail",
        reason: "empty-result",
        request: normalizeDouyinVideoRequest(body),
        payload
      });
    }
    return { aweme_detail: detail };
  }

  if (req.method === "GET" && path === "/api/douyin/web/fetch_video_comments") {
    const limit = normalizeLimit(body.count ?? body.limit ?? body.page_size ?? body.ps, 20);
    const payload = await postServiceJson(
      "/api/v1/posts/comments",
      { ...normalizeDouyinVideoRequest(body), limit, cursor: body.cursor ?? 0, sort_label: body.sort_label },
      options.signal
    );
    const data = asRecord(payload);
    const comments = sortByCreateTimeDesc(extractList(payload, ["comments", "items", "data"]).map((comment) => toServerxDouyinComment(comment)));
    if (comments.length === 0 && hasUpstreamContent(payload)) {
      await captureRawPayload({
        platform: "douyin",
        kind: "comments",
        reason: "empty-result",
        request: { ...normalizeDouyinVideoRequest(body), limit, cursor: body.cursor ?? 0 },
        payload
      });
    }
    return {
      comments,
      cursor: String(data.cursor ?? ""),
      has_more: Boolean(data.has_more ?? data.hasMore ?? comments.length >= limit)
    };
  }

  if (req.method === "GET" && path === "/api/douyin/web/fetch_video_comment_replies") {
    const limit = normalizeLimit(body.count ?? body.limit ?? body.page_size ?? body.ps, 20);
    const commentId = String(body.comment_id ?? body.commentId ?? body.cid ?? body.root ?? "").trim();
    const payload = await postServiceJson(
      "/api/v1/posts/comment_replies",
      { ...normalizeDouyinVideoRequest(body), comment_id: commentId, limit, cursor: body.cursor ?? 0, sort_label: body.sort_label },
      options.signal
    );
    const data = asRecord(payload);
    const comments = sortByCreateTimeDesc(extractList(payload, ["comments", "items", "data"]).map((comment) => toServerxDouyinComment(comment, commentId)));
    if (comments.length === 0 && hasUpstreamContent(payload)) {
      await captureRawPayload({
        platform: "douyin",
        kind: "comment_replies",
        reason: "empty-result",
        request: { ...normalizeDouyinVideoRequest(body), comment_id: commentId, limit, cursor: body.cursor ?? 0 },
        payload
      });
    }
    return {
      comments,
      cursor: String(data.cursor ?? ""),
      has_more: Boolean(data.has_more ?? data.hasMore ?? comments.length >= limit)
    };
  }

  if (req.method === "POST" && path === "/api/douyin/web/update_cookie") {
    await postServiceJson("/api/v1/browser/update-cookie", body, options.signal);
    return { message: "Cookie for douyin updated successfully" };
  }

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

function normalizeDouyinVideoRequest(body: Record<string, unknown>): Record<string, unknown> {
  const url = String(body.url ?? body.share_url ?? body.source_url ?? body.text ?? "").trim();
  const id = String(body.aweme_id ?? body.awemeId ?? body.item_id ?? body.id ?? "").trim();
  return {
    ...body,
    ...(url ? { url } : {}),
    ...(id ? { aweme_id: id, id } : {})
  };
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
    const serviceError = asRecord(asRecord(payload).error);
    const code = String(serviceError.code ?? "UPSTREAM_ERROR");
    throw new PublicApiError(response.ok ? 502 : response.status, code, errorMessage(payload, `Douyin service ${endpoint} failed.`));
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
  sendJson(res, 200, {
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

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return Math.max(0, fallback);
  return Math.floor(parsed);
}

function isFailure(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "success" in payload && (payload as { success?: unknown }).success === false);
}

function unwrapData(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload) return (payload as { data: unknown }).data;
  return payload;
}

function extractList(value: unknown, keys: string[]): unknown[] {
  const raw = unwrapData(value);
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const key of keys) {
    const child = (raw as Record<string, unknown>)[key];
    const unwrapped = unwrapData(child);
    if (Array.isArray(child)) return child;
    if (Array.isArray(unwrapped)) return unwrapped;
  }
  return [];
}

function toServerxDouyinVideo(value: unknown): Record<string, unknown> {
  const item = asRecord(value);
  const raw = asRecord(item.raw ?? item.raw_data ?? item);
  const id = stringValue(item.aweme_id ?? item.awemeId ?? item.id ?? raw.aweme_id ?? raw.id);
  const title = stringValue(item.desc ?? item.item_title ?? item.title ?? item.snippet ?? raw.desc ?? raw.title);
  const author = asRecord(item.author ?? raw.author ?? raw.user);
  const statistics = asRecord(item.statistics ?? raw.statistics);
  const shareUrl = normalizeDouyinVideoUrl(stringValue(item.share_url ?? item.url ?? raw.share_url ?? raw.url), id);
  return {
    aweme_id: id,
    id,
    desc: title,
    item_title: title,
    title,
    share_url: shareUrl,
    url: shareUrl,
    author: {
      uid: stringValue(author.uid ?? author.id),
      sec_uid: stringValue(author.sec_uid ?? author.secUid),
      short_id: stringValue(author.short_id ?? author.shortId ?? author.unique_id),
      nickname: stringValue(author.nickname ?? author.name ?? item.author),
      name: stringValue(author.nickname ?? author.name ?? item.author)
    },
    statistics: {
      digg_count: numberValue(statistics.digg_count ?? item.likeCount ?? raw.like_count),
      comment_count: numberValue(statistics.comment_count ?? item.commentCount),
      share_count: numberValue(statistics.share_count),
      collect_count: numberValue(statistics.collect_count)
    },
    create_time: secondsValue(raw.create_time ?? item.create_time ?? item.publishedAt),
    cover_url: stringValue(raw.cover_url ?? firstCoverUrl(raw.cover)),
    raw_data: raw
  };
}

function toServerxDouyinComment(value: unknown, parentId = ""): Record<string, unknown> {
  const item = asRecord(value);
  const raw = asRecord(item.raw ?? item);
  const user = asRecord(item.user ?? raw.user ?? raw.user_info);
  const id = stringValue(item.cid ?? item.comment_id ?? item.id ?? raw.cid ?? raw.comment_id);
  const text = stringValue(item.text ?? item.content ?? item.message ?? raw.text ?? raw.content);
  const replyId = stringValue(item.reply_id ?? item.reply_to_reply_id ?? item.parent_id ?? item.parentId ?? raw.reply_id ?? raw.parent_id ?? parentId);
  return {
    cid: id,
    comment_id: id,
    id,
    text,
    content: text,
    message: text,
    user: {
      uid: stringValue(user.uid ?? user.id),
      sec_uid: stringValue(user.sec_uid ?? user.secUid),
      short_id: stringValue(user.short_id ?? user.shortId ?? user.unique_id),
      nickname: stringValue(user.nickname ?? user.name ?? item.author),
      name: stringValue(user.nickname ?? user.name ?? item.author)
    },
    digg_count: numberValue(raw.digg_count ?? raw.like_count),
    reply_id: replyId,
    reply_to_reply_id: replyId,
    parent_id: replyId,
    reply_comment_total: numberValue(raw.reply_comment_total ?? raw.reply_count),
    create_time: secondsValue(raw.create_time ?? item.create_time)
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * 判断上游 payload 是否"确实带了内容、却被归一化成空"——用于区分
 * 真·空结果(没有评论的视频)和解析失配(平台改版导致字段路径失效)。
 * 只有后者才值得落盘做诊断/兜底。
 */
function hasUpstreamContent(payload: unknown): boolean {
  const data = unwrapData(payload);
  if (Array.isArray(data)) return data.length > 0;
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  for (const key of ["posts", "items", "data", "comments", "aweme_list", "aweme_detail", "post", "item"]) {
    const child = record[key];
    if (Array.isArray(child) && child.length > 0) return true;
    if (child && typeof child === "object" && Object.keys(child).length > 0) return true;
  }
  // 顶层就是单个对象且字段较多,也算有内容
  return Object.keys(record).length > 3;
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function secondsValue(value: unknown): number {
  if (typeof value === "string" && /\d{4}-\d{2}-\d{2}T/.test(value)) return Math.floor(Date.parse(value) / 1000);
  return numberValue(value);
}

function sortByCreateTimeDesc<T extends Record<string, unknown>>(items: T[]): T[] {
  return items.sort((left, right) => secondsValue(right.create_time) - secondsValue(left.create_time));
}

function normalizeDouyinVideoUrl(value: string, id: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(www\.)?douyin\.com(\/|$)/i.test(value)) return `https://${value}`;
  return id ? `https://www.douyin.com/video/${encodeURIComponent(id)}` : value;
}

function firstCoverUrl(value: unknown): string {
  const cover = asRecord(value);
  const list = cover.url_list;
  return Array.isArray(list) ? stringValue(list[0]) : "";
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
