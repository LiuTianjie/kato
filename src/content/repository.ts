import type { Db } from "../db/client.js";
import type {
  AccountPersona,
  ContentDraft,
  ContentDraftStatus,
  ContentEvent,
  ContentPublishStatus,
  ContentProject,
  ContentProjectStatus,
  ContentSource,
  ContentType,
  WebResearchSource
} from "../domain/types.js";

export interface ContentProjectDetail {
  project: ContentProject;
  sources: ContentSource[];
  webSources: WebResearchSource[];
  draft: ContentDraft | null;
  events: ContentEvent[];
}

export interface AccountPersonaInput {
  name: string;
  positioning: string;
  targetReaders: string;
  tone: string;
  commonPhrases: string[] | string;
  bannedPhrases: string[] | string;
  experienceBank: string;
  status?: "active" | "paused";
}

const DRAFT_STATUSES = new Set<ContentDraftStatus>(["drafted", "approved", "rejected", "needs_revision"]);

export function getActivePersona(db: Db): AccountPersona | null {
  const row = db
    .prepare("SELECT * FROM account_personas WHERE status = 'active' ORDER BY updated_at DESC, id DESC LIMIT 1")
    .get();
  return row ? personaFromRow(row) : null;
}

export function suggestAccountPersona(db: Db, profileName?: string): AccountPersona {
  const notes = db
    .prepare("SELECT title, summary, keywords_json, scenarios_json FROM notes WHERE status = 'active' ORDER BY updated_at DESC, id DESC LIMIT 8")
    .all() as Array<Record<string, unknown>>;
  const titles = notes.map((note) => String(note.title)).filter(Boolean);
  const summaries = notes.map((note) => String(note.summary)).filter(Boolean);
  const keywords = [
    ...new Set(
      notes.flatMap((note) => {
        try {
          return JSON.parse(String(note.keywords_json)) as string[];
        } catch {
          return [];
        }
      })
    )
  ].slice(0, 10);
  const scenarios = [
    ...new Set(
      notes.flatMap((note) => {
        try {
          return JSON.parse(String(note.scenarios_json)) as string[];
        } catch {
          return [];
        }
      })
    )
  ].slice(0, 6);
  const topicLine = keywords.length ? keywords.join("、") : "小红书内容、工具体验、真实经验";
  return {
    name: profileName?.trim() || "我的小红书账号",
    positioning: titles.length
      ? `围绕 ${topicLine} 写真实使用感、踩坑和可落地方法。参考已同步笔记：${titles.slice(0, 4).join("；")}。`
      : "围绕自己真实经历和长期观察写内容，少做泛泛科普，多给具体判断。",
    targetReaders: scenarios.length
      ? `正在遇到这些场景的人：${scenarios.join("；")}。`
      : "想用更省力的方法解决具体问题、但不想被工具清单淹没的读者。",
    tone: "像本人复盘后的表达：具体、克制、少营销感，可以有一点口语和个人判断。",
    commonPhrases: ["我的判断是", "我会先看", "先跑通一步", "真正卡住的地方是"],
    bannedPhrases: ["保姆级", "天花板", "赶快收藏", "不容错过", "看完直接封神", "作为一个AI"],
    experienceBank: summaries.length
      ? summaries.slice(0, 6).join("\n")
      : "这里会随着同步笔记自动带入可复用的真实经验素材，也可以手动补充。",
    status: "active"
  };
}

