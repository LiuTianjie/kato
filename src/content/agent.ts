import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { ContentSource, ContentType, XhsPost } from "../domain/types.js";
import { createXhsAdapter } from "../adapters/xhsMcp.js";
import type { OperationLogger } from "../operations/logger.js";
import { silentLogger } from "../operations/logger.js";
import { generateContentDraft } from "./draftProvider.js";
import {
  createContentProject,
  getActivePersona,
  getContentProjectDetail,
  saveContentEvent,
  saveContentDraft,
  saveContentSource,
  saveWebResearchSource,
  updateContentProject
} from "./repository.js";
import { createWebResearchProvider, shouldUseWebResearch } from "./webResearch.js";

export interface ContentAgentOptions {
  keyword: string;
  contentType?: ContentType;
  sourceLimit?: number;
  logger?: OperationLogger;
}

export interface ContentAgentResult {
  projectId: number;
  sourceCount: number;
  webSourceCount: number;
  draftId: number | null;
}

export async function runContentAgent(
  db: Db,
  config: AppConfig,
  options: ContentAgentOptions
): Promise<ContentAgentResult> {
  const keyword = options.keyword.trim();
  if (!keyword) throw new Error("请输入内容生产关键词。");
  const contentType = options.contentType ?? "auto";
  const logger = options.logger ?? silentLogger;
  const persona = getActivePersona(db);
  const project = createContentProject(db, { keyword, contentType, personaSnapshot: persona });

  try {
    logger.log(`内容项目 ${project.id}：搜索小红书同类选题「${keyword}」`);
    recordEvent(db, project.id, "info", "xhs_search", `搜索小红书同类选题「${keyword}」`, { keyword });
    const sources = await collectXhsSources(db, config, project.id, keyword, sourceLimit(options.sourceLimit), logger);
    logger.log(`内容项目 ${project.id}：沉淀 ${sources.length} 条小红书参考来源`);
    recordEvent(db, project.id, "info", "xhs_search", `沉淀 ${sources.length} 条小红书参考来源`, {
      sourceCount: sources.length
    });

    if (shouldUseWebResearch(contentType)) {
      logger.log(`内容项目 ${project.id}：启动 Chrome 网页辅助调研`);
      recordEvent(db, project.id, "info", "web_research", "启动网页辅助调研", {
        query: `${keyword} 最新 经验 指南`
      });
      const webProvider = createWebResearchProvider(config);
      const webSources = await webProvider.research({
        projectId: project.id,
        query: `${keyword} 最新 经验 指南`,
        limit: 3
      });
      webSources.forEach((source) => saveWebResearchSource(db, source));
      logger.log(`内容项目 ${project.id}：网页辅助资料 ${webSources.length} 条`);
      webSources.forEach((source) =>
        recordEvent(db, project.id, source.status === "failed" ? "warn" : "info", "web_research", source.title, {
          status: source.status,
          url: source.url,
          error: source.error
        })
      );
    } else {
      saveWebResearchSource(db, {
        projectId: project.id,
        query: keyword,
        title: "网页调研未触发",
        url: "",
        snippet: "当前内容类型不需要网页辅助调研。",
        extractedText: "",
        status: "skipped"
      });
      recordEvent(db, project.id, "info", "web_research", "当前内容类型未触发网页辅助调研", { contentType });
    }

    const detail = getContentProjectDetail(db, project.id);
    const researchSummary = buildResearchSummary(keyword, detail.sources, detail.webSources);
    updateContentProject(db, project.id, { researchSummary });
    logger.log(`内容项目 ${project.id}：生成证据约束图文草稿`);
    recordEvent(db, project.id, "info", "draft_generation", "生成证据约束图文草稿", {
      sourceCount: detail.sources.length,
      webSourceCount: detail.webSources.length
    });
    const draft = await generateContentDraft({
      projectId: project.id,
      keyword,
      contentType,
      persona,
      sources: detail.sources,
      webSources: detail.webSources,
      researchSummary
    });
    const savedDraft = saveContentDraft(db, draft);
    recordEvent(
      db,
      project.id,
      savedDraft.unsupportedClaims.length ? "warn" : "info",
      "draft_generation",
      savedDraft.unsupportedClaims.length
        ? `草稿含 ${savedDraft.unsupportedClaims.length} 条未支持事实，需要修改后审核`
        : "草稿已生成，等待人工审核",
      {
        status: savedDraft.status,
        factualClaims: savedDraft.factualClaims.length,
        unsupportedClaims: savedDraft.unsupportedClaims.length
      }
    );
    updateContentProject(db, project.id, { status: "drafted", researchSummary });
    logger.log(`内容项目 ${project.id}：草稿已生成，等待人工审核`);
    return {
      projectId: project.id,
      sourceCount: detail.sources.length,
      webSourceCount: detail.webSources.length,
      draftId: savedDraft.id ?? null
    };
  } catch (error) {
    updateContentProject(db, project.id, {
      status: "failed",
      researchSummary: `内容生产失败：${error instanceof Error ? error.message : String(error)}`
    });
    recordEvent(db, project.id, "error", "failed", "内容生产失败", { error: errorMessage(error) });
    throw error;
  }
}

