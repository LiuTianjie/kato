import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { initSchema } from "../src/db/schema.js";
import { importNotesFromCsv } from "../src/notes/importNotes.js";
import { generateAndPublishInteractions } from "../src/runs/generateAndPublish.js";
import { generateDraftsForInteractions } from "../src/runs/generateDrafts.js";
import { publishConfirmedInteractions } from "../src/runs/publish.js";
import { runDiscovery } from "../src/runs/runner.js";
import { getDashboardStats, getInteractions, updateInteractionStatus } from "../src/dashboard/queries.js";

test("discovery imports notes, queues posts, deduplicates posts, and updates stats", async () => {
  const fixture = createFixture();
  const db = openDb(fixture.config);
  try {
    initSchema(db);
    assert.equal(importNotesFromCsv(db, fixture.notesPath), 3);

    const firstRun = await runDiscovery(db, fixture.config, {
      slot: "manual",
      limit: 30,
      keywords: ["AI工具", "效率工具", "ChatGPT工作流", "Notion效率", "知识管理"]
    });

    assert.equal(firstRun.queued, 3);
    assert.match(firstRun.markdownPath, /queue\.md$/);
    assert.match(firstRun.csvPath, /queue\.csv$/);

    const interactions = getInteractions(db, { runId: firstRun.runId }) as Array<Record<string, unknown>>;
    assert.equal(interactions.length, 3);
    assert.ok(interactions.every((item) => item.status === "new"));
    assert.ok(interactions.every((item) => item.draft_comment === ""));

    const secondRun = await runDiscovery(db, fixture.config, {
      slot: "manual",
      limit: 30,
      keywords: ["AI工具", "效率工具", "ChatGPT工作流", "Notion效率", "知识管理"]
    });
    assert.equal(secondRun.queued, 0);

    const stats = getDashboardStats(db);
    assert.equal(stats.totals.posts, 3);
    assert.equal(stats.totals.interactions, 3);
    assert.equal(stats.totals.drafted, 0);
    assert.ok(stats.topKeywords.length > 0);
  } finally {
    db.close();
    cleanupFixture(fixture.rootDir);
  }
});

test("drafted queue items can be published through the safe adapter path without approval", async () => {
  const fixture = createFixture();
  const originalLocal = process.env.ALLOW_LOCAL_COMMENT_PROVIDER;
  process.env.ALLOW_LOCAL_COMMENT_PROVIDER = "1";
  const db = openDb(fixture.config);
  try {
    initSchema(db);
    importNotesFromCsv(db, fixture.notesPath);
    const run = await runDiscovery(db, fixture.config, {
      slot: "manual",
      limit: 30,
      keywords: ["AI工具", "效率工具", "ChatGPT工作流", "Notion效率", "知识管理"]
    });

    const queued = getInteractions(db, { runId: run.runId }) as Array<{ id: number }>;
    const skippedDraft = await publishConfirmedInteractions(db, fixture.config, [queued[0].id]);
    assert.deepEqual(skippedDraft, { published: 0, skipped: 1 });

    const draftResult = await generateDraftsForInteractions(
      db,
      fixture.config,
      queued.map((item) => item.id)
    );
    assert.deepEqual(draftResult, { generated: 3, skipped: 0 });

    const drafted = getInteractions(db, { runId: run.runId }) as Array<{ id: number }>;
    const result = await publishConfirmedInteractions(db, fixture.config, [drafted[0].id, drafted[1].id]);
    assert.deepEqual(result, { published: 2, skipped: 0 });

    const activeQueue = getInteractions(db, { runId: run.runId }) as Array<{ id: number; status: string }>;
    assert.equal(activeQueue.length, 1);
    assert.ok(activeQueue.every((item) => item.status !== "posted_via_mcp" && item.status !== "posted_by_user"));

    const publishedHistory = getInteractions(db, { runId: run.runId, status: "posted_via_mcp" }) as Array<{
      status: string;
    }>;
    assert.equal(publishedHistory.length, 2);
    assert.ok(publishedHistory.every((item) => item.status === "posted_via_mcp"));

    const interactedHistory = getInteractions(db, { runId: run.runId, status: "interacted" }) as Array<{
      status: string;
    }>;
    assert.equal(interactedHistory.length, 2);
    assert.ok(interactedHistory.every((item) => item.status === "posted_via_mcp"));

    const stats = getDashboardStats(db);
    assert.equal(stats.totals.posted, 2);
    assert.equal(updateInteractionStatus(db, [drafted[2].id], "skipped"), 1);
    assert.throws(() => updateInteractionStatus(db, [drafted[2].id], "bad-status"), /Invalid status/);
  } finally {
    if (originalLocal === undefined) delete process.env.ALLOW_LOCAL_COMMENT_PROVIDER;
    else process.env.ALLOW_LOCAL_COMMENT_PROVIDER = originalLocal;
    db.close();
    cleanupFixture(fixture.rootDir);
  }
});

