import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { ScoredPost, XhsPost } from "../domain/types.js";
import { createXhsAdapter } from "../adapters/xhsMcp.js";
import { listActiveNotes } from "../notes/importNotes.js";
import type { OperationLogger } from "../operations/logger.js";
import { silentLogger } from "../operations/logger.js";
import { assertProductionCommentProviderConfigured, generateInteractionDraft } from "./commentProvider.js";

const DRAFTABLE_STATUSES = new Set(["new", "drafted"]);

interface DraftRow {
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

interface DraftJob {
  id: number;
  row: DraftRow;
}

export async function generateDraftsForInteractions(
  db: Db,
  config: AppConfig,
  ids: number[],
  logger: OperationLogger = silentLogger
): Promise<{ generated: number; skipped: number }> {
  if (!ids.length) throw new Error("请选择要生成评论的队列项。");
  assertProductionCommentProviderConfigured();
  const notes = listActiveNotes(db);
  if (!notes.length) throw new Error("请先在我的笔记库添加至少一条 active 笔记。");

  const jobs: DraftJob[] = [];
  let generated = 0;
  let skipped = 0;

  for (const id of ids) {
    const row = getDraftRow(db, id);
    if (!row || !DRAFTABLE_STATUSES.has(row.status)) {
      logger.log(`跳过队列项 ${id}：状态不可生成`);
      skipped += 1;
      continue;
    }
    jobs.push({ id, row });
  }

  if (!jobs.length) return { generated, skipped };

  const concurrency = Math.min(commentGenerationConcurrency(), jobs.length);
  logger.log(`并发生成评论：${concurrency} 路，共 ${jobs.length} 条`);

  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const adapter = createXhsAdapter(config);
      try {
        while (true) {
          logger.throwIfCancelled?.();
          const job = jobs[cursor++];
          if (!job) return;
          await generateDraftForJob(db, adapter, job, notes, logger);
          generated += 1;
        }
      } finally {
        await adapter.close?.();
      }
    })
  );

  return { generated, skipped };
}

async function generateDraftForJob(
  db: Db,
  adapter: ReturnType<typeof createXhsAdapter>,
  job: DraftJob,
  notes: ReturnType<typeof listActiveNotes>,
  logger: OperationLogger
): Promise<void> {
  const basePost = rowToPost(job.row);
  logger.setItemStatus?.(job.id, "读取详情");
  logger.log(`MCP 读取帖子详情：${basePost.title}`);
  const detailed = (await tryGetPostDetail(adapter, basePost, logger)) ?? basePost;
  logger.throwIfCancelled?.();
  const post = rowToScoredPost(job.row, detailed);
  updatePostDetail(db, post);
  logger.setItemStatus?.(job.id, "生成评论");
  logger.log(`方舟 agent 生成评论：${post.title}`);
  const draft = await generateInteractionDraft(post, notes);
  logger.throwIfCancelled?.();

  db.prepare(
    `
      UPDATE interactions
      SET note_id = ?, draft_comment = ?, status = 'drafted', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(draft.note?.id ?? null, draft.comment, job.id);
  logger.setItemStatus?.(job.id, "已完成");
  logger.log(`已生成评论：${post.title}`);
}

function commentGenerationConcurrency(): number {
  const raw = Number(process.env.COMMENT_GENERATION_CONCURRENCY ?? 3);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(6, Math.floor(raw)));
}

function getDraftRow(db: Db, interactionId: number): DraftRow | null {
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
  return (row as DraftRow | undefined) ?? null;
}

function rowToPost(row: DraftRow): XhsPost {
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

function rowToScoredPost(row: DraftRow, post: XhsPost): ScoredPost {
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
    logger.log(`读取详情失败，使用已有摘要：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function updatePostDetail(db: Db, post: ScoredPost): void {
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
}