async function collectXhsSources(
  db: Db,
  config: AppConfig,
  projectId: number,
  keyword: string,
  limit: number,
  logger: OperationLogger
): Promise<ContentSource[]> {
  const adapter = createXhsAdapter(config);
  const seen = new Set<string>();
  const candidates: ContentSource[] = [];
  try {
    const posts = await adapter.searchPosts(keyword, Math.max(limit * 2, 10));
    const titleFrequency = buildTitleFrequency(posts);
    for (const post of posts) {
      logger.throwIfCancelled?.();
      const key = normalizeUrl(post.url);
      if (seen.has(key)) continue;
      seen.add(key);
      logger.log(`读取参考帖详情：${post.title || post.url}`);
      const detailResult = await tryGetPost(adapter, post);
      const detailed = detailResult.post ?? post;
      const heat = scoreSourceHeat(detailed, titleFrequency.get(titleKey(detailed.title)) ?? 1, Boolean(detailResult.post));
      const source = postToContentSource(
        projectId,
        detailed,
        detailResult.post ? "ok" : "detail_missing",
        heat.score,
        heat.reason,
        detailResult.error
      );
      candidates.push(source);
    }
  } finally {
    await adapter.close?.();
  }
  const selected = candidates.sort((a, b) => (b.heatScore ?? 0) - (a.heatScore ?? 0)).slice(0, limit);
  selected.forEach((source) => saveContentSource(db, source));
  return selected;
}

async function tryGetPost(
  adapter: ReturnType<typeof createXhsAdapter>,
  post: XhsPost
): Promise<{ post: XhsPost | null; error?: string }> {
  try {
    return { post: await adapter.getPost(post) };
  } catch (error) {
    return { post: null, error: errorMessage(error) };
  }
}

function postToContentSource(
  projectId: number,
  post: XhsPost,
  status: ContentSource["status"],
  heatScore: number,
  heatReason: string,
  detailError?: string
): ContentSource {
  return {
    projectId,
    postId: post.id || post.url,
    url: post.url,
    title: post.title,
    snippet: post.snippet,
    author: post.author,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    publishedAt: post.publishedAt,
    sourceAnalysis: analyzeSource(post),
    heatScore,
    heatReason,
    detailError,
    status
  };
}

function scoreSourceHeat(post: XhsPost, repetition: number, hasDetail: boolean): { score: number; reason: string } {
  const likes = post.likeCount ?? 0;
  const comments = post.commentCount ?? 0;
  const engagementScore = Math.log10(1 + likes + comments * 2) * 10;
  const repetitionScore = Math.min(8, Math.max(0, repetition - 1) * 3);
  const detailScore = hasDetail ? 4 : -2;
  const score = Number((engagementScore + repetitionScore + detailScore).toFixed(2));
  const parts = [`赞 ${likes}`, `评 ${comments}`];
  if (repetition > 1) parts.push(`相近标题出现 ${repetition} 次`);
  parts.push(hasDetail ? "详情可读" : "详情缺失");
  return { score, reason: parts.join("；") };
}

function buildTitleFrequency(posts: XhsPost[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const post of posts) {
    const key = titleKey(post.title);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function titleKey(title: string): string {
  return title
    .replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, "")
    .slice(0, 8)
    .toLowerCase();
}

function recordEvent(
  db: Db,
  projectId: number,
  level: "info" | "warn" | "error",
  stage: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  try {
    saveContentEvent(db, { projectId, level, stage, message, metadata });
  } catch {
    // Event recording must not interrupt the content workflow.
  }
}

function analyzeSource(post: XhsPost): string {
  const heat = (post.likeCount ?? 0) + (post.commentCount ?? 0) * 2;
  const parts = [`主题：${post.title || post.snippet.slice(0, 30)}`];
  if (heat > 100) parts.push("互动热度较高，说明选题有讨论空间");
  if (post.snippet.length > 40) parts.push("摘要信息量足，可提炼痛点和表达方式");
  if (post.author) parts.push(`账号来源：${post.author}`);
  return parts.join("；");
}

function buildResearchSummary(keyword: string, sources: ContentSource[], webSources: Array<{ title: string; status: string }>): string {
  const repeatedAngles = sources
    .map((source) => source.title)
    .filter(Boolean)
    .slice(0, 5)
    .join("；");
  const usefulWeb = webSources.filter((source) => source.status === "ok").length;
  return [
    `关键词「${keyword}」共参考 ${sources.length} 篇小红书同类帖子。`,
    sources.length
      ? `热度最高来源：${sources
          .slice(0, 3)
          .map((source) => `${source.title || "未命名"}（${source.heatReason || "无热度说明"}）`)
          .join("；")}。`
      : "暂无可用热度来源。",
    repeatedAngles ? `同类内容集中在：${repeatedAngles}。` : "同类内容标题信息不足，需要人工补充判断。",
    usefulWeb ? `网页辅助资料 ${usefulWeb} 条可用。` : "网页辅助资料未启用或暂无可用结果。",
    "生成笔记时事实只能引用来源；个人判断可以表达，但不能补写不存在的亲身经历。"
  ].join("\n");
}

function sourceLimit(value: number | undefined): number {
  const raw = Number(value ?? 8);
  if (!Number.isFinite(raw)) return 8;
  return Math.max(5, Math.min(10, Math.floor(raw)));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
