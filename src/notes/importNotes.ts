import { readFileSync } from "node:fs";
import type { Db } from "../db/client.js";
import type { Note } from "../domain/types.js";
import { parseCsv } from "./csv.js";

export function importNotesFromCsv(db: Db, filePath: string): number {
  const records = parseCsv(readFileSync(filePath, "utf8"));
  let imported = 0;
  const statement = db.prepare(`
    INSERT INTO notes (title, url, summary, keywords_json, scenarios_json, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      keywords_json = excluded.keywords_json,
      scenarios_json = excluded.scenarios_json,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `);

  for (const record of records) {
    const note = recordToNote(record);
    statement.run(
      note.title,
      note.url,
      note.summary,
      JSON.stringify(note.keywords),
      JSON.stringify(note.scenarios),
      note.status
    );
    imported += 1;
  }

  return imported;
}

export function listActiveNotes(db: Db): Note[] {
  return db
    .prepare("SELECT * FROM notes WHERE status = 'active' ORDER BY updated_at DESC, id DESC")
    .all()
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: Number(row.id),
        title: String(row.title),
        url: String(row.url),
        summary: String(row.summary),
        keywords: JSON.parse(String(row.keywords_json)) as string[],
        scenarios: JSON.parse(String(row.scenarios_json)) as string[],
        status: row.status === "paused" ? "paused" : "active"
      };
    });
}

function recordToNote(record: Record<string, string>): Note {
  return {
    title: requireValue(record, "title"),
    url: requireValue(record, "url"),
    summary: requireValue(record, "summary"),
    keywords: splitList(record.keywords),
    scenarios: splitList(record.scenarios),
    status: record.status === "paused" ? "paused" : "active"
  };
}

function requireValue(record: Record<string, string>, key: string): string {
  const value = record[key]?.trim();
  if (!value) throw new Error(`Missing required note field: ${key}`);
  return value;
}

function splitList(value: string): string[] {
  return value
    .split(/[|,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
