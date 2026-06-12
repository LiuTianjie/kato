import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { runGrowthAgent } from "../src/agent/growthAgent.js";
import { openDb } from "../src/db/client.js";
import { initSchema } from "../src/db/schema.js";
import { listNotes, saveNote, updateNoteStatus } from "../src/notes/repository.js";

test("note library supports save, update, pause, and agent preflight", async () => {
  const fixture = createFixture();
  const db = openDb(fixture.config);
  try {
    initSchema(db);
    await assert.rejects(
      () => runGrowthAgent(db, fixture.config, { limit: 1, keywords: ["AI工具"] }),
      /请先在我的笔记库添加至少一条 active 笔记/
    );

    const note = saveNote(db, {
      title: "AI效率工具工作流",
      url: "https://www.xiaohongshu.com/example-note",
      summary: "整理 AI 工具组合和自动化办公经验",
      keywords: "AI工具 | 效率工具",
      scenarios: "有人问工具选择 | 有人分享效率流程"
    });
    assert.equal(note.status, "active");
    assert.deepEqual(note.keywords, ["AI工具", "效率工具"]);

    const updated = saveNote(db, {
      ...note,
      summary: "更新后的摘要",
      keywords: ["AI工具", "ChatGPT工作流"],
      scenarios: ["有人卡在自动化落地"],
      status: "active"
    });
    assert.equal(updated.summary, "更新后的摘要");
    assert.deepEqual(updated.keywords, ["AI工具", "ChatGPT工作流"]);

    updateNoteStatus(db, Number(note.id), "paused");
    const notes = listNotes(db);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].status, "paused");
  } finally {
    db.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

function createFixture(): { rootDir: string; config: AppConfig } {
  const rootDir = path.join(tmpdir(), `redbook-notes-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const dataDir = path.join(rootDir, "data");
  const outputDir = path.join(rootDir, "output");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  return {
    rootDir,
    config: {
      rootDir,
      dataDir,
      outputDir,
      sqlitePath: path.join(dataDir, "app.sqlite"),
      xhs: {
        provider: "fixture",
        fixturePath: path.join(dataDir, "posts.json")
      }
    }
  };
}
