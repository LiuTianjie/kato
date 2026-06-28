import type { AccountPersona, ContentDraft, ContentSource, ContentType, WebResearchSource } from "../domain/types.js";
import { callArk, canUseArk as canUseArkClient, parseArkJson } from "../llm/arkClient.js";

export interface ContentDraftInput {
  projectId: number;
  keyword: string;
  contentType: ContentType;
  persona: AccountPersona | null;
  sources: ContentSource[];
  webSources: WebResearchSource[];
  researchSummary: string;
}

export async function generateContentDraft(input: ContentDraftInput): Promise<ContentDraft> {
  const draft = canUseArk() ? await generateWithArk(input) : generateLocalDraft(input);
  const reviewed = reviewHumanVoice(draft, input.persona);
  if (reviewed.humanVoiceReview.passed) return reviewed;
  return reviseDraftOnce(reviewed, input);
}

export function parseContentDraftJson(value: string, projectId: number): ContentDraft {
  const parsed = parseArkJson<Partial<ContentDraft>>(value, "Content agent");
  return normalizeDraft(projectId, parsed);
}

function canUseArk(): boolean {
  return canUseArkClient("content");
}

async function generateWithArk(input: ContentDraftInput): Promise<ContentDraft> {
  const content = await callArk(
    [
      {
        role: "system",
        content:
          "你是小红书图文笔记创作者。你必须基于给定来源写作：事实只能来自来源，个人观点可以表达，但不能虚构亲身经历、数据、案例或结论。只输出严格 JSON，不要 Markdown。"
      },
      {
        role: "user",
        content: [
          `关键词：${input.keyword}`,
          `内容类型：${input.contentType}`,
          "账号人设：",
          JSON.stringify(input.persona ?? { warning: "未配置账号人设" }, null, 2),
          "小红书参考来源：",
          JSON.stringify(
            input.sources.map((source) => ({
              title: source.title,
              snippet: source.snippet,
              author: source.author,
              likeCount: source.likeCount,
              commentCount: source.commentCount,
              heatScore: source.heatScore,
              heatReason: source.heatReason,
              analysis: source.sourceAnalysis
            })),
            null,
            2
          ),
          "网页辅助资料：",
          JSON.stringify(
            input.webSources.map((source) => ({
              title: source.title,
              snippet: source.snippet,
              extractedText: source.extractedText.slice(0, 700),
              status: source.status
            })),
            null,
            2
          ),
          `研究摘要：${input.researchSummary}`,
          "返回 JSON 字段：titleCandidates:string[]、coverText:string、body:string、tags:string[]、imagePlan:string[]、visualStyle:string、personaFit:string、humanVoiceReview:{passed:boolean,issues:string[],revisionNotes:string[]}、originalityCheck:{reusedAngles:string[],uniqueAngle:string,riskNotes:string[]}、factualClaims:string[]、sourceRefs:string[]、unsupportedClaims:string[]、riskNotes:string[]。",
          "正文要求：像真人表达，但不要写没有来源的亲身经历。可以写'我的判断是'这类观点；所有具体事实、产品能力、数据、趋势判断必须能在 factualClaims 中列出，并在 sourceRefs 中用来源标题或 URL 标注出处。无法确认的事实必须放入 unsupportedClaims，不要硬写。"
        ].join("\n")
      }
    ],
    { modelKind: "content", temperature: 0.78, maxTokens: 1800, label: "Ark content generation" }
  );
  return parseContentDraftJson(content, input.projectId);
}

function generateLocalDraft(input: ContentDraftInput): ContentDraft {
  const topSources = input.sources.slice(0, 3);
  const personaName = input.persona?.name || "这个账号";
  const positioning = input.persona?.positioning || "长期观察效率工具和内容工作流";
  const uniqueAngle = buildUniqueAngle(input);
  const body = [
    `最近看 ${input.keyword} 相关内容时，一个明显信号是：高互动帖子通常不是只讲概念，而是把问题落到具体场景里。`,
    "",
    topSources.length
      ? `这次参考里热度靠前的是：${topSources.map((item) => item.title).join("、")}。这些标题说明，读者会对具体工具、真实落地和可执行步骤更敏感。`
      : "这类话题很容易写成清单，但清单本身解决不了落地问题。",
    "",
    `我的判断是：${uniqueAngle}`,
    "",
    "我的建议是先从一个很小的动作开始：把每天最重复、最不想做、但又必须做的环节列出来，只改其中一步。这个建议是基于上面来源里的共性问题，不代表我已经逐一测试过所有方案。",
    "",
    `如果更在意“能不能坚持用”，那比起追新工具，更值得关注的是：这个流程是不是够短、是不是能留下记录、失败后是不是容易重启。`
  ].join("\n");
  const factualClaims = topSources.map((item) => `参考来源提到「${item.title}」这个角度，互动信号为：${item.heatReason || "暂无热度说明"}`);

  return {
    projectId: input.projectId,
    titleCandidates: [
      `${input.keyword}别只收藏，先跑通这一步`,
      `我会这样判断一个${input.keyword}方案值不值得用`,
      `${input.keyword}真正卡住的不是工具`
    ],
    coverText: `${input.keyword}\n先别急着收藏`,
    body,
    tags: dedupe(["小红书运营", input.keyword, "效率工具", "真实体验"]).slice(0, 6),
    imagePlan: ["首图用一句反常识判断做封面", "第二张列出同类内容的重复角度", "第三张给一个最小可执行流程"],
    visualStyle: "干净的工作台截图感，少装饰，重点突出封面判断句",
    personaFit: input.persona ? `按「${personaName}」的人设写，贴近${positioning}。` : "未配置账号人设，已使用偏真实经验的默认口吻。",
    humanVoiceReview: { passed: true, issues: [], revisionNotes: [] },
    originalityCheck: {
      reusedAngles: topSources.map((item) => item.title).slice(0, 3),
      uniqueAngle,
      riskNotes: ["本地兜底草稿未调用模型，建议人工再补一段真实经历。"]
    },
    factualClaims,
    sourceRefs: topSources.map((item) => `${item.title} ${item.url}`),
    unsupportedClaims: [],
    riskNotes: ["本地兜底只基于来源标题、摘要和热度信号生成，发布前需要人工核对具体产品细节。"],
    imagePaths: [],
    publishStatus: "not_published",
    status: "drafted"
  };
}

