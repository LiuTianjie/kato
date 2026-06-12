import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { runContentAgent } from "../src/content/agent.js";
import { parseContentDraftJson } from "../src/content/draftProvider.js";
import { publishContentDraft } from "../src/content/publisher.js";
import {
  getActivePersona,
  getContentProjectDetail,
  saveAccountPersona,
  saveContentDraft,
  updateContentDraftBody,
  updateContentDraftStatus
} from "../src/content/repository.js";
import { openDb } from "../src/db/client.js";
import { initSchema } from "../src/db/schema.js";

test("content repository saves persona, content sources, web sources, draft, and status", async () => {
  const fixture = createFixture();
  const db = openDb(fixture.config);
  try {
    initSchema(db);
    const persona = saveAccountPersona(db, {
      name: "效率研究员",
      positioning: "写真实 AI 工具工作流",
      targetReaders: "想减少重复劳动的打工人",
      tone: "冷静、具体、少营销感",
      commonPhrases: "我的判断|先跑通一步",
      bannedPhrases: "保姆级|天花板",
      experienceBank: "长期记录工具落地过程"
    });
    assert.equal(persona.status, "active");
    assert.deepEqual(getActivePersona(db)?.commonPhrases, ["我的判断", "先跑通一步"]);

    const result = await runContentAgent(db, fixture.config, {
      keyword: "AI工具",
      contentType: "guide",
      sourceLimit: 5
    });

    assert.ok(result.projectId > 0);
    assert.equal(result.sourceCount, 5);
    assert.ok(result.webSourceCount >= 1);
    assert.ok(result.draftId);

    const detail = getContentProjectDetail(db, result.projectId);
    assert.equal(detail.project.status, "drafted");
    assert.match(detail.project.researchSummary, /AI工具/);
    assert.match(detail.project.researchSummary, /热度最高来源/);
    assert.equal(detail.sources.length, 5);
    assert.equal(new Set(detail.sources.map((item) => item.url)).size, 5);
    assert.ok(detail.sources.every((item) => typeof item.heatScore === "number"));
    assert.ok(detail.sources[0].heatScore >= detail.sources.at(-1)?.heatScore);
    assert.ok(detail.webSources.some((item) => item.status === "skipped"));
    assert.ok(detail.draft?.body.includes("我"));
    assert.ok(detail.draft?.factualClaims.length);
    assert.equal(detail.draft?.unsupportedClaims.length, 0);
    assert.equal(detail.draft?.publishStatus, "not_published");
    assert.ok(detail.events.some((item) => item.stage === "draft_generation"));

    const updated = updateContentDraftBody(db, Number(detail.draft?.id), {
      body: "我重新写了一版，更像自己真实复盘后的笔记。"
    });
    assert.equal(updated.status, "needs_revision");

    const approved = updateContentDraftStatus(db, Number(updated.id), "approved");
    assert.equal(approved.status, "approved");
    assert.throws(() => updateContentDraftStatus(db, Number(updated.id), "posted"), /Invalid content draft status/);
  } finally {
    db.close();
    cleanupFixture(fixture.rootDir);
  }
});

test("content draft JSON parser accepts fenced JSON and preserves review fields", () => {
  const draft = parseContentDraftJson(
    [
      "```json",
      JSON.stringify({
        titleCandidates: ["别再只收藏AI工具"],
        coverText: "AI工具先跑通一步",
        body: "我试下来，真正有用的不是收藏十个工具，而是先固定一个每天会重复用的小流程。",
        tags: ["AI工具", "效率"],
        imagePlan: ["首图放反常识判断"],
        visualStyle: "干净工作台",
        personaFit: "贴合实操型账号",
        humanVoiceReview: { passed: true, issues: [], revisionNotes: [] },
        originalityCheck: { reusedAngles: ["工具合集"], uniqueAngle: "最小流程", riskNotes: [] },
        factualClaims: ["来源提到收藏十个工具"],
        sourceRefs: ["AI工具真实落地经验 1 https://www.xiaohongshu.com/explore/content-1"],
        unsupportedClaims: [],
        riskNotes: ["发布前核对工具名称"]
      }),
      "```"
    ].join("\n"),
    7
  );
  assert.equal(draft.projectId, 7);
  assert.deepEqual(draft.titleCandidates, ["别再只收藏AI工具"]);
  assert.equal(draft.originalityCheck.uniqueAngle, "最小流程");
  assert.deepEqual(draft.factualClaims, ["来源提到收藏十个工具"]);
  assert.equal(draft.publishStatus, "not_published");
});

