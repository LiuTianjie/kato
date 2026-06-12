import type { Note, ScoredPost } from "../domain/types.js";
import { matchBestNote } from "../notes/matcher.js";
import { draftComment } from "./commentDraft.js";
import { COMMENT_MAX_LENGTH, ensureFixedNoteTitle, sanitizePublishComment } from "./noteLink.js";

export interface InteractionDraft {
  note: Note | null;
  comment: string;
  rationale: string;
}

type ChatMessage = { role: "system" | "user"; content: string };

export function assertProductionCommentProviderConfigured(): void {
  if (process.env.COMMENT_PROVIDER === "ark") {
    if (!process.env.ARK_API_KEY || !process.env.ARK_MODEL) {
      throw new Error("火山方舟评论 agent 需要 ARK_API_KEY 和 ARK_MODEL。请在 .env 填写模型或推理接入点 ID。");
    }
    return;
  }

  if (process.env.ALLOW_LOCAL_COMMENT_PROVIDER === "1") return;
  throw new Error("生产模式需要 COMMENT_PROVIDER=ark。若只是本地开发测试，可设置 ALLOW_LOCAL_COMMENT_PROVIDER=1。");
}

export async function generateInteractionDraft(post: ScoredPost, notes: Note[]): Promise<InteractionDraft> {
  if (process.env.COMMENT_PROVIDER === "ark") {
    return generateInteractionWithArk(post, notes);
  }

  const match = matchBestNote(post, notes);
  return {
    note: match.note,
    comment: sanitizeComment(draftComment(post, match.note), match.note),
    rationale: "local keyword fallback"
  };
}

export async function generateComment(post: ScoredPost, note: Note | null): Promise<string> {
  if (process.env.COMMENT_PROVIDER === "ark") {
    const content = await callArk([
      {
        role: "system",
        content:
          "你是小红书评论助手。只写一条中文短评论，35-90字，真诚具体，不硬广，不写'快来看我主页'，不使用夸张营销语。"
      },
      {
        role: "user",
        content: [
          `帖子标题：${post.title}`,
          `帖子内容：${post.snippet}`,
          `匹配关键词：${post.matchedKeywords.join("、") || "无"}`,
          note
            ? `可关联笔记：${note.title}；摘要：${note.summary}；关键词：${note.keywords.join("、")}`
            : "无可关联笔记",
          "请先回应原帖里的具体点，再自然补充一个经验。可以提到匹配笔记标题，但不要用固定句式，不要写“这个场景能对上”，不要写 URL。"
        ].join("\n")
      }
    ]);
    return sanitizeComment(content, note);
  }

  return sanitizeComment(draftComment(post, note), note);
}

async function generateInteractionWithArk(post: ScoredPost, notes: Note[]): Promise<InteractionDraft> {
  const content = await callArk([
    {
        role: "system",
        content:
          "你是小红书增长评论 agent。你会阅读原帖，从用户笔记库选择最自然、最相关的一篇，再写一条评论草稿。只输出严格 JSON，不要 Markdown。评论正文必须 35-90 字，短一点，具体回应原帖，不硬广，不写'快来看我主页'，不要在 comment 字段里写 URL、网址、链接或小红书笔记地址。"
    },
    {
      role: "user",
      content: [
        "原帖：",
        JSON.stringify(
          {
            title: post.title,
            content: post.snippet,
            author: post.author,
            likeCount: post.likeCount,
            commentCount: post.commentCount,
            matchedKeywords: post.matchedKeywords
          },
          null,
          2
        ),
        "我的笔记库：",
        JSON.stringify(
          notes.map((note) => ({
            id: note.id,
            title: note.title,
            url: note.url,
            summary: note.summary,
            keywords: note.keywords,
            scenarios: note.scenarios
          })),
          null,
          2
        ),
        '返回格式：{"noteId":数字或null,"comment":"评论草稿","rationale":"选择这篇笔记的原因"}。',
        "评论写法：先回应原帖里的具体信息，再自然带到所选笔记标题，标题用中文书名号「笔记标题」。不要使用固定句式，不要写“这个场景能对上”，不要像广告，不要附任何链接。"
      ].join("\n")
    }
  ]);

  const parsed = parseJsonObject(content) as { noteId?: number | string | null; comment?: string; rationale?: string };
  const noteId = parsed.noteId == null ? null : Number(parsed.noteId);
  const note = Number.isFinite(noteId) ? notes.find((item) => item.id === noteId) ?? null : null;
  const comment = sanitizeComment(String(parsed.comment ?? ""), note);
  if (!comment) throw new Error("火山方舟评论 agent 返回了空评论。");
  return {
    note,
    comment,
    rationale: String(parsed.rationale ?? "ark agent")
  };
}

async function callArk(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.ARK_API_KEY;
  const model = process.env.ARK_MODEL;
  const baseUrl = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
  if (!apiKey || !model) {
    throw new Error("COMMENT_PROVIDER=ark requires ARK_API_KEY and ARK_MODEL.");
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.72,
      max_tokens: 220,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`Ark comment generation failed: HTTP ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Ark comment generation returned empty content.");
  return content;
}

function sanitizeComment(value: string, note?: Note | null): string {
  const compact = ensureFixedNoteTitle(sanitizePublishComment(value), note?.title)
    .replace(/^["“]|["”]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length <= COMMENT_MAX_LENGTH ? compact : compact.slice(0, COMMENT_MAX_LENGTH).trim();
}

function parseJsonObject(value: string): unknown {
  const trimmed = value
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = /\{[\s\S]*\}/.exec(trimmed);
    if (!match) throw new Error(`Ark interaction agent did not return JSON: ${value}`);
    return JSON.parse(match[0]);
  }
}
