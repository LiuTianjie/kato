import type { Db } from "./client.js";

export function initSchema(db: Db): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      scenarios_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      snippet TEXT NOT NULL,
      author TEXT,
      xsec_token TEXT,
      like_count INTEGER,
      comment_count INTEGER,
      published_at TEXT,
      matched_keywords_json TEXT NOT NULL DEFAULT '[]',
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'new'
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      query_pack_json TEXT NOT NULL,
      output_markdown_path TEXT,
      output_csv_path TEXT
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT NOT NULL,
      note_id INTEGER,
      run_id INTEGER NOT NULL,
      draft_comment TEXT NOT NULL,
      score REAL NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(post_id) REFERENCES posts(id),
      FOREIGN KEY(note_id) REFERENCES notes(id),
      FOREIGN KEY(run_id) REFERENCES runs(id),
      UNIQUE(post_id)
    );

    CREATE TABLE IF NOT EXISTS account_personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      positioning TEXT NOT NULL,
      target_readers TEXT NOT NULL,
      tone TEXT NOT NULL,
      common_phrases_json TEXT NOT NULL DEFAULT '[]',
      banned_phrases_json TEXT NOT NULL DEFAULT '[]',
      experience_bank TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS content_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'running',
      research_summary TEXT NOT NULL DEFAULT '',
      persona_snapshot_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS content_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      post_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      snippet TEXT NOT NULL,
      author TEXT,
      like_count INTEGER,
      comment_count INTEGER,
      published_at TEXT,
      source_analysis TEXT NOT NULL DEFAULT '',
      heat_score REAL,
      heat_reason TEXT NOT NULL DEFAULT '',
      detail_error TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES content_projects(id),
      UNIQUE(project_id, url)
    );

    CREATE TABLE IF NOT EXISTS web_research_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      snippet TEXT NOT NULL,
      extracted_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES content_projects(id)
    );

    CREATE TABLE IF NOT EXISTS content_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL UNIQUE,
      title_candidates_json TEXT NOT NULL DEFAULT '[]',
      cover_text TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      image_plan_json TEXT NOT NULL DEFAULT '[]',
      visual_style TEXT NOT NULL DEFAULT '',
      persona_fit TEXT NOT NULL DEFAULT '',
      human_voice_review_json TEXT NOT NULL DEFAULT '{}',
      originality_check_json TEXT NOT NULL DEFAULT '{}',
      factual_claims_json TEXT NOT NULL DEFAULT '[]',
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      unsupported_claims_json TEXT NOT NULL DEFAULT '[]',
      risk_notes_json TEXT NOT NULL DEFAULT '[]',
      image_paths_json TEXT NOT NULL DEFAULT '[]',
      publish_status TEXT NOT NULL DEFAULT 'not_published',
      published_url TEXT,
      publish_error TEXT,
      status TEXT NOT NULL DEFAULT 'drafted',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES content_projects(id)
    );

    CREATE TABLE IF NOT EXISTS content_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      stage TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES content_projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
    CREATE INDEX IF NOT EXISTS idx_interactions_run_status ON interactions(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_posts_last_seen ON posts(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_content_projects_created ON content_projects(created_at);
    CREATE INDEX IF NOT EXISTS idx_content_sources_project ON content_sources(project_id);
    CREATE INDEX IF NOT EXISTS idx_web_research_sources_project ON web_research_sources(project_id);
    CREATE INDEX IF NOT EXISTS idx_content_events_project ON content_events(project_id, id);
  `);
  ensureColumn(db, "posts", "xsec_token", "TEXT");
  ensureColumn(db, "content_sources", "heat_score", "REAL");
  ensureColumn(db, "content_sources", "heat_reason", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "content_sources", "detail_error", "TEXT");
  ensureColumn(db, "content_drafts", "factual_claims_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "content_drafts", "source_refs_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "content_drafts", "unsupported_claims_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "content_drafts", "risk_notes_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "content_drafts", "image_paths_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "content_drafts", "publish_status", "TEXT NOT NULL DEFAULT 'not_published'");
  ensureColumn(db, "content_drafts", "published_url", "TEXT");
  ensureColumn(db, "content_drafts", "publish_error", "TEXT");
}

function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
