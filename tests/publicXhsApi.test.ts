import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/client.js";
import { initSchema } from "../src/db/schema.js";
import { handlePublicXhsApi } from "../src/dashboard/publicXhsApi.js";

test("public XHS API requires token and returns standard error envelope", async () => {
  const fixture = createFixture();
  const originalToken = process.env.XHS_API_TOKEN;
  process.env.XHS_API_TOKEN = "secret-token";
  try {
    const response = await callApi(fixture.config, fixture.db, {
      method: "POST",
      pathname: "/api/v1/xhs/posts/search",
      body: { keywords: ["AI工具"], limit: 1 }
    });
    assert.equal(response.status, 401);
    assert.equal(response.payload.success, false);
    assert.equal(response.payload.error.code, "UNAUTHORIZED");
  } finally {
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

test("public XHS API searches posts with token and standard success envelope", async () => {
  const fixture = createFixture();
  const originalToken = process.env.XHS_API_TOKEN;
  process.env.XHS_API_TOKEN = "secret-token";
  try {
    const response = await callApi(fixture.config, fixture.db, {
      method: "POST",
      pathname: "/api/v1/xhs/posts/search",
      token: "secret-token",
      body: { keywords: ["AI工具"], limit: 2 }
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.posts.length, 1);
    assert.equal(response.payload.data.posts[0].id, "post-1");
    assert.equal(response.payload.data.posts[0].xsecToken, "token-1");
  } finally {
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

test("public XHS API validates detail and publish guard fields", async () => {
  const fixture = createFixture();
  const originalToken = process.env.XHS_API_TOKEN;
  process.env.XHS_API_TOKEN = "secret-token";
  try {
    const detail = await postJson(fixture.config, fixture.db, "/api/v1/xhs/posts/detail", {}, "secret-token");
    assert.equal(detail.status, 400);
    assert.equal(detail.payload.error.code, "POST_IDENTIFIER_REQUIRED");

    const publish = await postJson(
      fixture.config,
      fixture.db,
      "/api/v1/xhs/comments/publish",
      { post: fixturePost(), content: "确认发布评论", idempotencyKey: "publish-1" },
      "secret-token"
    );
    assert.equal(publish.status, 400);
    assert.equal(publish.payload.error.code, "CONFIRM_REQUIRED");

    const like = await postJson(
      fixture.config,
      fixture.db,
      "/api/v1/xhs/posts/like",
      { post: fixturePost(), confirm: true },
      "secret-token"
    );
    assert.equal(like.status, 400);
    assert.equal(like.payload.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  } finally {
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

test("public XHS API idempotency key prevents repeated publish calls", async () => {
  const fixture = createFixture();
  const originalToken = process.env.XHS_API_TOKEN;
  const originalLog = console.log;
  const publishLogs: string[] = [];
  process.env.XHS_API_TOKEN = "secret-token";
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("[fixture] Would publish")) publishLogs.push(line);
  };
  try {
    const body = { post: fixturePost(), content: "确认发布评论", confirm: true, idempotencyKey: "same-key" };
    const first = await postJson(fixture.config, fixture.db, "/api/v1/xhs/comments/publish", body, "secret-token");
    const second = await postJson(fixture.config, fixture.db, "/api/v1/xhs/comments/publish", body, "secret-token");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.payload.success, true);
    assert.equal(second.payload.success, true);
    assert.equal(publishLogs.length, 1);
  } finally {
    console.log = originalLog;
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

test("serverx-compatible XHS API exposes search and detail payloads", async () => {
  const fixture = createFixture();
  const originalToken = process.env.XHS_API_TOKEN;
  process.env.XHS_API_TOKEN = "secret-token";
  try {
    const search = await postJson(fixture.config, fixture.db, "/search_notes", { keyword: "AI工具", limit: 2 }, "secret-token");
    assert.equal(search.status, 200);
    assert.equal(search.payload.success, true);
    assert.equal(search.payload.data.length, 1);
    assert.equal(search.payload.data[0].note_id, "post-1");
    assert.equal(search.payload.data[0].xsec_token, "token-1");
    assert.equal(search.payload.data[0].user.nickname, "作者A");
    assert.deepEqual(search.payload.data[0].comments, []);

    const detail = await postJson(
      fixture.config,
      fixture.db,
      "/api/v1/xhs/serverx/note_detail",
      { note_id: "post-1", xsec_token: "token-1" },
      "secret-token"
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.payload.success, true);
    assert.equal(detail.payload.data.note_id, "post-1");
    assert.equal(detail.payload.data.desc, "这里讨论 AI工具 和效率工作流");
    assert.equal(detail.payload.data.comment_count, 2);
  } finally {
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

test("public XHS API accepts deploy default token when env token is omitted", async () => {
  const fixture = createFixture();
  const originalToken = process.env.XHS_API_TOKEN;
  delete process.env.XHS_API_TOKEN;
  try {
    const search = await postJson(fixture.config, fixture.db, "/search_notes", { keyword: "AI工具", limit: 1 }, "LiuTao0.1");
    assert.equal(search.status, 200);
    assert.equal(search.payload.success, true);
    assert.equal(search.payload.data[0].note_id, "post-1");
  } finally {
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

async function postJson(config: AppConfig, db: Db, pathname: string, body: unknown, token: string): Promise<{ status: number; payload: any }> {
  return callApi(config, db, {
    method: "POST",
    pathname,
    token,
    body
  });
}

async function callApi(
  config: AppConfig,
  db: Db,
  options: { method: string; pathname: string; body?: unknown; token?: string }
): Promise<{ status: number; payload: any }> {
  const rawBody = options.body === undefined ? "" : JSON.stringify(options.body);
  const req = Readable.from(rawBody ? [rawBody] : []) as IncomingMessage;
  req.method = options.method;
  req.headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
  };

  let responseBody = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: unknown) {
      responseBody = chunk ? String(chunk) : "";
    }
  } as unknown as ServerResponse;

  const handled = await handlePublicXhsApi(req, res, new URL(options.pathname, "http://localhost"), { config, db });
  assert.equal(handled, true);
  return { status: Number(res.statusCode), payload: responseBody ? JSON.parse(responseBody) : undefined };
}

function createFixture(): { rootDir: string; config: AppConfig; db: Db } {
  const rootDir = path.join(tmpdir(), `redbook-public-api-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const dataDir = path.join(rootDir, "data");
  const outputDir = path.join(rootDir, "output");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  const fixturePath = path.join(rootDir, "posts.json");
  writeFileSync(fixturePath, JSON.stringify([fixturePost()]), "utf8");
  const config: AppConfig = {
    rootDir,
    dataDir,
    outputDir,
    sqlitePath: path.join(dataDir, "app.sqlite"),
    xhs: {
      provider: "fixture",
      fixturePath
    }
  };
  const db = openDb(config);
  initSchema(db);
  return { rootDir, config, db };
}

function cleanupFixture(fixture: { rootDir: string; db: Db }): void {
  fixture.db.close();
  rmSync(fixture.rootDir, { recursive: true, force: true });
}

function fixturePost() {
  return {
    id: "post-1",
    url: "https://www.xiaohongshu.com/explore/post-1?xsec_token=token-1",
    title: "AI工具真实搜索结果",
    snippet: "这里讨论 AI工具 和效率工作流",
    author: "作者A",
    xsecToken: "token-1",
    likeCount: 10,
    commentCount: 2
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
