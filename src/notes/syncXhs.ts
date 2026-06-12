import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { OperationLogger } from "../operations/logger.js";
import { silentLogger } from "../operations/logger.js";
import { saveNote } from "./repository.js";

interface SyncFeed {
  id: string;
  xsecToken?: string;
  title: string;
  snippet: string;
  url: string;
}

export async function syncMyXhsNotes(
  db: Db,
  config: AppConfig,
  options: { limit?: number; logger?: OperationLogger } = {}
): Promise<{ imported: number; skipped: number; profileName?: string }> {
  const logger = options.logger ?? silentLogger;
  const base = getMcpBaseUrl(config);
  logger.log("MCP 获取当前登录账号主页");
  const profile = await fetchJson(`${base}/api/v1/user/me`);
  const data = unwrapData(profile);
  const profileName = String(
    getByPath(data, ["userBasicInfo", "nickname"]) ??
      getByPath(data, ["basicInfo", "nickname"]) ??
      getByPath(data, ["data", "userBasicInfo", "nickname"]) ??
      ""
  );
  const feeds = extractFeeds(data).slice(0, options.limit ?? 30);
  logger.log(`主页账号：${profileName || "未知"}，发现 ${feeds.length} 条笔记`);

  let imported = 0;
  let skipped = 0;
  for (const feed of feeds) {
    if (!feed.title || !feed.url) {
      logger.log(`跳过无标题笔记：${feed.id}`);
      skipped += 1;
      continue;
    }

    logger.log(`MCP 读取我的笔记详情：${feed.title}`);
    const detail = feed.xsecToken ? await tryFetchFeedDetail(base, feed, logger) : null;
    const summary = normalizeSummary(detail?.snippet || feed.snippet || feed.title);
    saveNote(db, {
      title: detail?.title || feed.title,
      url: feed.url,
      summary,
      keywords: extractKeywords(`${detail?.title || feed.title} ${summary}`),
      scenarios: ["可在相关话题下自然补充经验", "有人讨论类似方法或踩坑时引用"],
      status: "active"
    });
    logger.log(`已同步笔记：${detail?.title || feed.title}`);
    imported += 1;
  }

  return { imported, skipped, profileName: profileName || undefined };
}

async function tryFetchFeedDetail(base: string, feed: SyncFeed, logger: OperationLogger): Promise<SyncFeed | null> {
  try {
    const response = await fetch(`${base}/api/v1/feeds/detail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feed_id: feed.id,
        xsec_token: feed.xsecToken,
        load_all_comments: false,
        comment_config: { max_comment_items: 0, scroll_speed: "normal" }
      })
    });
    if (!response.ok) {
      logger.log(`读取详情失败：HTTP ${response.status}`);
      return null;
    }
    return extractFeedDetail(await response.json(), feed);
  } catch (error) {
    logger.log(`读取详情失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`同步小红书笔记失败：HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

function getMcpBaseUrl(config: AppConfig): string {
  return config.xhs.mcp?.url ? new URL(config.xhs.mcp.url).origin : "http://localhost:18060";
}

function unwrapData(value: unknown): Record<string, unknown> {
  let current = value as Record<string, unknown>;
  while (current?.data && typeof current.data === "object" && !Array.isArray(current.data)) {
    current = current.data as Record<string, unknown>;
  }
  return current ?? {};
}

function extractFeeds(value: unknown): SyncFeed[] {
  const data = value as Record<string, unknown>;
  const feeds =
    getByPath(data, ["feeds"]) ??
    getByPath(data, ["data", "feeds"]) ??
    getByPath(data, ["data", "data", "feeds"]) ??
    [];
  if (!Array.isArray(feeds)) return [];
  return feeds.map(normalizeFeed).filter((feed): feed is SyncFeed => Boolean(feed));
}

function normalizeFeed(raw: unknown): SyncFeed | null {
  const item = raw as Record<string, unknown>;
  const noteCard = item.noteCard as Record<string, unknown> | undefined;
  const id = String(item.id ?? "");
  if (!id) return null;
  const xsecToken = String(item.xsecToken ?? item.xsec_token ?? "");
  const title = String(item.title ?? noteCard?.displayTitle ?? "");
  const snippet = String(item.snippet ?? item.desc ?? noteCard?.displayTitle ?? title);
  return {
    id,
    xsecToken: xsecToken || undefined,
    title,
    snippet,
    url: buildXhsUrl(id, xsecToken)
  };
}

function extractFeedDetail(value: unknown, fallback: SyncFeed): SyncFeed | null {
  const data = unwrapData(value);
  const note = (data.note ?? getByPath(data, ["data", "note"])) as Record<string, unknown> | undefined;
  if (!note) return fallback;
  const id = String(note.noteId ?? fallback.id);
  const xsecToken = String(note.xsecToken ?? fallback.xsecToken ?? "");
  return {
    id,
    xsecToken: xsecToken || undefined,
    title: String(note.title ?? fallback.title),
    snippet: String(note.desc ?? fallback.snippet),
    url: buildXhsUrl(id, xsecToken)
  };
}

function normalizeSummary(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 260 ? `${compact.slice(0, 257)}...` : compact || "同步自我的小红书笔记";
}

function extractKeywords(value: string): string[] {
  const matches = value.match(/[A-Za-z0-9+#.-]{2,}|[\u4e00-\u9fa5]{2,8}/g) ?? [];
  return [...new Set(matches)]
    .filter((item) => !/^(这个|一个|我的|小红书|笔记|分享|方法|经验)$/.test(item))
    .slice(0, 8);
}

function buildXhsUrl(id: string, xsecToken?: string): string {
  const url = new URL(`https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}`);
  if (xsecToken) url.searchParams.set("xsec_token", xsecToken);
  return url.toString();
}

function getByPath(value: unknown, path: string[]): unknown {
  let current = value as Record<string, unknown> | undefined;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key] as Record<string, unknown> | undefined;
  }
  return current;
}
