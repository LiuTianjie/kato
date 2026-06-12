import type { AppConfig } from "../config.js";
import type { XhsPost } from "../domain/types.js";
import { createXhsAdapter } from "../adapters/xhsMcp.js";
import { DEFAULT_KEYWORDS } from "./keywords.js";

export interface SearchOnlyOptions {
  keywords?: string[];
  limit: number;
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
      if (posts.length >= limit) break;
      const remaining = limit - posts.length;
      const results = await adapter.searchPosts(keyword, Math.max(remaining, 10));
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

  return { keywords, limit, posts };
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(100, Math.floor(value)));
}
