import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { Note, ScoredPost, XhsPost } from "../domain/types.js";
import { createXhsAdapter } from "../adapters/xhsMcp.js";
import { listActiveNotes } from "../notes/importNotes.js";
import type { OperationLogger } from "../operations/logger.js";
import { silentLogger } from "../operations/logger.js";
import { assertProductionCommentProviderConfigured, generateInteractionDraft } from "./commentProvider.js";
import { ensureFixedNoteTitle, sanitizePublishComment } from "./noteLink.js";

const DIRECT_PUBLISHABLE_STATUSES = new Set(["new", "drafted"]);

interface GeneratePublishRow {
  interaction_id: number;
  status: string;
  score: number;
  reason: string;
  matched_keywords_json: string;
  post_id: string;
  post_url: string;
  post_title: string;
  post_snippet: string;
  author: string | null;
  xsec_token: string | null;
  like_count: number | null;
  comment_count: number | null;
  published_at: string | null;
}

interface GeneratePublishJob {
  id: number;
  row: GeneratePublishRow;
}

export async function generateAndPublishInteractions(
  db: Db,
  config: AppConfig,
  ids: number[],
  logger: OperationLogger = silentLogger
): Promise<{ generated: number; published: number; skipped: number }> {
  if (!ids.length) throw new Error("请选择要评论并发布的队列项。");
  assertProductionCommentProviderConfigured();
  const notes = listActiveNotes(db);
  if (!notes.length) throw new Error("请先在我的笔记库添加至少一条 active 笔记。");

  const jobs: GeneratePublishJob[] = [];
  let generated = 0;
  let published = 0;
  let skipped = 0;

  for (const id of ids) {
    const row = getGeneratePublishRow(db, id);
    if (!row || !DIRECT_PUBLISHABLE_STATUSES.has(row.status)) {
      logger.log(`跳过队列项 ${id}：状态不可直接评论并发布`);
      skipped += 1;
      continue;
    }
    jobs.push({ id, row });
  }

  if (!jobs.length) return { generated, published, skipped };

  const concurrency = Math.min(generatePublishConcurrency(), jobs.length);
  logger.log(`并发评论并发布：${concurrency} 路，共 ${jobs.length} 条`);

  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const adapter = createXhsAdapter(config);
      try {
        while (true) {
          logger.throwIfCancelled?.();
          const job = jobs[cursor++];
          if (!job) return;
          try {
            const result = await generateAndPublishJob(db, adapter, job, notes, logger);
            generated += result.generated;
            published += result.published;
            skipped += result.skipped;
          } catch (error) {
            if (isCancellation(error)) throw error;
            logger.setItemStatus?.(job.id, "失败");
            skipped += 1;
            logger.log(`队列项 ${job.id} 评论并发布失败：${errorMessage(error)}`);
          }
        }
      } finally {
        await adapter.close?.();
      }
    })
  );

  return { generated, published, skipped };
}

