import type { Note, ScoredPost } from "../domain/types.js";
import { matchBestNote } from "../notes/matcher.js";
import { getRuleRejectionReason } from "./scorer.js";
import { callArk, canUseArk, parseArkJson } from "../llm/arkClient.js";

export interface RelevanceDecision {
  keep: boolean;
  reason: string;
  noteId: number | null;
  confidence: number;
  source: "ark" | "rules";
}

export async function evaluatePostRelevance(
  post: ScoredPost,
  notes: Note[],
  keywords: string[]
): Promise<RelevanceDecision> {
  if (shouldUseArkRelevance()) {
    try {
      return await evaluateWithArk(post, notes, keywords);
    } catch {
      return evaluateWithRules(post, notes);
    }
  }

  return evaluateWithRules(post, notes);
}

export function shouldUseArkRelevance(): boolean {
  if (process.env.RELEVANCE_EVALUATOR === "off") return false;
  const provider = process.env.RELEVANCE_PROVIDER ?? process.env.COMMENT_PROVIDER;
  return Boolean(provider === "ark" && canUseArk("relevance"));
}

function evaluateWithRules(post: ScoredPost, notes: Note[]): RelevanceDecision {
  const rejectionReason = getRuleRejectionReason(post);
  const match = matchBestNote(post, notes);
  if (rejectionReason) {
    return {
      keep: false,
      reason: rejectionReason,
      noteId: match.note?.id ?? null,
      confidence: 0.35,
      source: "rules"
    };
  }

  return {
    keep: true,
    reason: [post.reason, match.note ? `可自然关联笔记「${match.note.title}」` : ""].filter(Boolean).join("；"),
    noteId: match.note?.id ?? null,
    confidence: Math.min(0.95, 0.55 + post.score / 100),
    source: "rules"
  };
}

async function evaluateWithArk(post: ScoredPost, notes: Note[], keywords: string[]): Promise<RelevanceDecision> {
  const content = await callArk(
    [
      {
        role: "system",
        content:
          "你是小红书运营选帖质检器。你的任务是快速判断帖子是否值得进入互动队列。只输出严格 JSON，不要 Markdown。"
      },
      {
        role: "user",
        content: [
          "判断标准：",
          "1. 帖子必须适合账号用真实经验自然评论，不要硬广。",
          "2. 优先保留能自然关联到我的某篇笔记的帖子。",
          "3. 纯抽奖、互赞互关、低价引流、招聘、无上下文吐槽、内容太空泛的帖子应跳过。",
          "4. 搜索关键词只是线索，不要求逐字命中；语义相关且能接上笔记即可保留。",
          "",
          "搜索关键词：",
          JSON.stringify(keywords),
          "",
          "候选帖子：",
          JSON.stringify(
            {
              title: post.title,
              snippet: post.snippet,
              author: post.author,
              likeCount: post.likeCount,
              commentCount: post.commentCount,
              ruleScore: post.score,
              matchedKeywords: post.matchedKeywords
            },
            null,
            2
          ),
          "",
          "我的笔记库：",
          JSON.stringify(
            notes.map((note) => ({
              id: note.id,
              title: note.title,
              summary: note.summary,
              keywords: note.keywords,
              scenarios: note.scenarios
            })),
            null,
            2
          ),
          "",
          '返回格式：{"keep":true或false,"noteId":数字或null,"confidence":0到1,"reason":"20字以内中文理由"}。'
        ].join("\n")
      }
    ],
    {
      modelKind: "relevance",
      temperature: 0.1,
      maxTokens: 120,
      label: "Ark relevance evaluator"
    }
  );

  const parsed = parseArkJson<{
    keep?: boolean;
    noteId?: number | string | null;
    confidence?: number | string;
    reason?: string;
  }>(content, "Ark relevance evaluator");
  const noteId = parsed.noteId == null ? null : Number(parsed.noteId);
  const validNote = Number.isFinite(noteId) ? notes.find((note) => note.id === noteId) : null;
  const confidence = clamp01(Number(parsed.confidence ?? 0.5));
  const reason = String(parsed.reason ?? "").trim().slice(0, 80);

  return {
    keep: Boolean(parsed.keep),
    reason: reason || (parsed.keep ? "模型判断适合互动" : "模型判断不适合互动"),
    noteId: validNote?.id ?? null,
    confidence,
    source: "ark"
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