test("dashboard-style flow can enqueue posts first and generate selected drafts later", async () => {
  const fixture = createFixture();
  const originalLocal = process.env.ALLOW_LOCAL_COMMENT_PROVIDER;
  process.env.ALLOW_LOCAL_COMMENT_PROVIDER = "1";
  const db = openDb(fixture.config);
  try {
    initSchema(db);
    importNotesFromCsv(db, fixture.notesPath);
    const run = await runDiscovery(db, fixture.config, {
      slot: "manual",
      limit: 30,
      keywords: ["AI工具", "效率工具", "ChatGPT工作流", "Notion效率", "知识管理"],
      generateDrafts: false
    });

    assert.equal(run.queued, 3);
    const queued = getInteractions(db, { runId: run.runId }) as Array<{ id: number; status: string; draft_comment: string }>;
    assert.equal(queued.length, 3);
    assert.ok(queued.every((item) => item.status === "new"));
    assert.ok(queued.every((item) => item.draft_comment === ""));

    const result = await generateDraftsForInteractions(
      db,
      fixture.config,
      queued.map((item) => item.id)
    );
    assert.deepEqual(result, { generated: 3, skipped: 0 });

    const drafted = getInteractions(db, { runId: run.runId }) as Array<{ status: string; draft_comment: string }>;
    assert.ok(drafted.every((item) => item.status === "drafted"));
    assert.ok(drafted.every((item) => item.draft_comment.length >= 40));

    const regenerated = await generateDraftsForInteractions(db, fixture.config, [queued[0].id]);
    assert.deepEqual(regenerated, { generated: 1, skipped: 0 });
    const afterRegenerate = getInteractions(db, { runId: run.runId }) as Array<{ id: number; status: string }>;
    assert.equal(afterRegenerate.find((item) => item.id === queued[0].id)?.status, "drafted");
  } finally {
    if (originalLocal === undefined) delete process.env.ALLOW_LOCAL_COMMENT_PROVIDER;
    else process.env.ALLOW_LOCAL_COMMENT_PROVIDER = originalLocal;
    db.close();
    cleanupFixture(fixture.rootDir);
  }
});

test("selected queue items can generate comments and publish in one operation", async () => {
  const fixture = createFixture();
  const originalLocal = process.env.ALLOW_LOCAL_COMMENT_PROVIDER;
  process.env.ALLOW_LOCAL_COMMENT_PROVIDER = "1";
  const db = openDb(fixture.config);
  try {
    initSchema(db);
    importNotesFromCsv(db, fixture.notesPath);
    const run = await runDiscovery(db, fixture.config, {
      slot: "manual",
      limit: 30,
      keywords: ["AI工具", "效率工具", "ChatGPT工作流", "Notion效率", "知识管理"],
      generateDrafts: false
    });

    const queued = getInteractions(db, { runId: run.runId }) as Array<{ id: number }>;
    const result = await generateAndPublishInteractions(db, fixture.config, [queued[0].id, queued[1].id]);
    assert.deepEqual(result, { generated: 2, published: 2, skipped: 0 });

    const activeQueue = getInteractions(db, { runId: run.runId }) as Array<{ id: number; status: string }>;
    assert.equal(activeQueue.length, 1);
    assert.equal(activeQueue[0].status, "new");

    const publishedHistory = getInteractions(db, { runId: run.runId, status: "posted_via_mcp" }) as Array<{
      status: string;
      draft_comment: string;
    }>;
    assert.equal(publishedHistory.length, 2);
    assert.ok(publishedHistory.every((item) => item.status === "posted_via_mcp"));
    assert.ok(publishedHistory.every((item) => item.draft_comment.length >= 35));
  } finally {
    if (originalLocal === undefined) delete process.env.ALLOW_LOCAL_COMMENT_PROVIDER;
    else process.env.ALLOW_LOCAL_COMMENT_PROVIDER = originalLocal;
    db.close();
    cleanupFixture(fixture.rootDir);
  }
});