async function generateAndPublishJob(
  db: Db,
  adapter: ReturnType<typeof createXhsAdapter>,
  job: GeneratePublishJob,
  notes: Note[],
  logger: OperationLogger
): Promise<{ generated: number; published: number; skipped: number }> {
  const basePost = rowToPost(job.row);
  logger.setItemStatus?.(job.id, "准备中");
  logger.log(`开始评论并发布：${basePost.title}`);

  logger.setItemStatus?.(job.id, "读取详情");
  logger.log(`MCP 读取帖子详情：${basePost.title}`);
  const detailedPost = (await tryGetPostDetail(adapter, basePost, logger)) ?? basePost;
  logger.throwIfCancelled?.();
  const post = rowToScoredPost(job.row, detailedPost);

  logger.setItemStatus?.(job.id, "生成评论");
  logger.log(`方舟 agent 生成评论：${post.title}`);
  const draft = await generateInteractionDraft(post, notes);
  logger.throwIfCancelled?.();
  const sanitizedComment = sanitizePublishComment(draft.comment);
  const comment = ensureFixedNoteTitle(sanitizedComment, draft.note?.title);
  if (!comment) {
    logger.setItemStatus?.(job.id, "已跳过");
    logger.log(`跳过队列项 ${job.id}：评论清洗后为空`);
    return { generated: 1, published: 0, skipped: 1 };
  }

  logger.setItemStatus?.(job.id, "发布评论");
  logger.log(`MCP 发布评论：${post.title}`);
  await adapter.publishComment(post, comment);
  updatePostedInteraction(db, job.id, post, draft.note?.id ?? null, comment);

  let liked = false;
  if (adapter.likePost) {
    try {
      logger.setItemStatus?.(job.id, "点赞");
      logger.log(`MCP 点赞帖子：${post.title}`);
      await adapter.likePost(post);
      liked = true;
      logger.log(`已点赞：${post.title}`);
    } catch (error) {
      logger.log(`点赞失败，评论已发布：${errorMessage(error)}`);
    }
  }

  logger.setItemStatus?.(job.id, "已完成");
  logger.log(liked ? `已评论、发布并点赞：${post.title}` : `已评论并发布：${post.title}`);
  return { generated: 1, published: 1, skipped: 0 };
}

function getGeneratePublishRow(db: Db, interactionId: number): GeneratePublishRow | null {
  const row = db
    .prepare(
      `
        SELECT
          i.id AS interaction_id,
          i.status,
          i.score,
          i.reason,
          p.id AS post_id,
          p.url AS post_url,
          p.title AS post_title,
          p.snippet AS post_snippet,
          p.author,
          p.xsec_token,
          p.like_count,
          p.comment_count,
          p.published_at,
          p.matched_keywords_json
        FROM interactions i
        JOIN posts p ON p.id = i.post_id
        WHERE i.id = ?
      `
    )
    .get(interactionId);
  return (row as GeneratePublishRow | undefined) ?? null;
}

function rowToPost(row: GeneratePublishRow): XhsPost {
  return {
    id: row.post_id,
    url: row.post_url,
    title: row.post_title,
    snippet: row.post_snippet,
    author: row.author ?? undefined,
    xsecToken: row.xsec_token ?? undefined,
    likeCount: row.like_count ?? undefined,
    commentCount: row.comment_count ?? undefined,
    publishedAt: row.published_at ?? undefined
  };
}

function rowToScoredPost(row: GeneratePublishRow, post: XhsPost): ScoredPost {
  return {
    ...post,
    score: Number(row.score),
    reason: row.reason,
    matchedKeywords: JSON.parse(row.matched_keywords_json || "[]") as string[]
  };
}

async function tryGetPostDetail(
  adapter: ReturnType<typeof createXhsAdapter>,
  post: XhsPost,
  logger: OperationLogger
): Promise<XhsPost | null> {
  try {
    return await adapter.getPost(post);
  } catch (error) {
    logger.log(`读取详情失败，使用已有摘要：${errorMessage(error)}`);
    return null;
  }
}

function updatePostedInteraction(
  db: Db,
  interactionId: number,
  post: ScoredPost,
  noteId: number | null,
  comment: string
): void {
  db.prepare(
    `
      UPDATE posts
      SET title = ?, snippet = ?, author = ?, xsec_token = ?, like_count = ?, comment_count = ?, published_at = ?, last_seen_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(
    post.title,
    post.snippet,
    post.author ?? null,
    post.xsecToken ?? null,
    post.likeCount ?? null,
    post.commentCount ?? null,
    post.publishedAt ?? null,
    post.id
  );

  db.prepare(
    `
      UPDATE interactions
      SET note_id = ?, draft_comment = ?, status = 'posted_via_mcp', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(noteId, comment, interactionId);
}

function generatePublishConcurrency(): number {
  const raw = Number(process.env.GENERATE_PUBLISH_CONCURRENCY ?? 3);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(4, Math.floor(raw)));
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "OperationCancelledError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
