import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { RunSlot, ScoredPost, XhsPost } from "../domain/types.js";
import { createXhsAdapter } from "../adapters/xhsMcp.js";
import type { OperationLogger } from "../operations/logger.js";
import { silentLogger } from "../operations/logger.js";
import { exportRun } from "./exporter.js";
import { DEFAULT_KEYWORDS } from "./keywords.js";
import { scorePost } from "./scorer.js";

export interface RunOptions {
  slot: RunSlot;
  limit: number;
  keywords?: string[];
  generateDrafts?: boolean;
  logger?: OperationLogger;
}

export interface RunResult {
  runId: number;
  queued: number;
  drafted: number;
  markdownPath: string;
  csvPath: string;
}

export async function runDiscovery(db: Db, config: AppConfig, options: RunOptions): Promise<RunResult> {
  const keywords = options.keywords?.length ? options.keywords : DEFAULT_KEYWORDS;
  const logger = options.logger ?? silentLogger;
  const adapter = createXhsAdapter(config);
  const runId = createRun(db, options.slot, keywords);
  const seen = new Set<string>();
  let queued = 0;

  try {
    for (const keyword of keywords) {
      logger.throwIfCancelled?.();
      if (queued >= options.limit) break;
      logger.log(`MCP 搜索关键词：${keyword}`);
      const remaining = options.limit - queued;
      const searchLimit = Math.max(5, Math.ceil(remaining / Math.max(1, keywords.length)) + 8);
      const posts = await adapter.searchPosts(keyword, searchLimit);
      logger.throwIfCancelled?.();
      logger.log(`关键词「${keyword}」返回 ${posts.length} 条候选帖子`);

      for (const post of posts) {
        logger.throwIfCancelled?.();
        if (queued >= options.limit) break;
        const normalizedUrl = normalizeUrl(post.url);
        if (seen.has(normalizedUrl)) continue;
        seen.add(normalizedUrl);

        if (hasExistingInteraction(db, post)) {
          logger.log(`跳过重复帖子：${post.title || post.id}`);
          continue;
        }

        const acceptedScore = scorePost(post, keywords);
        upsertPost(db, acceptedScore);
        insertInteraction(db, runId, acceptedScore);
        logger.log(`已入队：${acceptedScore.title}`);
        queued += 1;
      }
    }
  } finally {
    await adapter.close?.();
  }

  const exported = exportRun(db, config, runId);
  return { runId, queued, drafted: queued, ...exported };
}

function createRun(db: Db, slot: RunSlot, keywords: string[]): number {
  const result = db
    .prepare("INSERT INTO runs (slot, query_pack_json) VALUES (?, ?)")
    .run(slot, JSON.stringify(keywords));
  return Number(result.lastInsertRowid);
}

function upsertPost(db: Db, post: ScoredPost): void {
  db.prepare(`
    INSERT INTO posts (
      id, url, title, snippet, author, xsec_token, like_count, comment_count, published_at,
      matched_keywords_json, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      snippet = excluded.snippet,
      author = excluded.author,
      xsec_token = excluded.xsec_token,
      like_count = excluded.like_count,
      comment_count = excluded.comment_count,
      published_at = excluded.published_at,
      matched_keywords_json = excluded.matched_keywords_json,
      last_seen_at = CURRENT_TIMESTAMP
  `).run(
    stablePostId(post),
    post.url,
    post.title,
    post.snippet,
    post.author ?? null,
    post.xsecToken ?? null,
    post.likeCount ?? null,
    post.commentCount ?? null,
    post.publishedAt ?? null,
    JSON.stringify(post.matchedKeywords)
  );
}

function insertInteraction(
  db: Db,
  runId: number,
  post: ScoredPost
): void {
  db.prepare(`
    INSERT OR IGNORE INTO interactions (post_id, note_id, run_id, draft_comment, score, reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(stablePostId(post), null, runId, "", post.score, post.reason, "new");
}

function hasExistingInteraction(db: Db, post: XhsPost): boolean {
  const existing = db
    .prepare(
      `
        SELECT i.id
        FROM interactions i
        JOIN posts p ON p.id = i.post_id
        WHERE p.url = ? OR p.id = ?
        LIMIT 1
      `
    )
    .get(post.url, stablePostId(post));
  return Boolean(existing);
}

function stablePostId(post: XhsPost): string {
  return post.id || normalizeUrl(post.url);
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.trim();
  }
}