function reviewHumanVoice(draft: ContentDraft, persona: AccountPersona | null): ContentDraft {
  const issues: string[] = [];
  const banned = [
    "作为一个AI",
    "本文将",
    "以下是",
    "综上所述",
    "总而言之",
    "不容错过",
    "赶快收藏",
    "保姆级",
    "天花板"
  ];
  for (const word of banned) {
    if (draft.body.includes(word) || draft.titleCandidates.some((title) => title.includes(word))) {
      issues.push(`包含高 AI 感或营销化表达：${word}`);
    }
  }
  for (const word of persona?.bannedPhrases ?? []) {
    if (word && draft.body.includes(word)) issues.push(`命中账号禁用表达：${word}`);
  }
  if (draft.body.length < 180) issues.push("正文偏短，像摘要而不是笔记。");
  if (!/[我]/.test(draft.body)) issues.push("缺少第一人称判断，容易像通用稿。");
  if ((draft.body.match(/[：:]/g) ?? []).length > 8) issues.push("结构符号过多，容易显得像模板。");
  if (draft.unsupportedClaims.length) issues.push("存在未被来源支持的事实，需修改或补充来源。");
  return {
    ...draft,
    humanVoiceReview: {
      passed: issues.length === 0,
      issues,
      revisionNotes: issues.length ? ["减少套话和列表感", "补入更具体的个人判断或使用场景"] : []
    }
  };
}

async function reviseDraftOnce(draft: ContentDraft, input: ContentDraftInput): Promise<ContentDraft> {
  if (!canUseArk()) return localRevise(draft);
  const content = await callArk(
    [
      {
        role: "system",
        content: "你是小红书内容编辑。把草稿改得更像真人账号本人，保留原意，只输出严格 JSON。"
      },
      {
        role: "user",
        content: [
          "账号人设：",
          JSON.stringify(input.persona ?? { warning: "未配置账号人设" }, null, 2),
          "需要修正的问题：",
          JSON.stringify(draft.humanVoiceReview.issues, null, 2),
          "原草稿：",
          JSON.stringify(draft, null, 2),
          "返回同样 JSON 结构。"
        ].join("\n")
      }
    ],
    { modelKind: "content", temperature: 0.78, maxTokens: 1800, label: "Ark content revision" }
  );
  return reviewHumanVoice(parseContentDraftJson(content, input.projectId), input.persona);
}

function localRevise(draft: ContentDraft): ContentDraft {
  const body = draft.body
    .replace(/本文将/g, "这次我想")
    .replace(/以下是/g, "我会先看")
    .replace(/综上所述|总而言之/g, "我的结论是")
    .replace(/赶快收藏|不容错过/g, "可以先试试");
  return reviewHumanVoice({ ...draft, body, status: draft.unsupportedClaims.length ? "needs_revision" : draft.status }, null);
}

function normalizeDraft(projectId: number, parsed: Partial<ContentDraft>): ContentDraft {
  return {
    projectId,
    titleCandidates: toStringArray(parsed.titleCandidates).slice(0, 6),
    coverText: String(parsed.coverText ?? ""),
    body: String(parsed.body ?? ""),
    tags: toStringArray(parsed.tags).slice(0, 10),
    imagePlan: toStringArray(parsed.imagePlan).slice(0, 8),
    visualStyle: String(parsed.visualStyle ?? ""),
    personaFit: String(parsed.personaFit ?? ""),
    humanVoiceReview: {
      passed: Boolean(parsed.humanVoiceReview?.passed),
      issues: toStringArray(parsed.humanVoiceReview?.issues),
      revisionNotes: toStringArray(parsed.humanVoiceReview?.revisionNotes)
    },
    originalityCheck: {
      reusedAngles: toStringArray(parsed.originalityCheck?.reusedAngles),
      uniqueAngle: String(parsed.originalityCheck?.uniqueAngle ?? ""),
      riskNotes: toStringArray(parsed.originalityCheck?.riskNotes)
    },
    factualClaims: toStringArray(parsed.factualClaims),
    sourceRefs: toStringArray(parsed.sourceRefs),
    unsupportedClaims: toStringArray(parsed.unsupportedClaims),
    riskNotes: toStringArray(parsed.riskNotes),
    imagePaths: toStringArray(parsed.imagePaths),
    publishStatus: "not_published",
    status: toStringArray(parsed.unsupportedClaims).length ? "needs_revision" : "drafted"
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function buildUniqueAngle(input: ContentDraftInput): string {
  if (input.persona?.experienceBank) {
    return `结合我自己的经验，先把 ${input.keyword} 放到一个具体工作流里验证，而不是只看推荐清单。`;
  }
  return `把 ${input.keyword} 写成“最小可执行流程”，比再做一份工具合集更有区分度。`;
}
