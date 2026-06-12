import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { XhsPost } from "../domain/types.js";
import { createXhsAdapter } from "../adapters/xhsMcp.js";
import type { OperationLogger } from "../operations/logger.js";
import { silentLogger } from "../operations/logger.js";
import { ensureFixedNoteTitle, sanitizePublishComment } from "./noteLink.js";

interface PublishRow {
  interaction_id: number;
  post_id: string;
  post_url: string;
  post_title: string;
  post_snippet: string;
  author: string | null;
  xsec_token: string | null;
  draft_comment: string;
  status: string;
  note_title: string | null;
  note_url: string | null;
}

export async function publishConfirmedInteractions(
  db: Db,
  config: AppConfig,
  ids: number[],
  logger: OperationLogger = silentLogger
): Promise<{ published: number; skipped: number }> {
  if (!ids.length) throw new Error("Provide --interaction-id or --ids 1,2,3.");

  const adapter = createXhsAdapter(config);
  let published = 0;
  let skipped = 0;

  try {
    for (const id of ids) {
      logger.throwIfCancelled?.();
      const row = getPublishRow(db, id);
      if (!row) throw new Error(`Interaction ${id} not found.`);
      if (row.status !== "drafted") {
        logger.log(`跳过队列项 ${id}：还没有评论草稿`);
        skipped += 1;
        continue;
      }

      const post: XhsPost = {
        id: row.post_id,
        url: row.post_url,
        title: row.post_title,
        snippet: row.post_snippet,
        author: row.author ?? undefined,
        xsecToken: row.xsec_token ?? undefined
      };

      logger.log(`MCP 刷新帖子详情：${row.post_title}`);
      const refreshedPost = await refreshPostForPublish(adapter, post, logger);

      const sanitizedComment = sanitizePublishComment(row.draft_comment);
      const comment = ensureFixedNoteTitle(sanitizedComment, row.note_title);
      if (sanitizedComment !== row.draft_comment) {
        logger.log("已移除评论中的链接，避免小红书评论区展示无效 URL");
      }
      if (comment !== sanitizedComment && row.note_title) {
        logger.log(`已补充固定格式笔记标题：「${row.note_title}」`);
      }
      if (!comment) {
        logger.log(`跳过队列项 ${id}：评论清洗后为空`);
        skipped += 1;
        continue;
      }

      if (row.note_title) {
        logger.log(`普通文本引用笔记：${row.note_title}`);
      }

      logger.log(`MCP 发布评论：${row.post_title}`);
      logger.throwIfCancelled?.();
      await adapter.publishComment(refreshedPost, comment);

      let liked = false;
      if (adapter.likePost) {
        try {
          logger.log(`MCP 点赞帖子：${row.post_title}`);
          logger.throwIfCancelled?.();
          await adapter.likePost(refreshedPost);
          liked = true;
          logger.log(`已点赞：${row.post_title}`);
        } catch (error) {
          logger.log(`点赞失败，评论已发布：${errorMessage(error)}`);
        }
      } else {
        logger.log(`跳过点赞：当前 MCP 适配器不支持点赞`);
      }

      db.prepare("UPDATE interactions SET status = 'posted_via_mcp', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        id
      );
      logger.log(liked ? `已发布并点赞：${row.post_title}` : `已发布：${row.post_title}`);
      published += 1;
    }
  } finally {
    await adapter.close?.();
  }

  return { published, skipped };
}

function getPublishRow(db: Db, interactionId: number): PublishRow | null {
  const row = db
    .prepare(
      `
        SELECT
          i.id AS interaction_id,
          i.draft_comment,
          i.status,
          p.id AS post_id,
          p.url AS post_url,
          p.title AS post_title,
          p.snippet AS post_snippet,
          p.author,
          p.xsec_token,
          n.title AS note_title,
          n.url AS note_url
        FROM interactions i
        JOIN posts p ON p.id = i.post_id
        LEFT JOIN notes n ON n.id = i.note_id
        WHERE i.id = ?
      `
    )
    .get(interactionId);
  return (row as PublishRow | undefined) ?? null;
}

async function refreshPostForPublish(
  adapter: ReturnType<typeof createXhsAdapter>,
  post: XhsPost,
  logger: OperationLogger
): Promise<XhsPost> {
  try {
    const detail = await adapter.getPost(post);
    if (!detail) {
      logger.log("刷新详情无结果，继续使用队列里保存的 token");
      return post;
    }
    logger.log("刷新详情成功，使用最新帖子上下文发布");
    return {
      ...post,
      ...detail,
      id: detail.id || post.id,
      url: detail.url || post.url,
      xsecToken: detail.xsecToken || post.xsecToken
    };
  } catch (error) {
    logger.log(`刷新详情失败，继续使用队列里保存的 token：${errorMessage(error)}`);
    return post;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
