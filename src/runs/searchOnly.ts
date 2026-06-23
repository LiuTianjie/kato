import type { AppConfig } from "../config.js";
import type { XhsPost } from "../domain/types.js";
import { createXhsAdapter } from "../adapters/xhsMcp.js";
import { DEFAULT_KEYWORDS } from "./keywords.js";

export interface SearchOnlyOptions {
  keywords?: string[];
  limit: number;
  signal?: AbortSignal;
}

export interface SearchOnlyResult {
  keywords: string[];
  limit: number;
  posts: XhsPost[];
}

export async function searchOnlyPosts(config: AppConfig, options: SearchOnlyOptions): Promise<SearchOnlyResult> {
  const keywords = options.keywords?.length ? options.keywords : DEFAULT_KEYWORDS.slice(0, 1);
  const limit = normalizeLimit(options.limit);
  const adapter = createXhsAdapter(config);
  const seen = new Set<string>();
  const posts: XhsPost[] = [];

  try {
    for (const keyword of keywords) {
      throwIfAborted(options.signal);
      if (posts.length >= limit) break;
      const remaining = limit - posts.length;
      const results = await adapter.searchPosts(keyword, Math.max(remaining, 10), { signal: options.signal });
      for (const post of results) {
        throwIfAborted(options.signal);
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

  return { keywords, limit, posts: posts.sort(comparePostPublishedAtDesc) };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(typeof reason === "string" && reason ? reason : "Search request was aborted.");
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function comparePostPublishedAtDesc(a: XhsPost, b: XhsPost): number {
  return parsePublishedAtMs(b.publishedAt) - parsePublishedAtMs(a.publishedAt);
}

function parsePublishedAtMs(value?: string): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}
