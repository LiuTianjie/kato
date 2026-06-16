import type { PlatformComment, PlatformPost, PlatformRequestOptions, ReadOnlyPlatformAdapter } from "../platforms/types.js";

export interface DouyinAdapter extends ReadOnlyPlatformAdapter<PlatformPost, PlatformComment> {
  readonly platformId: "douyin";
}

const DEFAULT_DOUYIN_SERVICE_URL = "http://localhost:18070";
const REST_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_REST_TIMEOUT_MS", 600_000);

export function createDouyinAdapter(): DouyinAdapter {
  return new HttpDouyinAdapter();
}

class HttpDouyinAdapter implements DouyinAdapter {
  readonly platformId = "douyin" as const;
  private readonly restBaseUrl: string;

  constructor() {
    this.restBaseUrl = normalizeBaseUrl(process.env.DOUYIN_SERVICE_URL || process.env.DOUYIN_MCP_URL || DEFAULT_DOUYIN_SERVICE_URL);
  }

  async searchPosts(query: string, limit: number, options: PlatformRequestOptions = {}): Promise<PlatformPost[]> {
    const payload = await this.postJson("/api/v1/posts/search", { keyword: query, limit }, options);
    return coercePosts(payload).slice(0, limit);
  }

  async getPost(postOrUrl: PlatformPost | string, options: PlatformRequestOptions = {}): Promise<PlatformPost | null> {
    const input = typeof postOrUrl === "string" ? { url: postOrUrl } : { id: postOrUrl.id, url: postOrUrl.url };
    const payload = await this.postJson("/api/v1/posts/detail", input, options);
    return coercePosts(payload)[0] ?? null;
  }

  async getComments(postOrUrl: PlatformPost | string, limit: number, options: PlatformRequestOptions = {}): Promise<PlatformComment[]> {
    const input = typeof postOrUrl === "string" ? { url: postOrUrl, limit } : { id: postOrUrl.id, url: postOrUrl.url, limit };
    const payload = await this.postJson("/api/v1/posts/comments", input, options);
    return coerceComments(payload).slice(0, limit);
  }

  private async postJson(pathname: string, body: Record<string, unknown>, options: PlatformRequestOptions): Promise<unknown> {
    const response = await fetchWithTimeout(new URL(pathname, this.restBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, REST_TIMEOUT_MS, options.signal);
    return parseServiceResponse(response, pathname);
  }
}

async function parseServiceResponse(response: Response, pathname: string): Promise<unknown> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || isServiceFailure(payload)) {
    throw new Error(serviceErrorMessage(payload, `Douyin REST ${pathname} failed: HTTP ${response.status}`));
  }
  return unwrapData(payload);
}

function coercePosts(value: unknown): PlatformPost[] {
  const raw = unwrapData(value);
  const list = extractList(raw, ["posts", "items", "data", "aweme_list"]);
  return list.map(normalizePost).filter((post) => post.id || post.url);
}

function normalizePost(value: unknown): PlatformPost {
  const item = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const raw = unwrapData(item.raw ?? item);
  const rawObject = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const id = stringValue(item.id ?? item.aweme_id ?? rawObject.aweme_id ?? rawObject.id);
  const title = stringValue(item.title ?? rawObject.desc ?? rawObject.title);
  const snippet = stringValue(item.snippet ?? rawObject.desc ?? title);
  return {
    platform: "douyin",
    id,
    url: normalizeDouyinUrl(stringValue(item.url ?? rawObject.share_url), id),
    title: title || snippet || "抖音作品",
    snippet,
    author: stringValue(item.author ?? nested(rawObject, ["author", "nickname"])),
    likeCount: optionalNumber(item.likeCount ?? nested(rawObject, ["statistics", "digg_count"])),
    commentCount: optionalNumber(item.commentCount ?? nested(rawObject, ["statistics", "comment_count"])),
    publishedAt: stringValue(item.publishedAt) || dateFromSeconds(rawObject.create_time),
    raw: item.raw ?? item
  };
}

function coerceComments(value: unknown): PlatformComment[] {
  const raw = unwrapData(value);
  const list = extractList(raw, ["comments", "items", "data"]);
  return list.map(normalizeComment).filter((comment) => comment.id || comment.content);
}

function normalizeComment(value: unknown): PlatformComment {
  const item = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const raw = unwrapData(item.raw ?? item);
  const rawObject = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    platform: "douyin",
    id: stringValue(item.id ?? item.cid ?? rawObject.cid ?? rawObject.comment_id),
    content: stringValue(item.content ?? rawObject.text),
    author: stringValue(item.author ?? nested(rawObject, ["user", "nickname"])),
    parentId: stringValue(item.parentId ?? rawObject.reply_id ?? rawObject.parent_id),
    raw: item.raw ?? item
  };
}

function extractList(value: unknown, keys: string[]): unknown[] {
  const raw = unwrapData(value);
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const key of keys) {
    const child = (raw as Record<string, unknown>)[key];
    if (Array.isArray(child)) return child;
    const unwrapped = unwrapData(child);
    if (Array.isArray(unwrapped)) return unwrapped;
  }
  return [];
}

function unwrapData(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    if (!current || typeof current !== "object" || !("data" in current)) break;
    const data = (current as { data?: unknown }).data;
    if (data === undefined || data === current) break;
    current = data;
  }
  return current;
}

function isServiceFailure(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "success" in payload && (payload as { success?: unknown }).success === false);
}

function serviceErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return fallback;
}

async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason ?? new Error("Douyin request was aborted."));
  };
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`Douyin request timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
}

function normalizeDouyinUrl(value: string, id: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(www\.)?douyin\.com(\/|$)/i.test(value)) return `https://${value}`;
  if (id) return `https://www.douyin.com/video/${encodeURIComponent(id)}`;
  return value;
}

function nested(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dateFromSeconds(value: unknown): string | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return new Date(parsed * 1000).toISOString();
}

function normalizePositiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
