import type { Db } from "../db/client.js";
import type { Note, NoteStatus } from "../domain/types.js";

export interface NoteInput {
  id?: number;
  title: string;
  url: string;
  summary: string;
  keywords: string[] | string;
  scenarios: string[] | string;
  status?: NoteStatus;
}

export function listNotes(db: Db): Note[] {
  return db
    .prepare("SELECT * FROM notes ORDER BY status ASC, updated_at DESC, id DESC")
    .all()
    .map(noteFromRow);
}

export function saveNote(db: Db, input: NoteInput): Note {
  const note = normalizeNoteInput(input);
  if (input.id) {
    const changes = db
      .prepare(
        `
          UPDATE notes
          SET title = ?, url = ?, summary = ?, keywords_json = ?, scenarios_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
      )
      .run(
        note.title,
        note.url,
        note.summary,
        JSON.stringify(note.keywords),
        JSON.stringify(note.scenarios),
        note.status,
        input.id
      ).changes;
    if (!changes) throw new Error(`Note ${input.id} not found.`);
    return getNote(db, input.id);
  }

  db.prepare(
    `
      INSERT INTO notes (title, url, summary, keywords_json, scenarios_json, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(url) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        keywords_json = excluded.keywords_json,
        scenarios_json = excluded.scenarios_json,
        status = excluded.status,
        updated_at = CURRENT_TIMESTAMP
    `
  ).run(note.title, note.url, note.summary, JSON.stringify(note.keywords), JSON.stringify(note.scenarios), note.status);

  const row = db.prepare("SELECT id FROM notes WHERE url = ?").get(note.url) as { id: number } | undefined;
  if (!row) throw new Error("Failed to save note.");
  return getNote(db, Number(row.id));
}

export function updateNoteStatus(db: Db, id: number, status: NoteStatus): Note {
  if (status !== "active" && status !== "paused") throw new Error(`Invalid note status: ${status}`);
  const changes = db
    .prepare("UPDATE notes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(status, id).changes;
  if (!changes) throw new Error(`Note ${id} not found.`);
  return getNote(db, id);
}

function getNote(db: Db, id: number): Note {
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  if (!row) throw new Error(`Note ${id} not found.`);
  return noteFromRow(row);
}

function normalizeNoteInput(input: NoteInput): Note {
  const title = input.title?.trim();
  const url = input.url?.trim();
  const summary = input.summary?.trim();
  if (!title) throw new Error("笔记标题不能为空。");
  if (!url) throw new Error("笔记链接不能为空。");
  if (!summary) throw new Error("笔记摘要不能为空。");

  return {
    id: input.id,
    title,
    url,
    summary,
    keywords: splitList(input.keywords),
    scenarios: splitList(input.scenarios),
    status: input.status === "paused" ? "paused" : "active"
  };
}

function splitList(value: string[] | string): string[] {
  const items = Array.isArray(value) ? value : value.split(/[|,，、\n]/);
  return items.map((item) => item.trim()).filter(Boolean);
}

function noteFromRow(raw: unknown): Note {
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
}