function createFixture(): { rootDir: string; notesPath: string; config: AppConfig } {
  const rootDir = path.join(tmpdir(), `redbook-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const dataDir = path.join(rootDir, "data");
  const outputDir = path.join(rootDir, "output");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const fixturePath = path.join(dataDir, "posts.json");
  const notesPath = path.join(dataDir, "notes.csv");
  writeFileSync(fixturePath, JSON.stringify(samplePosts(), null, 2));
  writeFileSync(
    notesPath,
    [
      "title,url,summary,keywords,scenarios,status",
      "AI效率工具工作流,https://www.xiaohongshu.com/explore/example-note-1?xsec_token=note-token-1,整理了从信息收集到自动化执行的AI工具组合和避坑经验,AI工具|效率工具|自动化办公|ChatGPT工作流,有人问工具选择|有人分享效率流程|有人卡在自动化落地,active",
      "提示词复盘模板,https://www.xiaohongshu.com/explore/example-note-2?xsec_token=note-token-2,用结构化提示词做复盘和内容整理的模板,提示词|AI写作|知识管理,有人讨论提示词|有人想提升写作效率|有人做学习复盘,active",
      "Notion知识管理方法,https://www.xiaohongshu.com/explore/example-note-3?xsec_token=note-token-3,把输入输出和项目推进放进Notion的轻量知识管理方法,Notion效率|知识管理|学习效率,有人分享Notion搭建|有人找知识管理系统|有人做学习计划,active"
    ].join("\n")
  );

  return {
    rootDir,
    notesPath,
    config: {
      rootDir,
      dataDir,
      outputDir,
      sqlitePath: path.join(dataDir, "app.sqlite"),
      xhs: {
        provider: "fixture",
        fixturePath
      }
    }
  };
}

function cleanupFixture(rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true });
}

function samplePosts(): unknown[] {
  return [
    {
      id: "sample-001",
      url: "https://www.xiaohongshu.com/explore/sample-001",
      title: "打工人最近离不开的5个AI效率工具",
      snippet: "整理了会议纪要、写作、搜索、自动化办公相关工具，适合想减少重复劳动的人。",
      author: "效率研究员",
      likeCount: 128,
      commentCount: 32,
      publishedAt: "2026-05-09T09:30:00+08:00"
    },
    {
      id: "sample-002",
      url: "https://www.xiaohongshu.com/explore/sample-002",
      title: "ChatGPT工作流怎么真正落地",
      snippet: "不是收藏一堆提示词，而是把输入、判断、输出和复盘都固定下来。",
      author: "AI实操笔记",
      likeCount: 256,
      commentCount: 76,
      publishedAt: "2026-05-09T13:10:00+08:00"
    },
    {
      id: "sample-003",
      url: "https://www.xiaohongshu.com/explore/sample-003",
      title: "Notion知识管理到底怎么搭才不累",
      snippet: "尝试过复杂模板之后，发现轻量分类和固定复盘入口更重要。",
      author: "Notion小抄",
      likeCount: 89,
      commentCount: 14,
      publishedAt: "2026-05-08T20:00:00+08:00"
    }
  ];
}
