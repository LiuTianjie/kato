import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/client.js";
import { initSchema } from "../src/db/schema.js";
import { handlePublicXhsApi } from "../src/dashboard/publicXhsApi.js";

test("public XHS API requires token and returns standard error envelope", async () => {
  const fixture = createFixture();
  const api = await createApiServer(fixture.config, fixture.db);
  const originalToken = process.env.XHS_API_TOKEN;
  process.env.XHS_API_TOKEN = "secret-token";
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/xhs/posts/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords: ["AI工具"], limit: 1 })
    });
    const payload = await response.json() as { success: boolean; error: { code: string } };
    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, "UNAUTHORIZED");
  } finally {
    await api.close();
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

test("public XHS API searches posts with token and standard success envelope", async () => {
  const fixture = createFixture();
  const api = await createApiServer(fixture.config, fixture.db);
  const originalToken = process.env.XHS_API_TOKEN;
  process.env.XHS_API_TOKEN = "secret-token";
  try {
    const response = await fetch(`${api.baseUrl}/api/v1/xhs/posts/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "secret-token"
      },
      body: JSON.stringify({ keywords: ["AI工具"], limit: 2 })
    });
    const payload = await response.json() as { success: boolean; data: { posts: Array<{ id: string; xsecToken?: string }> } };
    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.posts.length, 1);
    assert.equal(payload.data.posts[0].id, "post-1");
    assert.equal(payload.data.posts[0].xsecToken, "token-1");
  } finally {
    await api.close();
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

test("public XHS API validates detail and publish guard fields", async () => {
  const fixture = createFixture();
  const api = await createApiServer(fixture.config, fixture.db);
  const originalToken = process.env.XHS_API_TOKEN;
  process.env.XHS_API_TOKEN = "secret-token";
  try {
    const detail = await postJson(api.baseUrl, "/api/v1/xhs/posts/detail", {}, "secret-token");
    assert.equal(detail.status, 400);
    assert.equal(detail.payload.error.code, "POST_IDENTIFIER_REQUIRED");

    const publish = await postJson(
      api.baseUrl,
      "/api/v1/xhs/comments/publish",
      { post: fixturePost(), content: "确认发布评论", idempotencyKey: "publish-1" },
      "secret-token"
    );
    assert.equal(publish.status, 400);
    assert.equal(publish.payload.error.code, "CONFIRM_REQUIRED");

    const like = await postJson(
      api.baseUrl,
      "/api/v1/xhs/posts/like",
      { post: fixturePost(), confirm: true },
      "secret-token"
    );
    assert.equal(like.status, 400);
    assert.equal(like.payload.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  } finally {
    await api.close();
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

test("public XHS API idempotency key prevents repeated publish calls", async () => {
  const fixture = createFixture();
  const api = await createApiServer(fixture.config, fixture.db);
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
    const first = await postJson(api.baseUrl, "/api/v1/xhs/comments/publish", body, "secret-token");
    const second = await postJson(api.baseUrl, "/api/v1/xhs/comments/publish", body, "secret-token");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.payload.success, true);
    assert.equal(second.payload.success, true);
    assert.equal(publishLogs.length, 1);
  } finally {
    console.log = originalLog;
    await api.close();
    restoreEnv("XHS_API_TOKEN", originalToken);
    cleanupFixture(fixture);
  }
});

async function postJson(baseUrl: string, pathname: string, body: unknown, token: string): Promise<{ status: number; payload: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, payload: await response.json() };
}

async function createApiServer(config: AppConfig, db: Db): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const handled = await handlePublicXhsApi(req, res, url, { config, db });
    if (!handled) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => closeServer(server)
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