export function saveAccountPersona(db: Db, input: AccountPersonaInput): AccountPersona {
  const persona = normalizePersona(input);
  const existing = db.prepare("SELECT id FROM account_personas ORDER BY updated_at DESC, id DESC LIMIT 1").get() as
    | { id: number }
    | undefined;

  if (existing) {
    db.prepare(
      `
        UPDATE account_personas
        SET name = ?, positioning = ?, target_readers = ?, tone = ?, common_phrases_json = ?,
            banned_phrases_json = ?, experience_bank = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(
      persona.name,
      persona.positioning,
      persona.targetReaders,
      persona.tone,
      JSON.stringify(persona.commonPhrases),
      JSON.stringify(persona.bannedPhrases),
      persona.experienceBank,
      persona.status,
      existing.id
    );
    return personaFromRow(db.prepare("SELECT * FROM account_personas WHERE id = ?").get(existing.id));
  }

  const result = db
    .prepare(
      `
        INSERT INTO account_personas (
          name, positioning, target_readers, tone, common_phrases_json, banned_phrases_json,
          experience_bank, status, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `
    )
    .run(
      persona.name,
      persona.positioning,
      persona.targetReaders,
      persona.tone,
      JSON.stringify(persona.commonPhrases),
      JSON.stringify(persona.bannedPhrases),
      persona.experienceBank,
      persona.status
    );
  return personaFromRow(db.prepare("SELECT * FROM account_personas WHERE id = ?").get(Number(result.lastInsertRowid)));
}

export function createContentProject(
  db: Db,
  input: { keyword: string; contentType: ContentType; personaSnapshot: AccountPersona | null }
): ContentProject {
  const keyword = input.keyword.trim();
  if (!keyword) throw new Error("内容生产关键词不能为空。");
  const result = db
    .prepare(
      `
        INSERT INTO content_projects (keyword, content_type, status, persona_snapshot_json, updated_at)
        VALUES (?, ?, 'running', ?, CURRENT_TIMESTAMP)
      `
    )
    .run(keyword, input.contentType, input.personaSnapshot ? JSON.stringify(input.personaSnapshot) : null);
  return getContentProject(db, Number(result.lastInsertRowid));
}

export function updateContentProject(
  db: Db,
  id: number,
  fields: { status?: ContentProjectStatus; researchSummary?: string }
): ContentProject {
  const current = getContentProject(db, id);
  db.prepare(
    `
      UPDATE content_projects
      SET status = ?, research_summary = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(fields.status ?? current.status, fields.researchSummary ?? current.researchSummary, id);
  return getContentProject(db, id);
}

export function listContentProjects(db: Db, limit = 30): ContentProject[] {
  return db
    .prepare("SELECT * FROM content_projects ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(Math.max(1, Math.min(100, Math.floor(limit))))
    .map(projectFromRow);
}

export function getContentProjectDetail(db: Db, id: number): ContentProjectDetail {
  return {
    project: getContentProject(db, id),
    sources: listContentSources(db, id),
    webSources: listWebResearchSources(db, id),
    draft: getContentDraft(db, id),
    events: listContentEvents(db, id)
  };
}

export function saveContentEvent(db: Db, event: ContentEvent): ContentEvent {
  const normalized = {
    ...event,
    level: event.level === "warn" || event.level === "error" ? event.level : "info"
  } satisfies ContentEvent;
  const result = db
    .prepare(
      `
        INSERT INTO content_events (project_id, level, stage, message, metadata_json)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .run(
      normalized.projectId,
      normalized.level,
      normalized.stage,
      normalized.message,
      JSON.stringify(normalized.metadata ?? {})
    );
  return eventFromRow(db.prepare("SELECT * FROM content_events WHERE id = ?").get(Number(result.lastInsertRowid)));
}

export function saveContentSource(db: Db, source: ContentSource): ContentSource {
  db.prepare(
    `
      INSERT INTO content_sources (
        project_id, post_id, url, title, snippet, author, like_count, comment_count, published_at,
        source_analysis, heat_score, heat_reason, detail_error, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, url) DO UPDATE SET
        title = excluded.title,
        snippet = excluded.snippet,
        author = excluded.author,
        like_count = excluded.like_count,
        comment_count = excluded.comment_count,
        published_at = excluded.published_at,
        source_analysis = excluded.source_analysis,
        heat_score = excluded.heat_score,
        heat_reason = excluded.heat_reason,
        detail_error = excluded.detail_error,
        status = excluded.status
    `
  ).run(
    source.projectId,
    source.postId,
    source.url,
    source.title,
    source.snippet,
    source.author ?? null,
    source.likeCount ?? null,
    source.commentCount ?? null,
    source.publishedAt ?? null,
    source.sourceAnalysis,
    source.heatScore ?? null,
    source.heatReason ?? "",
    source.detailError ?? null,
    source.status
  );
  return listContentSources(db, source.projectId).find((item) => item.url === source.url) ?? source;
}

export function saveWebResearchSource(db: Db, source: WebResearchSource): WebResearchSource {
  const result = db
    .prepare(
      `
        INSERT INTO web_research_sources (
          project_id, query, title, url, snippet, extracted_text, status, error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      source.projectId,
      source.query,
      source.title,
      source.url,
      source.snippet,
      source.extractedText,
      source.status,
      source.error ?? null
    );
  return {
    ...source,
    id: Number(result.lastInsertRowid)
  };
}

export function saveContentDraft(db: Db, draft: ContentDraft): ContentDraft {
  db.prepare(
    `
      INSERT INTO content_drafts (
        project_id, title_candidates_json, cover_text, body, tags_json, image_plan_json,
        visual_style, persona_fit, human_voice_review_json, originality_check_json,
        factual_claims_json, source_refs_json, unsupported_claims_json, risk_notes_json,
        image_paths_json, publish_status, published_url, publish_error, status, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(project_id) DO UPDATE SET
        title_candidates_json = excluded.title_candidates_json,
        cover_text = excluded.cover_text,
        body = excluded.body,
        tags_json = excluded.tags_json,
        image_plan_json = excluded.image_plan_json,
        visual_style = excluded.visual_style,
        persona_fit = excluded.persona_fit,
        human_voice_review_json = excluded.human_voice_review_json,
        originality_check_json = excluded.originality_check_json,
        factual_claims_json = excluded.factual_claims_json,
        source_refs_json = excluded.source_refs_json,
        unsupported_claims_json = excluded.unsupported_claims_json,
        risk_notes_json = excluded.risk_notes_json,
        image_paths_json = excluded.image_paths_json,
        publish_status = excluded.publish_status,
        published_url = excluded.published_url,
        publish_error = excluded.publish_error,
        status = excluded.status,
        updated_at = CURRENT_TIMESTAMP
    `
  ).run(
    draft.projectId,
    JSON.stringify(draft.titleCandidates),
    draft.coverText,
    draft.body,
    JSON.stringify(draft.tags),
    JSON.stringify(draft.imagePlan),
    draft.visualStyle,
    draft.personaFit,
    JSON.stringify(draft.humanVoiceReview),
    JSON.stringify(draft.originalityCheck),
    JSON.stringify(draft.factualClaims),
    JSON.stringify(draft.sourceRefs),
    JSON.stringify(draft.unsupportedClaims),
    JSON.stringify(draft.riskNotes),
    JSON.stringify(draft.imagePaths),
    draft.publishStatus,
    draft.publishedUrl ?? null,
    draft.publishError ?? null,
    draft.status
  );
  const saved = getContentDraft(db, draft.projectId);
  if (!saved) throw new Error("Failed to save content draft.");
  return saved;
}

export function updateContentDraftStatus(db: Db, draftId: number, status: string): ContentDraft {
  if (!DRAFT_STATUSES.has(status as ContentDraftStatus)) throw new Error(`Invalid content draft status: ${status}`);
  const current = getContentDraftById(db, draftId);
  if (status === "approved" && current.unsupportedClaims.length) {
    throw new Error("草稿存在未被来源支持的事实，不能审核通过。");
  }
  const changes = db
    .prepare("UPDATE content_drafts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(status, draftId).changes;
  if (!changes) throw new Error(`Content draft ${draftId} not found.`);
  const row = db.prepare("SELECT * FROM content_drafts WHERE id = ?").get(draftId);
  return draftFromRow(row);
}

export function getContentDraftById(db: Db, draftId: number): ContentDraft {
  const row = db.prepare("SELECT * FROM content_drafts WHERE id = ?").get(draftId);
  if (!row) throw new Error(`Content draft ${draftId} not found.`);
  return draftFromRow(row);
}

export function updateContentDraftBody(
  db: Db,
  draftId: number,
  input: Partial<Pick<ContentDraft, "titleCandidates" | "coverText" | "body" | "tags" | "imagePlan" | "visualStyle" | "imagePaths">>
): ContentDraft {
  const currentRow = db.prepare("SELECT * FROM content_drafts WHERE id = ?").get(draftId);
  if (!currentRow) throw new Error(`Content draft ${draftId} not found.`);
  const current = draftFromRow(currentRow);
  const textChanged =
    input.titleCandidates !== undefined ||
    input.coverText !== undefined ||
    input.body !== undefined ||
    input.tags !== undefined ||
    input.imagePlan !== undefined ||
    input.visualStyle !== undefined;
  const next = {
    ...current,
    ...input,
    unsupportedClaims: textChanged ? [] : current.unsupportedClaims,
    riskNotes: textChanged
      ? [...current.riskNotes, "人工编辑后已清空旧的未支持事实标记，审核通过前需要重新核对正文事实。"]
      : current.riskNotes,
    publishStatus: "not_published" as ContentPublishStatus,
    publishedUrl: undefined,
    publishError: undefined,
    status: "needs_revision" as ContentDraftStatus
  };
  return saveContentDraft(db, next);
}

export function updateContentDraftPublishState(
  db: Db,
  draftId: number,
  fields: { publishStatus: ContentPublishStatus; publishedUrl?: string | null; publishError?: string | null }
): ContentDraft {
  const changes = db
    .prepare(
      `
        UPDATE content_drafts
        SET publish_status = ?, published_url = ?, publish_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    )
    .run(fields.publishStatus, fields.publishedUrl ?? null, fields.publishError ?? null, draftId).changes;
  if (!changes) throw new Error(`Content draft ${draftId} not found.`);
  return getContentDraftById(db, draftId);
}

function getContentProject(db: Db, id: number): ContentProject {
  const row = db.prepare("SELECT * FROM content_projects WHERE id = ?").get(id);
  if (!row) throw new Error(`Content project ${id} not found.`);
  return projectFromRow(row);
}

function listContentSources(db: Db, projectId: number): ContentSource[] {
  return db
    .prepare("SELECT * FROM content_sources WHERE project_id = ? ORDER BY id ASC")
    .all(projectId)
    .map(sourceFromRow);
}

function listWebResearchSources(db: Db, projectId: number): WebResearchSource[] {
  return db
    .prepare("SELECT * FROM web_research_sources WHERE project_id = ? ORDER BY id ASC")
    .all(projectId)
    .map(webSourceFromRow);
}

function listContentEvents(db: Db, projectId: number): ContentEvent[] {
  return db
    .prepare("SELECT * FROM content_events WHERE project_id = ? ORDER BY id ASC")
    .all(projectId)
    .map(eventFromRow);
}

function getContentDraft(db: Db, projectId: number): ContentDraft | null {
  const row = db.prepare("SELECT * FROM content_drafts WHERE project_id = ?").get(projectId);
  return row ? draftFromRow(row) : null;
}

function normalizePersona(input: AccountPersonaInput): AccountPersona {
  return {
    name: input.name.trim() || "未命名账号",
    positioning: input.positioning.trim(),
    targetReaders: input.targetReaders.trim(),
    tone: input.tone.trim(),
    commonPhrases: splitList(input.commonPhrases),
    bannedPhrases: splitList(input.bannedPhrases),
    experienceBank: input.experienceBank.trim(),
    status: input.status === "paused" ? "paused" : "active"
  };
}

function splitList(value: string[] | string): string[] {
  const items = Array.isArray(value) ? value : value.split(/[|,，、\n]/);
  return items.map((item) => item.trim()).filter(Boolean);
}

function personaFromRow(raw: unknown): AccountPersona {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    name: String(row.name),
    positioning: String(row.positioning),
    targetReaders: String(row.target_readers),
    tone: String(row.tone),
    commonPhrases: parseJsonArray(row.common_phrases_json),
    bannedPhrases: parseJsonArray(row.banned_phrases_json),
    experienceBank: String(row.experience_bank ?? ""),
    status: row.status === "paused" ? "paused" : "active"
  };
}

function projectFromRow(raw: unknown): ContentProject {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    keyword: String(row.keyword),
    contentType: normalizeContentType(String(row.content_type)),
    status: normalizeProjectStatus(String(row.status)),
    researchSummary: String(row.research_summary ?? ""),
    personaSnapshot: row.persona_snapshot_json ? (JSON.parse(String(row.persona_snapshot_json)) as AccountPersona) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function sourceFromRow(raw: unknown): ContentSource {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    postId: String(row.post_id),
    url: String(row.url),
    title: String(row.title),
    snippet: String(row.snippet),
    author: row.author ? String(row.author) : undefined,
    likeCount: optionalNumber(row.like_count),
    commentCount: optionalNumber(row.comment_count),
    publishedAt: row.published_at ? String(row.published_at) : undefined,
    sourceAnalysis: String(row.source_analysis ?? ""),
    heatScore: optionalNumber(row.heat_score),
    heatReason: String(row.heat_reason ?? ""),
    detailError: row.detail_error ? String(row.detail_error) : undefined,
    status: row.status === "detail_missing" ? "detail_missing" : "ok"
  };
}

function eventFromRow(raw: unknown): ContentEvent {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    level: normalizeEventLevel(String(row.level)),
    stage: String(row.stage),
    message: String(row.message),
    metadata: parseJsonObject(row.metadata_json, {}),
    createdAt: String(row.created_at)
  };
}

function webSourceFromRow(raw: unknown): WebResearchSource {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    query: String(row.query),
    title: String(row.title),
    url: String(row.url),
    snippet: String(row.snippet),
    extractedText: String(row.extracted_text ?? ""),
    status: normalizeWebStatus(String(row.status)),
    error: row.error ? String(row.error) : undefined
  };
}

function draftFromRow(raw: unknown): ContentDraft {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    titleCandidates: parseJsonArray(row.title_candidates_json),
    coverText: String(row.cover_text ?? ""),
    body: String(row.body ?? ""),
    tags: parseJsonArray(row.tags_json),
    imagePlan: parseJsonArray(row.image_plan_json),
    visualStyle: String(row.visual_style ?? ""),
    personaFit: String(row.persona_fit ?? ""),
    humanVoiceReview: parseJsonObject(row.human_voice_review_json, {
      passed: true,
      issues: [],
      revisionNotes: []
    }),
    originalityCheck: parseJsonObject(row.originality_check_json, {
      reusedAngles: [],
      uniqueAngle: "",
      riskNotes: []
    }),
    factualClaims: parseJsonArray(row.factual_claims_json),
    sourceRefs: parseJsonArray(row.source_refs_json),
    unsupportedClaims: parseJsonArray(row.unsupported_claims_json),
    riskNotes: parseJsonArray(row.risk_notes_json),
    imagePaths: parseJsonArray(row.image_paths_json),
    publishStatus: normalizePublishStatus(String(row.publish_status)),
    publishedUrl: row.published_url ? String(row.published_url) : undefined,
    publishError: row.publish_error ? String(row.publish_error) : undefined,
    status: DRAFT_STATUSES.has(String(row.status) as ContentDraftStatus)
      ? (String(row.status) as ContentDraftStatus)
      : "drafted",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T>(value: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function optionalNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function normalizeContentType(value: string): ContentType {
  return ["auto", "news", "opinion", "guide", "tips", "list", "case"].includes(value)
    ? (value as ContentType)
    : "auto";
}

function normalizeProjectStatus(value: string): ContentProjectStatus {
  return value === "drafted" || value === "failed" ? value : "running";
}

function normalizeWebStatus(value: string): WebResearchSource["status"] {
  if (value === "failed" || value === "skipped") return value;
  return "ok";
}

function normalizePublishStatus(value: string): ContentPublishStatus {
  if (value === "publishing" || value === "published" || value === "failed") return value;
  return "not_published";
}

function normalizeEventLevel(value: string): ContentEvent["level"] {
  if (value === "warn" || value === "error") return value;
  return "info";
}
