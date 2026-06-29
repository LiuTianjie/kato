import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { Note, ScoredPost, XhsComment, XhsPost } from "../domain/types.js";
import { createXhsAdapter } from "../adapters/xhsMcp.js";
import { listActiveNotes } from "../notes/importNotes.js";
import { syncMyXhsNotes } from "../notes/syncXhs.js";
import { generateInteractionDraft } from "../runs/commentProvider.js";
import { DEFAULT_KEYWORDS, parseKeywordArg } from "../runs/keywords.js";
import { scorePost } from "../runs/scorer.js";
import { searchOnlyPosts } from "../runs/searchOnly.js";
import { getRequestApiToken, isValidApiToken } from "./apiAuth.js";

interface PublicXhsApiContext {
  config: AppConfig;
  db: Db;
}

interface ApiErrorPayload {
  code: string;
  message: string;
}

interface RouteOptions {
  signal?: AbortSignal;
  cursor?: string;
  index?: number;
  pageArea?: string;
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

class PublicFetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicFetchTimeoutError";
  }
}

const IDEMPOTENCY_RESULT_TTL_MS = normalizePositiveEnv("XHS_PUBLIC_IDEMPOTENCY_RESULT_TTL_MS", 10 * 60_000);
const idempotencyResults = new Map<string, { promise: Promise<unknown>; timer?: ReturnType<typeof setTimeout> }>();
const MCP_FETCH_TIMEOUT_MS = normalizePositiveEnv("XHS_PUBLIC_MCP_FETCH_TIMEOUT_MS", 600_000);

export async function handlePublicXhsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: PublicXhsApiContext
): Promise<boolean> {
  if (!isPublicXhsApiPath(url.pathname)) return false;

  const requestSignal = createRequestAbortSignal(req, res);
  try {
    assertAuthorized(req);
    const body = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
    const data = await routePublicXhsApi(req, url, body, context, { signal: requestSignal });
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
  context: PublicXhsApiContext,
  options: RouteOptions = {}
): Promise<unknown> {
  const path = url.pathname;
  const serverxPath = normalizeServerxPath(path);
  const tikhubPath = normalizeTikHubPath(path);

  if (req.method === "GET" && tikhubPath === "/search_notes") {
    return searchNotesForTikHub(context.config, body, options);
  }

  if (req.method === "GET" && (tikhubPath === "/get_image_note_detail" || tikhubPath === "/get_video_note_detail")) {
    return noteDetailForTikHub(context.config, body, options);
  }

  if (req.method === "GET" && tikhubPath === "/get_note_comments") {
    return noteCommentsForTikHub(context.config, body, options);
  }

  if (req.method === "GET" && tikhubPath === "/get_note_sub_comments") {
    return noteSubCommentsForTikHub(context.config, body, options);
  }

  if (req.method === "POST" && serverxPath === "/search_notes") {
    return searchNotesForServerx(context.config, body, options);
  }

  if (req.method === "POST" && serverxPath === "/note_detail") {
    return noteDetailForServerx(context.config, body, options);
  }

  if (req.method === "POST" && serverxPath === "/note_comments") {
    return noteCommentsForServerx(context.config, body, options);
  }

  if (req.method === "POST" && serverxPath === "/note_sub_comments") {
    return noteSubCommentsForServerx(context.config, body, options);
  }

  if (req.method === "GET" && path === "/api/v1/xhs/health") {
    return getPublicHealth(context.config, options);
  }

  if (req.method === "GET" && path === "/api/v1/xhs/auth/status") {
    return fetchMcpJson(context.config, "/api/v1/login/status", options.signal);
  }

  if (req.method === "POST" && path === "/api/v1/xhs/posts/search") {
    const keywords = normalizeKeywords(body);
    const limit = normalizeLimit(body.limit, 20);
    return searchOnlyPosts(context.config, { keywords, limit, signal: options.signal });
  }

  if (req.method === "POST" && path === "/api/v1/xhs/posts/detail") {
    return getPostDetail(context.config, body, options);
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
    return runIdempotent(`publish:${idempotencyKey}`, () => publishComment(context.config, body, options));
  }

  if (req.method === "POST" && path === "/api/v1/xhs/posts/like") {
    assertConfirmed(body);
    const idempotencyKey = requireIdempotencyKey(body);
    return runIdempotent(`like:${idempotencyKey}`, () => likePost(context.config, body, options));
  }

  throw new PublicApiError(404, "NOT_FOUND", "API endpoint not found.");
}

export function isPublicXhsApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/v1/xhs/") || pathname.startsWith(`${TIKHUB_PREFIX}/`) || SERVERX_ROOT_PATHS.has(pathname);
}

