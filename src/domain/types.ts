export type QueueStatus =
  | "new"
  | "drafted"
  | "posted_by_user"
  | "posted_via_mcp"
  | "skipped";

export type RunSlot = "morning" | "noon" | "evening" | "manual";

export type NoteStatus = "active" | "paused";

export type ContentType = "auto" | "news" | "opinion" | "guide" | "tips" | "list" | "case";

export type ContentProjectStatus = "running" | "drafted" | "failed";

export type ContentDraftStatus = "drafted" | "approved" | "rejected" | "needs_revision";

export type ContentPublishStatus = "not_published" | "publishing" | "published" | "failed";

export interface Note {
  id?: number;
  title: string;
  url: string;
  summary: string;
  keywords: string[];
  scenarios: string[];
  status: NoteStatus;
}

export interface XhsPost {
  id: string;
  url: string;
  title: string;
  snippet: string;
  author?: string;
  xsecToken?: string;
  likeCount?: number;
  commentCount?: number;
  publishedAt?: string;
}

export interface ScoredPost extends XhsPost {
  score: number;
  matchedKeywords: string[];
  reason: string;
}

export interface DraftedInteraction {
  post: ScoredPost;
  note: Note | null;
  comment: string;
  status: QueueStatus;
}

export interface RunRecord {
  id: number;
  slot: RunSlot;
  createdAt: string;
  queryPack: string[];
  outputMarkdownPath?: string;
  outputCsvPath?: string;
}

export interface AccountPersona {
  id?: number;
  name: string;
  positioning: string;
  targetReaders: string;
  tone: string;
  commonPhrases: string[];
  bannedPhrases: string[];
  experienceBank: string;
  status: "active" | "paused";
}

export interface ContentProject {
  id: number;
  keyword: string;
  contentType: ContentType;
  status: ContentProjectStatus;
  researchSummary: string;
  personaSnapshot: AccountPersona | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentSource {
  id?: number;
  projectId: number;
  postId: string;
  url: string;
  title: string;
  snippet: string;
  author?: string;
  likeCount?: number;
  commentCount?: number;
  publishedAt?: string;
  sourceAnalysis: string;
  heatScore?: number;
  heatReason?: string;
  detailError?: string;
  status: "ok" | "detail_missing";
}

export interface WebResearchSource {
  id?: number;
  projectId: number;
  query: string;
  title: string;
  url: string;
  snippet: string;
  extractedText: string;
  status: "ok" | "failed" | "skipped";
  error?: string;
}

export interface ContentDraft {
  id?: number;
  projectId: number;
  titleCandidates: string[];
  coverText: string;
  body: string;
  tags: string[];
  imagePlan: string[];
  visualStyle: string;
  personaFit: string;
  humanVoiceReview: {
    passed: boolean;
    issues: string[];
    revisionNotes: string[];
  };
  originalityCheck: {
    reusedAngles: string[];
    uniqueAngle: string;
    riskNotes: string[];
  };
  factualClaims: string[];
  sourceRefs: string[];
  unsupportedClaims: string[];
  riskNotes: string[];
  imagePaths: string[];
  publishStatus: ContentPublishStatus;
  publishedUrl?: string;
  publishError?: string;
  status: ContentDraftStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentEvent {
  id?: number;
  projectId: number;
  level: "info" | "warn" | "error";
  stage: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}