test("unsupported claims block approval and publish gates fail with clear errors", async () => {
  const fixture = createFixture();
  const db = openDb(fixture.config);
  try {
    initSchema(db);
    const result = await runContentAgent(db, fixture.config, {
      keyword: "AI工具",
      contentType: "guide",
      sourceLimit: 5
    });
    const detail = getContentProjectDetail(db, result.projectId);
    const draftId = Number(detail.draft?.id);

    const unsupported = saveContentDraft(db, {
      ...detail.draft!,
      unsupportedClaims: ["某工具已经成为行业第一"],
      status: "needs_revision"
    });
    assert.throws(() => updateContentDraftStatus(db, Number(unsupported.id), "approved"), /未被来源支持/);
    await assert.rejects(() => publishContentDraft(db, fixture.config, draftId), /审核通过/);

    const humanEdited = updateContentDraftBody(db, draftId, { body: "我删掉了无法核实的行业第一说法，只保留来源里能看到的信息。" });
    assert.equal(humanEdited.unsupportedClaims.length, 0);
    updateContentDraftStatus(db, draftId, "approved");
    await assert.rejects(() => publishContentDraft(db, fixture.config, draftId), /本地图片路径/);

    const imagePath = path.join(fixture.rootDir, "image.jpg");
    const failScriptPath = path.join(fixture.rootDir, "fail-publish.js");
    writeFileSync(imagePath, "fake image");
    writeFileSync(failScriptPath, "process.stderr.write('boom'); process.exit(2);");
    updateContentDraftBody(db, draftId, { imagePaths: [imagePath] });
    updateContentDraftStatus(db, draftId, "approved");

    const originalCommand = process.env.XHS_PUBLISH_COMMAND;
    const originalScript = process.env.XHS_PUBLISH_SCRIPT_PATH;
    process.env.XHS_PUBLISH_COMMAND = process.execPath;
    process.env.XHS_PUBLISH_SCRIPT_PATH = failScriptPath;
    try {
      await assert.rejects(() => publishContentDraft(db, fixture.config, draftId), /发布脚本失败/);
    } finally {
      if (originalCommand === undefined) delete process.env.XHS_PUBLISH_COMMAND;
      else process.env.XHS_PUBLISH_COMMAND = originalCommand;
      if (originalScript === undefined) delete process.env.XHS_PUBLISH_SCRIPT_PATH;
      else process.env.XHS_PUBLISH_SCRIPT_PATH = originalScript;
    }

    const afterFailure = getContentProjectDetail(db, result.projectId);
    assert.equal(afterFailure.draft?.publishStatus, "failed");
    assert.ok(afterFailure.events.some((item) => item.stage === "publish" && item.level === "error"));
  } finally {
    db.close();
    cleanupFixture(fixture.rootDir);
  }
});

test("playwright web provider failure records an error and does not interrupt content generation", async () => {
  const fixture = createFixture();
  const originalProvider = process.env.WEB_RESEARCH_PROVIDER;
  const originalExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.WEB_RESEARCH_PROVIDER = "playwright";
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "/not/a/browser";
  const db = openDb(fixture.config);
  try {
    initSchema(db);
    const result = await runContentAgent(db, fixture.config, {
      keyword: "AI工具",
      contentType: "guide",
      sourceLimit: 5
    });
    const detail = getContentProjectDetail(db, result.projectId);
    assert.equal(detail.project.status, "drafted");
    assert.ok(detail.webSources.some((item) => item.status === "failed"));
    assert.ok(detail.events.some((item) => item.stage === "web_research" && item.level === "warn"));
    assert.ok(detail.draft?.body);
  } finally {
    if (originalProvider === undefined) delete process.env.WEB_RESEARCH_PROVIDER;
    else process.env.WEB_RESEARCH_PROVIDER = originalProvider;
    if (originalExecutable === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = originalExecutable;
    db.close();
    cleanupFixture(fixture.rootDir);
  }
});

function createFixture(): { rootDir: string; config: AppConfig } {
  const rootDir = path.join(tmpdir(), `redbook-content-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const dataDir = path.join(rootDir, "data");
  const outputDir = path.join(rootDir, "output");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  const fixturePath = path.join(dataDir, "posts.json");
  writeFileSync(fixturePath, JSON.stringify(samplePosts(), null, 2));
  return {
    rootDir,
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
  return Array.from({ length: 7 }, (_, index) => ({
    id: `content-${index + 1}`,
    url: `https://www.xiaohongshu.com/explore/content-${index + 1}`,
    title: `AI工具真实落地经验 ${index + 1}`,
    snippet: `这篇讨论 AI工具 怎么进入日常工作流，重点是先解决一个重复任务，再慢慢扩展。编号 ${index + 1}`,
    author: `作者${index + 1}`,
    likeCount: 100 + index,
    commentCount: 20 + index,
    publishedAt: "2026-05-12T10:00:00+08:00"
  }));
}