const SERVERX_ROOT_PATHS = new Set(["/search_notes", "/note_detail", "/note_comments", "/note_sub_comments"]);
const TIKHUB_PREFIX = "/api/v1/xiaohongshu/app_v2";

function normalizeServerxPath(pathname: string): string {
  if (SERVERX_ROOT_PATHS.has(pathname)) return pathname;
  const prefix = "/api/v1/xhs/serverx";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return "";
}

function normalizeTikHubPath(pathname: string): string {
  if (pathname.startsWith(`${TIKHUB_PREFIX}/`)) return pathname.slice(TIKHUB_PREFIX.length);
  return "";
}

async function getPublicHealth(config: AppConfig, options: RouteOptions = {}): Promise<Record<string, unknown>> {
  const mcpHealth = await fetchMcpJson(config, "/health", options.signal).catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  const authStatus = await fetchMcpJson(config, "/api/v1/login/status", options.signal).catch((error) => ({
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

async function getPostDetail(config: AppConfig, body: Record<string, unknown>, options: RouteOptions = {}): Promise<XhsPost> {
  const adapter = createXhsAdapter(config);
  try {
    const input = normalizePostInput(body);
    const detail = await adapter.getPost(input, { signal: options.signal });
    if (!detail) throw new PublicApiError(404, "POST_NOT_FOUND", "Post detail not found.");
    return detail;
  } finally {
    await adapter.close?.();
  }
}

async function searchNotesForServerx(
  config: AppConfig,
  body: Record<string, unknown>,
  options: RouteOptions = {}
): Promise<Record<string, unknown>[]> {
  const keyword = String(body.keyword ?? body.query ?? "").trim();
  const limit = normalizeLimit(body.limit, 20);
  const posts = await searchFilteredPosts(config, keyword ? [keyword] : normalizeKeywords(body), limit, body, options);
  const includeComments = parseBooleanFlag(body.include_comments ?? body.includeComments, true);
  const commentLimit = includeComments ? normalizeOptionalLimit(body.max_comments ?? body.maxComments, 20) : 0;
  return Promise.all(
    posts.slice(0, limit).map(async (post) => {
      const comments = commentLimit > 0 ? await safeGetComments(config, post, commentLimit, options) : [];
      return toServerxPost(post, comments);
    })
  );
}

async function searchNotesForTikHub(
  config: AppConfig,
  body: Record<string, unknown>,
  options: RouteOptions = {}
): Promise<Record<string, unknown>> {
  const page = normalizePositiveInt(body.page, 1);
  const pageSize = normalizeLimit(body.limit ?? body.page_size ?? body.pageSize, 20);
  const keyword = String(body.keyword ?? body.query ?? "").trim();
  const posts = (await searchFilteredPosts(config, keyword ? [keyword] : normalizeKeywords(body), pageSize, body, {
    ...options,
    index: page - 1
  })).map((post) => toServerxPost(post));
  return {
    data: posts,
    items: posts,
    notes: posts,
    cursor: {
      page: page + 1,
      search_id: String(body.search_id ?? ""),
      search_session_id: String(body.search_session_id ?? "")
    },
    has_more: posts.length >= pageSize,
    page,
    page_size: pageSize,
    sort_type: body.sort_type ?? "general",
    note_type: body.note_type ?? "不限",
    time_filter: body.time_filter ?? "不限"
  };
}

async function searchFilteredPosts(
  config: AppConfig,
  keywords: string[],
  limit: number,
  body: Record<string, unknown>,
  options: RouteOptions = {}
): Promise<XhsPost[]> {
  const adapter = createXhsAdapter(config);
  const posts: XhsPost[] = [];
  const seen = new Set<string>();
  try {
    for (const keyword of keywords) {
      if (posts.length >= limit) break;
      const results = await adapter.searchPosts(keyword, Math.max(limit - posts.length, 1), {
        signal: options.signal,
        index: options.index,
        sortType: normalizeText(body.sort_type ?? body.sortType ?? body.sort_label ?? body.sortLabel, "time_descending"),
        noteType: normalizeText(body.note_type ?? body.noteType, "不限"),
        timeFilter: normalizeText(body.time_filter ?? body.timeFilter, "不限"),
        pageSize: normalizeLimit(body.page_size ?? body.pageSize ?? body.limit, limit),
        searchId: normalizeText(body.search_id ?? body.searchId, "")
      });
      for (const post of results) {
        const key = post.id || post.url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        posts.push(post);
        if (posts.length >= limit) break;
      }
    }
  } finally {
    await adapter.close?.();
  }
  return posts;
}

async function noteDetailForServerx(
  config: AppConfig,
  body: Record<string, unknown>,
  options: RouteOptions = {}
): Promise<Record<string, unknown>> {
  const post = await getPostDetail(config, normalizeServerxPostInput(body), options);
  const includeComments = parseBooleanFlag(body.include_comments ?? body.includeComments, true);
  const commentLimit = includeComments ? normalizeOptionalLimit(body.max_comments ?? body.maxComments, 50) : 0;
  const comments = commentLimit > 0 ? await safeGetComments(config, post, commentLimit, options) : [];
  return toServerxPost(post, comments);
}

async function noteDetailForTikHub(
  config: AppConfig,
  body: Record<string, unknown>,
  options: RouteOptions = {}
): Promise<Record<string, unknown>> {
  return noteDetailForServerx(config, body, options);
}

async function noteCommentsForServerx(
  config: AppConfig,
  body: Record<string, unknown>,
  options: RouteOptions = {}
): Promise<Record<string, unknown>> {
  const page = normalizeCursorPage(body.index, body.cursor, 0);
  const pageSize = normalizeLimit(body.max_comments ?? body.limit, 50);
  const pageArea = String(body.pageArea ?? body.page_area ?? "UNFOLDED");
  const post = normalizePostInput(normalizeServerxPostInput(body));
  const comments = await getCommentsStrict(config, post, pageSize, {
    ...options,
    cursor: String(body.cursor ?? ""),
    index: page,
    pageArea
  });
  const items = dedupeXhsComments(comments).map(toServerxComment);
  const nextIndex = page + 1;
  const nextCursor = items.length ? `offset:${nextIndex}` : "";
  return {
    data: items,
    items,
    comments: items,
    comment_list: items,
    cursor: {
      cursor: nextCursor,
      index: nextIndex,
      pageArea
    },
    next_cursor: nextCursor,
    has_more: Boolean(nextCursor),
    raw_count: comments.length,
    parsed_count: items.length,
    pageArea,
    sort_strategy: body.sort_strategy ?? "latest_v2"
  };
}

async function noteCommentsForTikHub(
  config: AppConfig,
  body: Record<string, unknown>,
  options: RouteOptions = {}
): Promise<Record<string, unknown>> {
  const page = normalizeCursorPage(body.index, body.cursor, 0);
  const pageSize = normalizeLimit(body.limit ?? body.max_comments ?? body.page_size, 50);
  const post = normalizePostInput(normalizeServerxPostInput(body));
  const comments = await getCommentsStrict(config, post, pageSize, {
    ...options,
    cursor: String(body.cursor ?? ""),
    index: page,
    pageArea: String(body.pageArea ?? body.page_area ?? "UNFOLDED")
  });
  const items = dedupeXhsComments(comments).map(toServerxComment);
  const nextIndex = page + 1;
  return {
    data: items,
    items,
    comments: items,
    cursor: {
      cursor: items.length ? `offset:${nextIndex}` : "",
      index: nextIndex,
      pageArea: body.pageArea ?? body.page_area ?? "UNFOLDED"
    },
    has_more: items.length >= pageSize,
    pageArea: body.pageArea ?? body.page_area ?? "UNFOLDED",
    sort_strategy: body.sort_strategy ?? "latest_v2"
  };
}

async function noteSubCommentsForServerx(
  config: AppConfig,
  body: Record<string, unknown>,
  options: RouteOptions = {}
): Promise<Record<string, unknown>[]> {
  const post = normalizePostInput(normalizeServerxPostInput(body));
  const parentId = String(body.comment_id ?? body.parent_comment_id ?? body.parent_id ?? "").trim();
  const comments = await getCommentsStrict(config, post, normalizeLimit(body.max_comments ?? body.limit, 20), options);
  const subComments = parentId ? comments.filter((comment) => comment.parentId === parentId) : comments;
  return (subComments.length ? subComments : comments).map((comment) => ({
    ...toServerxComment(comment),
    parent_comment_id: parentId || comment.parentId || "",
    parent_id: parentId || comment.parentId || ""
  }));
}

async function noteSubCommentsForTikHub(
  config: AppConfig,
  body: Record<string, unknown>,
  options: RouteOptions = {}
): Promise<Record<string, unknown>> {
  const page = Math.max(normalizeCursorPage(body.index, body.cursor, 1) - 1, 0);
  const pageSize = normalizeLimit(body.limit ?? body.max_comments ?? body.page_size, 20);
  const comments = await noteSubCommentsForServerx(config, { ...body, max_comments: (page + 1) * pageSize }, options);
  const start = page * pageSize;
  const items = comments.slice(start, start + pageSize);
  const nextIndex = page + 2;
  return {
    data: items,
    items,
    comments: items,
    cursor: {
      cursor: items.length ? `offset:${nextIndex}` : "",
      index: nextIndex
    },
    has_more: comments.length > start + items.length,
    comment_id: body.comment_id ?? body.parent_comment_id ?? body.parent_id ?? ""
  };
}

async function safeGetComments(config: AppConfig, post: XhsPost, limit: number, options: RouteOptions = {}): Promise<XhsComment[]> {
  const adapter = createXhsAdapter(config);
  try {
    if (!adapter.getComments) return [];
    return await adapter.getComments(post, limit, options);
  } catch (error) {
    if (isAbortLikeError(error)) throw error;
    return [];
  } finally {
    await adapter.close?.();
  }
}

async function getCommentsStrict(config: AppConfig, post: XhsPost, limit: number, options: RouteOptions = {}): Promise<XhsComment[]> {
  const adapter = createXhsAdapter(config);
  try {
    if (!adapter.getComments) return [];
    return await adapter.getComments(post, limit, options);
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

async function publishComment(config: AppConfig, body: Record<string, unknown>, options: RouteOptions = {}): Promise<{ published: true; post: XhsPost }> {
  const post = normalizePostInput(body);
  const content = String(body.content ?? body.comment ?? "").trim();
  if (!content) throw new PublicApiError(400, "CONTENT_REQUIRED", "content is required.");
  if (!post.xsecToken) throw new PublicApiError(400, "XSEC_TOKEN_REQUIRED", "post.xsecToken is required.");
  const adapter = createXhsAdapter(config);
  try {
    await adapter.publishComment(post, content, { signal: options.signal });
    return { published: true, post };
  } finally {
    await adapter.close?.();
  }
}

async function likePost(config: AppConfig, body: Record<string, unknown>, options: RouteOptions = {}): Promise<{ liked: boolean; post: XhsPost }> {
  const post = normalizePostInput(body);
  if (!post.xsecToken) throw new PublicApiError(400, "XSEC_TOKEN_REQUIRED", "post.xsecToken is required.");
  const adapter = createXhsAdapter(config);
  try {
    const liked = adapter.likePost ? await adapter.likePost(post, { signal: options.signal }) : false;
    return { liked, post };
  } finally {
    await adapter.close?.();
  }
}

function assertAuthorized(req: IncomingMessage): void {
  const actualToken = getRequestApiToken(req);
  if (!actualToken) throw new PublicApiError(401, "UNAUTHORIZED", "Missing API token.");
  if (!isValidApiToken(actualToken)) throw new PublicApiError(403, "FORBIDDEN", "Invalid API token.");
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

function normalizeText(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeOptionalLimit(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(100, Math.floor(numberValue)));
}

function parseBooleanFlag(value: unknown, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function normalizePositiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const numberValue = Number(value ?? fallback);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(1, Math.floor(numberValue));
}

function secondsValue(value: unknown): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value);
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (numeric <= 0) return 0;
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
  }
  const relative = relativeSecondsValue(text);
  if (relative) return relative;
  const monthDay = text.match(/^(\\d{1,2})[-./月](\\d{1,2})(?:日)?$/);
  if (monthDay) {
    const date = new Date();
    date.setMonth(Number(monthDay[1]) - 1, Number(monthDay[2]));
    date.setHours(0, 0, 0, 0);
    return Math.floor(date.getTime() / 1000);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function relativeSecondsValue(text: string): number {
  const now = Date.now();
  if (/刚刚/.test(text)) return Math.floor(now / 1000);
  const match = text.match(/(\d+)\s*(秒|分钟|小时|天|周|月|年)前/);
  if (match) {
    const value = Number(match[1]);
    const multipliers: Record<string, number> = {
      秒: 1000,
      分钟: 60 * 1000,
      小时: 60 * 60 * 1000,
      天: 24 * 60 * 60 * 1000,
      周: 7 * 24 * 60 * 60 * 1000,
      月: 30 * 24 * 60 * 60 * 1000,
      年: 365 * 24 * 60 * 60 * 1000
    };
    const date = new Date(now - value * multipliers[match[2]]);
    if (["天", "周", "月", "年"].includes(match[2])) {
      date.setHours(0, 0, 0, 0);
    }
    return Math.floor(date.getTime() / 1000);
  }
  const dayMatch = text.match(/^(昨天|前天)\s*(\d{1,2}):(\d{2})$/);
  if (!dayMatch) return 0;
  const date = new Date(now);
  date.setDate(date.getDate() - (dayMatch[1] === "昨天" ? 1 : 2));
  date.setHours(Number(dayMatch[2]), Number(dayMatch[3]), 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function normalizeCursorPage(indexValue: unknown, cursorValue: unknown, fallback: number): number {
  const cursorText = String(cursorValue ?? "");
  const offset = /^offset:(\d+)$/.exec(cursorText);
  if (offset) return Number(offset[1]);
  const index = Number(indexValue ?? fallback);
  if (!Number.isFinite(index)) return fallback;
  return Math.max(0, Math.floor(index));
}

function normalizePostInput(body: Record<string, unknown>): XhsPost {
  const raw = (body.post && typeof body.post === "object" ? body.post : body) as Record<string, unknown>;
  const id = String(raw.id ?? raw.feedId ?? raw.feed_id ?? "").trim();
  const url = String(raw.url ?? "").trim();
  const xsecToken = optionalString(raw.xsecToken ?? raw.xsec_token) || extractXsecToken(url);
  if (!id && !url) throw new PublicApiError(400, "POST_IDENTIFIER_REQUIRED", "post.id or post.url is required.");
  return {
    id: id || url,
    url: normalizeXhsUrl(url, id, xsecToken),
    title: String(raw.title ?? ""),
    snippet: String(raw.snippet ?? raw.desc ?? raw.description ?? ""),
    author: optionalString(raw.author),
    xsecToken,
    likeCount: optionalNumber(raw.likeCount ?? raw.like_count),
    commentCount: optionalNumber(raw.commentCount ?? raw.comment_count),
    publishedAt: optionalString(raw.publishedAt ?? raw.published_at)
  };
}

function normalizeServerxPostInput(body: Record<string, unknown>): Record<string, unknown> {
  const rawNoteId = String(body.note_id ?? body.id ?? body.feed_id ?? "").trim();
  const url = String(body.url ?? body.share_text ?? "").trim();
  const noteId = looksLikeHttpUrl(rawNoteId) ? "" : rawNoteId;
  const noteUrl = url || (looksLikeHttpUrl(rawNoteId) ? rawNoteId : "");
  const xsecToken = optionalString(body.xsec_token ?? body.xsecToken) || extractXsecToken(noteUrl);
  return {
    id: noteId,
    url: normalizeXhsUrl(noteUrl, noteId, xsecToken),
    xsecToken,
    title: body.title,
    snippet: body.content ?? body.desc ?? body.note_content,
    author: body.author_name
  };
}

function toServerxPost(post: XhsPost, comments: XhsComment[] = []): Record<string, unknown> {
  const payloadComments = comments.map(toServerxComment);
  const url = normalizeXhsUrl(post.url, post.id, post.xsecToken);
  const xsecToken = post.xsecToken || extractXsecToken(url);
  return {
    id: post.id,
    note_id: post.id,
    feed_id: post.id,
    url,
    share_url: url,
    link: url,
    note_url: url,
    source_url: url,
    original_url: url,
    xhs_url: url,
    web_url: url,
    title: post.title,
    display_title: post.title,
    content: post.snippet,
    desc: post.snippet,
    note_content: post.snippet,
    author_name: post.author ?? "",
    user: { nickname: post.author ?? "" },
    xsec_token: xsecToken,
    xsecToken,
    note: {
      noteId: post.id,
      note_id: post.id,
      xsecToken,
      xsec_token: xsecToken,
      url
    },
    note_card: {
      noteId: post.id,
      note_id: post.id,
      xsecToken,
      xsec_token: xsecToken,
      url
    },
    like_count: post.likeCount,
    comment_count: post.commentCount ?? payloadComments.length,
    publish_time: secondsValue(post.publishedAt),
    create_time: secondsValue(post.publishedAt),
    published_at: post.publishedAt ?? "",
    comments: payloadComments,
    comment_list: payloadComments
  };
}

function toServerxComment(comment: XhsComment): Record<string, unknown> {
  const createTime = secondsValue(comment.publishedAt);
  const id = normalizeXhsCommentId(comment.id);
  return {
    id,
    comment_id: id,
    commentId: id,
    content: comment.content,
    text: comment.content,
    comment_content: comment.content,
    author_name: comment.author ?? "",
    user: { nickname: comment.author ?? "" },
    parent_comment_id: comment.parentId ?? "",
    parent_id: comment.parentId ?? "",
    create_time: createTime,
    published_at: comment.publishedAt ?? ""
  };
}

function dedupeXhsComments(comments: XhsComment[]): XhsComment[] {
  const result: XhsComment[] = [];
  const stableIds = new Set<string>();
  const unstableIndexByContent = new Map<string, number>();
  const stableContentKeys = new Set<string>();
  for (const comment of comments) {
    const normalizedId = normalizeXhsCommentId(comment.id);
    const normalizedComment = { ...comment, id: normalizedId };
    const contentKey = xhsCommentContentKey(normalizedComment);
    if (!normalizedId || stableIds.has(normalizedId)) continue;
    if (isUnstableXhsCommentId(comment.id)) {
      if (stableContentKeys.has(contentKey)) continue;
      if (!unstableIndexByContent.has(contentKey)) {
        unstableIndexByContent.set(contentKey, result.length);
        result.push(normalizedComment);
      }
      continue;
    }
    stableIds.add(normalizedId);
    stableContentKeys.add(contentKey);
    const unstableIndex = unstableIndexByContent.get(contentKey);
    if (unstableIndex !== undefined) {
      result[unstableIndex] = normalizedComment;
      unstableIndexByContent.delete(contentKey);
    } else {
      result.push(normalizedComment);
    }
  }
  return result;
}

function normalizeXhsCommentId(id: string): string {
  const value = String(id || "").trim();
  const prefixed = /^comment-([0-9a-f]{24})$/i.exec(value);
  return prefixed ? prefixed[1] : value;
}

function isUnstableXhsCommentId(id: string): boolean {
  return /^comment-\d+-[0-9a-f]{6,16}$/i.test(String(id || "").trim());
}

function xhsCommentContentKey(comment: XhsComment): string {
  return [
    comment.parentId ?? "",
    comment.author ?? "",
    comment.publishedAt ?? "",
    comment.content
  ].join("\u0001");
}

function buildXhsUrl(id: string, rawToken: unknown): string {
  const url = new URL(`https://www.xiaohongshu.com/explore/${encodeURIComponent(id || "unknown")}`);
  const token = optionalString(rawToken);
  if (token) url.searchParams.set("xsec_token", token);
  return url.toString();
}

function normalizeXhsUrl(rawUrl: unknown, id: string, xsecToken: unknown): string {
  const rawText = String(rawUrl ?? "").trim();
  const token = optionalString(xsecToken) || extractXsecToken(rawText);
  const fallback = buildXhsUrl(id, token);
  const value = extractUrl(rawText);
  if (!value) return fallback;
  try {
    const url = new URL(normalizeUrlCandidate(value));
    if (!isAllowedXhsHttpUrl(url)) return fallback;
    if (token && isXhsExploreUrl(url) && !url.searchParams.get("xsec_token")) {
      url.searchParams.set("xsec_token", token);
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

function extractXsecToken(rawUrl: string): string {
  const value = extractUrl(rawUrl);
  if (!value) return "";
  try {
    const url = new URL(normalizeUrlCandidate(value));
    if (!isAllowedXhsHttpUrl(url)) return "";
    return url.searchParams.get("xsec_token") ?? "";
  } catch {
    return "";
  }
}

function extractUrl(value: string): string {
  if (!value) return "";
  const match = value.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0] || value;
}

function normalizeUrlCandidate(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://www.xiaohongshu.com${value}`;
  if (/^(www\.)?(xiaohongshu|xhslink)\.com(\/|$)/i.test(value)) return `https://${value}`;
  return value;
}

function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^(www\.)?(xiaohongshu|xhslink)\.com(\/|$)/i.test(value);
}

function isXhsExploreUrl(url: URL): boolean {
  return /(^|\.)xiaohongshu\.com$/i.test(url.hostname) && url.pathname.split("/").includes("explore");
}

function isAllowedXhsHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return /(^|\.)xiaohongshu\.com$/i.test(url.hostname) || /(^|\.)xhslink\.com$/i.test(url.hostname);
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
  if (existing) return existing.promise;
  const promise = task().catch((error) => {
    idempotencyResults.delete(key);
    throw error;
  });
  const timer = setTimeout(() => {
    idempotencyResults.delete(key);
  }, IDEMPOTENCY_RESULT_TTL_MS);
  timer.unref?.();
  idempotencyResults.set(key, { promise, timer });
  return promise;
}

async function fetchMcpJson(config: AppConfig, endpoint: string, signal?: AbortSignal): Promise<unknown> {
  const base = config.xhs.mcp?.url ? new URL(config.xhs.mcp.url).origin : "http://localhost:18060";
  const response = await fetchWithTimeout(`${base}${endpoint}`, {}, MCP_FETCH_TIMEOUT_MS, signal);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new PublicApiError(502, "MCP_ERROR", `MCP ${endpoint} failed: HTTP ${response.status}`);
  return data;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason ?? new PublicRequestCancelledError("Client request was aborted."));
  };
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(new PublicFetchTimeoutError(`Fetch timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendApiSuccess(res: ServerResponse, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ success: true, data }));
}

function sendApiError(res: ServerResponse, status: number, error: ApiErrorPayload): void {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ success: false, error }));
}

function normalizeApiError(error: unknown): PublicApiError {
  if (error instanceof PublicApiError) return error;
  if (error instanceof PublicFetchTimeoutError) return new PublicApiError(504, "UPSTREAM_TIMEOUT", error.message);
  if (isAbortLikeError(error)) return new PublicApiError(499, "CLIENT_CLOSED_REQUEST", error instanceof Error ? error.message : "Client request was aborted.");
  if (error instanceof SyntaxError) return new PublicApiError(400, "INVALID_JSON", "Invalid JSON body.");
  return new PublicApiError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}

function createRequestAbortSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const abort = (message: string) => {
    if (controller.signal.aborted || res.writableEnded) return;
    controller.abort(new PublicRequestCancelledError(message));
  };
  if (typeof req.on === "function") {
    req.on("aborted", () => abort("Client aborted the HTTP request."));
    req.on("close", () => {
      const requestWasAborted = (req as IncomingMessage & { aborted?: boolean; readableAborted?: boolean }).aborted === true ||
        (req as IncomingMessage & { aborted?: boolean; readableAborted?: boolean }).readableAborted === true;
      if (requestWasAborted && !res.writableEnded) abort("Client closed the HTTP request before completion.");
    });
  }
  if (typeof (res as ServerResponse & { on?: unknown }).on === "function") {
    (res as ServerResponse & { on: ServerResponse["on"] }).on("close", () => {
      if (!res.writableEnded) abort("Client connection closed before Kato returned a result.");
    });
  }
  return controller.signal;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name || "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return (
    name === "AbortError" ||
    name === "PublicRequestCancelledError" ||
    /CLIENT_CLOSED_REQUEST|Client connection closed|Client request was aborted|Client aborted the HTTP request|Client closed the HTTP request before completion/i.test(message)
  );
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
