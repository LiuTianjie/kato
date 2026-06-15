import type { Db } from "../db/client.js";

const ACTIVE_QUEUE_STATUSES = ["new", "drafted"];
const INTERACTED_STATUSES = ["posted_by_user", "posted_via_mcp"];

export interface DashboardStats {
  totals: {
    posts: number;
    runs: number;
    interactions: number;
    drafted: number;
    posted: number;
    skipped: number;
  };
  rates: {
    publishRate: number;
  };
  statusCounts: Array<{ status: string; count: number }>;
  recentRuns: unknown[];
  recentInteractions: unknown[];
  dailyActivity: unknown[];
  topNotes: unknown[];
  topKeywords: Array<{ keyword: string; count: number }>;
}

export function getDashboardStats(db: Db): DashboardStats {
  const totals = {
    posts: count(db, "SELECT COUNT(*) AS count FROM posts"),
    runs: count(db, "SELECT COUNT(*) AS count FROM runs"),
    interactions: count(db, "SELECT COUNT(*) AS count FROM interactions"),
    drafted: count(db, "SELECT COUNT(*) AS count FROM interactions WHERE status = 'drafted'"),
    posted: count(
      db,
      "SELECT COUNT(*) AS count FROM interactions WHERE status IN ('posted_by_user', 'posted_via_mcp')"
    ),
    skipped: count(db, "SELECT COUNT(*) AS count FROM interactions WHERE status = 'skipped'")
  };

  const statusCounts = db
    .prepare("SELECT status, COUNT(*) AS count FROM interactions GROUP BY status ORDER BY count DESC")
    .all();

  return {
    totals,
    rates: {
      publishRate: percentage(totals.posted, totals.interactions)
    },
    statusCounts: statusCounts as Array<{ status: string; count: number }>,
    recentRuns: getRecentRuns(db, 12),
    recentInteractions: getInteractions(db, { status: "all", limit: 80 }),
    dailyActivity: db
      .prepare(
        `
          SELECT
            date(created_at) AS day,
            COUNT(*) AS drafted,
            SUM(CASE WHEN status IN ('posted_by_user', 'posted_via_mcp') THEN 1 ELSE 0 END) AS posted
          FROM interactions
          GROUP BY date(created_at)
          ORDER BY day DESC
          LIMIT 14
        `
      )
      .all(),
    topNotes: db
      .prepare(
        `
          SELECT
            COALESCE(n.title, '未匹配笔记') AS title,
            COUNT(*) AS count,
            SUM(CASE WHEN i.status IN ('posted_by_user', 'posted_via_mcp') THEN 1 ELSE 0 END) AS posted
          FROM interactions i
          LEFT JOIN notes n ON n.id = i.note_id
          GROUP BY n.id
          ORDER BY count DESC
          LIMIT 8
        `
      )
      .all(),
    topKeywords: getTopKeywords(db)
  };
}

export function getRecentRuns(db: Db, limit: number): unknown[] {
  return db
    .prepare(
      `
        SELECT
          r.id,
          r.slot,
          r.created_at,
          r.output_markdown_path,
          r.output_csv_path,
          COUNT(i.id) AS total,
          SUM(CASE WHEN i.status = 'drafted' THEN 1 ELSE 0 END) AS drafted,
          SUM(CASE WHEN i.status IN ('posted_by_user', 'posted_via_mcp') THEN 1 ELSE 0 END) AS posted,
          SUM(CASE WHEN i.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
        FROM runs r
        LEFT JOIN interactions i ON i.run_id = r.id
        GROUP BY r.id
        ORDER BY r.id DESC
        LIMIT ?
      `
    )
    .all(limit);
}

export function getInteractions(
  db: Db,
  options: { runId?: number; status?: string; limit?: number } = {}
): unknown[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.runId) {
    where.push("i.run_id = ?");
    params.push(options.runId);
  }
  const status = options.status ?? "active";
  if (status === "active") {
    where.push(`i.status IN (${ACTIVE_QUEUE_STATUSES.map(() => "?").join(", ")})`);
    params.push(...ACTIVE_QUEUE_STATUSES);
  } else if (status === "interacted") {
    where.push(`i.status IN (${INTERACTED_STATUSES.map(() => "?").join(", ")})`);
    params.push(...INTERACTED_STATUSES);
  } else if (status !== "all") {
    where.push("i.status = ?");
    params.push(status);
  }
  params.push(options.limit ?? 120);

  const rows = db
    .prepare(
      `
        SELECT
          i.id,
          i.run_id,
          i.status,
          i.score,
          i.reason,
          i.draft_comment,
          i.created_at,
          i.updated_at,
          p.id AS post_id,
          p.url AS post_url,
          p.title AS post_title,
          p.snippet AS post_snippet,
          p.author,
          p.like_count,
          p.comment_count,
          p.xsec_token,
          n.title AS note_title,
          n.url AS note_url
        FROM interactions i
        JOIN posts p ON p.id = i.post_id
        LEFT JOIN notes n ON n.id = i.note_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY i.id DESC
        LIMIT ?
      `
    )
    .all(...params);
  return rows.map(normalizeInteractionRowUrls);
}

export function updateInteractionStatus(db: Db, ids: number[], status: string): number {
  const allowed = new Set(["drafted", "posted_by_user", "posted_via_mcp", "skipped"]);
  if (!allowed.has(status)) throw new Error(`Invalid status: ${status}`);
  const statement = db.prepare("UPDATE interactions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  return ids.reduce((sum, id) => sum + statement.run(status, id).changes, 0);
}

export function updateInteractionDraft(db: Db, id: number, draftComment: string): number {
  return db
    .prepare("UPDATE interactions SET draft_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(draftComment, id).changes;
}

function count(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  return Number(row.count ?? 0);
}

function percentage(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function normalizeInteractionRowUrls(row: unknown): unknown {
  const record = row as Record<string, unknown>;
  return {
    ...record,
    post_url: normalizeXhsUrl(record.post_url, record.post_id, record.xsec_token)
  };
}

function normalizeXhsUrl(rawUrl: unknown, rawId: unknown, rawToken: unknown): string {
  const id = String(rawId ?? "").trim();
  const token = String(rawToken ?? "").trim();
  const fallback = buildXhsUrl(id, token);
  const value = String(rawUrl ?? "").trim();
  if (!value) return fallback;
  try {
    const url = new URL(normalizeUrlCandidate(value));
    if (token && isXhsExploreUrl(url) && !url.searchParams.get("xsec_token")) {
      url.searchParams.set("xsec_token", token);
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

function buildXhsUrl(id: string, token: string): string {
  const url = new URL(`https://www.xiaohongshu.com/explore/${encodeURIComponent(id || "unknown")}`);
  if (token) url.searchParams.set("xsec_token", token);
  return url.toString();
}

function normalizeUrlCandidate(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://www.xiaohongshu.com${value}`;
  if (/^(www\.)?xiaohongshu\.com(\/|$)/i.test(value)) return `https://${value}`;
  return value;
}

function isXhsExploreUrl(url: URL): boolean {
  return /(^|\.)xiaohongshu\.com$/i.test(url.hostname) && url.pathname.split("/").includes("explore");
}

function getTopKeywords(db: Db): Array<{ keyword: string; count: number }> {
  const rows = db.prepare("SELECT matched_keywords_json FROM posts").all() as Array<{ matched_keywords_json: string }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const keywords = JSON.parse(row.matched_keywords_json || "[]") as string[];
    for (const keyword of keywords) {
      counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([keyword, value]) => ({ keyword, count: value }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}
