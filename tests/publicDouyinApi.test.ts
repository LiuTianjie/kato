import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handlePublicDouyinApi } from "../src/dashboard/publicDouyinApi.js";

test("public Douyin API requires the shared Kato token", async () => {
  const originalToken = process.env.XHS_API_TOKEN;
  process.env.XHS_API_TOKEN = "secret-token";
  try {
    const response = await callApi({
      method: "POST",
      pathname: "/api/v1/douyin/posts/search",
      body: { keyword: "课程", limit: 1 }
    });
    assert.equal(response.status, 401);
    assert.equal(response.payload.success, false);
    assert.equal(response.payload.error.code, "UNAUTHORIZED");
  } finally {
    restoreEnv("XHS_API_TOKEN", originalToken);
  }
});

test("public Douyin API exposes search through the service adapter", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.XHS_API_TOKEN;
  const originalBaseUrl = process.env.DOUYIN_SERVICE_URL;
  process.env.XHS_API_TOKEN = "secret-token";
  process.env.DOUYIN_SERVICE_URL = "http://fake-douyin.local";

  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://fake-douyin.local/api/v1/posts/search");
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          posts: [
            {
              id: "7372484719365098803",
              url: "https://www.douyin.com/video/7372484719365098803",
              title: "课程体验反馈",
              snippet: "课程体验反馈 正文"
            }
          ]
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const response = await callApi({
      method: "POST",
      pathname: "/api/v1/douyin/posts/search",
      token: "secret-token",
      body: { keyword: "课程", limit: 1 }
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.posts[0].platform, "douyin");
    assert.equal(response.payload.data.items[0].id, "7372484719365098803");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("XHS_API_TOKEN", originalToken);
    restoreEnv("DOUYIN_SERVICE_URL", originalBaseUrl);
  }
});

test("public Douyin comments API preserves cursor and has_more", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.XHS_API_TOKEN;
  const originalBaseUrl = process.env.DOUYIN_SERVICE_URL;
  process.env.XHS_API_TOKEN = "secret-token";
  process.env.DOUYIN_SERVICE_URL = "http://fake-douyin.local";

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://fake-douyin.local/api/v1/posts/comments");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    assert.equal(body.aweme_id, "7372484719365098803");
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          comments: [{ id: "comment-1", content: "评论", parentId: "" }],
          items: [{ id: "comment-1", content: "评论", parentId: "" }],
          cursor: "20",
          has_more: true
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const response = await callApi({
      method: "POST",
      pathname: "/api/v1/douyin/posts/comments",
      token: "secret-token",
      body: { aweme_id: "7372484719365098803", limit: 20 }
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.cursor, "20");
    assert.equal(response.payload.data.has_more, true);
    assert.equal(response.payload.data.comments[0].id, "comment-1");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("XHS_API_TOKEN", originalToken);
    restoreEnv("DOUYIN_SERVICE_URL", originalBaseUrl);
  }
});

async function callApi(options: { method: string; pathname: string; body?: unknown; token?: string }): Promise<{ status: number; payload: any }> {
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
    on() {
      return this;
    },
    end(chunk?: unknown) {
      responseBody = chunk ? String(chunk) : "";
    }
  } as unknown as ServerResponse;

  const handled = await handlePublicDouyinApi(req, res, new URL(options.pathname, "http://localhost"));
  assert.equal(handled, true);
  return { status: Number(res.statusCode), payload: responseBody ? JSON.parse(responseBody) : undefined };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
