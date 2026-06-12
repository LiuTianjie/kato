import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { toCsvCell } from "../notes/csv.js";

interface QueueRow {
  interaction_id: number;
  status: string;
  score: number;
  reason: string;
  draft_comment: string;
  post_url: string;
  post_title: string;
  post_snippet: string;
  author: string | null;
  xsec_token: string | null;
  note_title: string | null;
  note_url: string | null;
}

export function exportRun(db: Db, config: AppConfig, runId: number): { markdownPath: string; csvPath: string } {
  const rows = db
    .prepare(`
      SELECT
        i.id AS interaction_id,
        i.status,
        i.score,
        i.reason,
        i.draft_comment,
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
      WHERE i.run_id = ?
      ORDER BY i.score DESC, i.id ASC
    `)
    .all(runId) as QueueRow[];

  const runDir = path.join(config.outputDir, "runs", String(runId));
  mkdirSync(runDir, { recursive: true });
  const markdownPath = path.join(runDir, "queue.md");
  const csvPath = path.join(runDir, "queue.csv");

  writeFileSync(markdownPath, toMarkdown(runId, rows), "utf8");
  writeFileSync(csvPath, toCsv(rows), "utf8");

  db.prepare("UPDATE runs SET output_markdown_path = ?, output_csv_path = ? WHERE id = ?").run(
    markdownPath,
    csvPath,
    runId
  );

  return { markdownPath, csvPath };
}

function toMarkdown(runId: number, rows: QueueRow[]): string {
  const lines = [`# 小红书互动队列 Run ${runId}`, "", `共 ${rows.length} 条。`, ""];
  for (const row of rows) {
    lines.push(`## ${row.interaction_id}. ${row.post_title}`);
    lines.push("");
    lines.push(`- 状态：${row.status}`);
    lines.push(`- 分数：${row.score}`);
    lines.push(`- 链接：${row.post_url}`);
    lines.push(`- 作者：${row.author ?? ""}`);
    lines.push(`- xsec_token：${row.xsec_token ? "已保存" : "无"}`);
    lines.push(`- 匹配理由：${row.reason}`);
    lines.push(`- 关联笔记：${row.note_title ?? "无"}${row.note_url ? ` (${row.note_url})` : ""}`);
    lines.push("");
    lines.push("评论草稿：");
    lines.push("");
    lines.push(`> ${row.draft_comment}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function toCsv(rows: QueueRow[]): string {
  const headers = [
    "interaction_id",
    "status",
    "score",
    "post_url",
    "post_title",
    "author",
    "xsec_token_saved",
    "reason",
    "note_title",
    "note_url",
    "draft_comment"
  ];
  const body = rows.map((row) =>
    [
      row.interaction_id,
      row.status,
      row.score,
      row.post_url,
      row.post_title,
      row.author,
      row.xsec_token ? "yes" : "no",
      row.reason,
      row.note_title,
      row.note_url,
      row.draft_comment
    ]
      .map(toCsvCell)
      .join(",")
  );
  return `${headers.join(",")}\n${body.join("\n")}\n`;
}
