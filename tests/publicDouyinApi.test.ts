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

test("public Douyin API accepts the built-in Kato token even when env token differs", async () => {
  const originalFetch = globalThis.fetch;
  const originalKatoToken = process.env.KATO_API_TOKEN;
  const originalXhsToken = process.env.XHS_API_TOKEN;
  const originalBaseUrl = process.env.DOUYIN_SERVICE_URL;
  process.env.KATO_API_TOKEN = "secret-token";
  process.env.XHS_API_TOKEN = "another-secret";
  process.env.DOUYIN_SERVICE_URL = "http://fake-douyin.local";

  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://fake-douyin.local/api/v1/posts/search");
    return jsonResponse({
      success: true,
      data: {
        posts: [{ id: "7372484719365098803", title: "课程体验反馈", url: "https://www.douyin.com/video/7372484719365098803" }]
      }
    });
  };

  try {
    const response = await callApi({
      method: "POST",
      pathname: "/api/v1/douyin/posts/search",
      token: "LiuTao0.1",
      body: { keyword: "课程", limit: 1 }
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.success, true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("KATO_API_TOKEN", originalKatoToken);
    restoreEnv("XHS_API_TOKEN", originalXhsToken);
    restoreEnv("DOUYIN_SERVICE_URL", originalBaseUrl);
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

test("serverx-compatible Douyin API exposes video endpoints and cookie update", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.XHS_API_TOKEN;
  const originalBaseUrl = process.env.DOUYIN_SERVICE_URL;
  const calls: string[] = [];
  process.env.XHS_API_TOKEN = "secret-token";
  process.env.DOUYIN_SERVICE_URL = "http://fake-douyin.local";

  globalThis.fetch = async (input, init) => {
    const requestUrl = String(input);
    calls.push(requestUrl);
    if (requestUrl.includes("/api/v1/posts/search")) {
      return jsonResponse({
        success: true,
        data: {
          posts: [
            {
              id: "738xxx",
              url: "https://www.douyin.com/video/738xxx",
              title: "视频文案",
              author: "作者昵称",
              likeCount: 10,
              commentCount: 5
            }
          ]
        }
      });
    }
    if (requestUrl.includes("/api/v1/links/resolve")) {
      return jsonResponse({ success: true, data: { aweme_id: "738xxx", id: "738xxx" } });
    }
    if (requestUrl.includes("/api/v1/posts/detail")) {
      return jsonResponse({
        success: true,
        data: {
          post: {
            id: "738xxx",
            url: "https://www.douyin.com/video/738xxx",
            title: "视频文案",
            raw: { aweme_id: "738xxx", desc: "视频文案", author: { nickname: "作者昵称" } }
          }
        }
      });
    }
    if (requestUrl.includes("/api/v1/posts/comment_replies")) {
      return jsonResponse({
        success: true,
        data: {
          comments: [{ id: "sub_comment_1", content: "子评论内容", parentId: "comment_1", author: "评论用户" }],
          cursor: "20",
          has_more: false
        }
      });
    }
    if (requestUrl.includes("/api/v1/posts/comments")) {
      return jsonResponse({
        success: true,
        data: {
          comments: [{ id: "comment_1", content: "评论内容", author: "评论用户", raw: { reply_comment_total: 2 } }],
          cursor: "20",
          has_more: true
        }
      });
    }
    if (requestUrl.includes("/api/v1/browser/update-cookie")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.match(String(body.cookie), /sessionid=xxx/);
      return jsonResponse({ success: true, data: { updatedCookies: 2 } });
    }
    throw new Error(`Unexpected fetch ${requestUrl}`);
  };

  try {
    const search = await callApi({
      method: "GET",
      pathname: "/api/douyin/web/search_videos?keyword=%E8%AF%BE%E7%A8%8B&count=20",
      token: "secret-token"
    });
    assert.equal(search.status, 200);
    assert.equal(search.payload.code, 200);
    assert.equal(search.payload.data.videos[0].aweme_id, "738xxx");
    assert.equal(search.payload.data.videos[0].author.nickname, "作者昵称");

    const aweme = await callApi({
      method: "GET",
      pathname: "/api/douyin/web/get_aweme_id?url=https%3A%2F%2Fwww.douyin.com%2Fvideo%2F738xxx",
      token: "secret-token"
    });
    assert.equal(aweme.payload.data, "738xxx");

    const detail = await callApi({
      method: "GET",
      pathname: "/api/douyin/web/fetch_one_video?aweme_id=738xxx",
      token: "secret-token"
    });
    assert.equal(detail.payload.data.aweme_detail.aweme_id, "738xxx");
    assert.equal(detail.payload.data.aweme_detail.desc, "视频文案");

    const comments = await callApi({
      method: "GET",
      pathname: "/api/douyin/web/fetch_video_comments?aweme_id=738xxx&cursor=0&count=20",
      token: "secret-token"
    });
    assert.equal(comments.payload.data.comments[0].cid, "comment_1");
    assert.equal(comments.payload.data.comments[0].text, "评论内容");
    assert.equal(comments.payload.data.has_more, true);

    const replies = await callApi({
      method: "GET",
      pathname: "/api/douyin/web/fetch_video_comment_replies?aweme_id=738xxx&comment_id=comment_1",
      token: "secret-token"
    });
    assert.equal(replies.payload.data.comments[0].reply_id, "comment_1");

    const cookie = await callApi({
      method: "POST",
      pathname: "/api/douyin/web/update_cookie",
      token: "secret-token",
      body: { service: "douyin", cookie: "sid_guard=xxx; sessionid=xxx;" }
    });
    assert.equal(cookie.payload.data.message, "Cookie for douyin updated successfully");
    assert.equal(calls.some((item) => item.includes("/api/v1/browser/update-cookie")), true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("XHS_API_TOKEN", originalToken);
    restoreEnv("DOUYIN_SERVICE_URL", originalBaseUrl);
  }
});

test("serverx-compatible Douyin API maps platform challenge to 40102", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.XHS_API_TOKEN;
  const originalBaseUrl = process.env.DOUYIN_SERVICE_URL;
  process.env.XHS_API_TOKEN = "secret-token";
  process.env.DOUYIN_SERVICE_URL = "http://fake-douyin.local";

  globalThis.fetch = async () =>
    jsonResponse(
      {
        success: false,
        error: {
          code: "CHALLENGE_REQUIRED",
          message: "Douyin challenge required. Open the Douyin noVNC viewer, complete the verification, sync cookies/storage, then retry."
        }
      },
      428
    );

  try {
    const response = await callApi({
      method: "GET",
      pathname: "/api/douyin/web/search_videos?keyword=test",
      token: "secret-token"
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.code, 40102);
    assert.match(response.payload.message, /Douyin challenge required/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("XHS_API_TOKEN", originalToken);
    restoreEnv("DOUYIN_SERVICE_URL", originalBaseUrl);
  }
});

test("serverx-compatible Douyin API returns business error envelope for cancelled upstream tasks", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.XHS_API_TOKEN;
  const originalBaseUrl = process.env.DOUYIN_SERVICE_URL;
  process.env.XHS_API_TOKEN = "secret-token";
  process.env.DOUYIN_SERVICE_URL = "http://fake-douyin.local";

  globalThis.fetch = async () =>
    jsonResponse(
      {
        success: false,
        error: {
          code: "CLIENT_CLOSED_REQUEST",
          message: "Browser task queue reset: dashboard worker recovery: douyin"
        }
      },
      499
    );

  try {
    const response = await callApi({
      method: "GET",
      pathname: "/api/douyin/web/fetch_one_video?aweme_id=738xxx",
      token: "secret-token"
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.code, 50001);
    assert.match(response.payload.message, /queue reset/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("XHS_API_TOKEN", originalToken);
    restoreEnv("DOUYIN_SERVICE_URL", originalBaseUrl);
  }
});

test("serverx-compatible Douyin API returns business error envelope for upstream timeouts", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.XHS_API_TOKEN;
  const originalBaseUrl = process.env.DOUYIN_SERVICE_URL;
  process.env.XHS_API_TOKEN = "secret-token";
  process.env.DOUYIN_SERVICE_URL = "http://fake-douyin.local";

  globalThis.fetch = async () =>
    jsonResponse(
      {
        success: false,
        error: {
          code: "UPSTREAM_TIMEOUT",
          message: "Douyin reply page fallback timed out after 32000ms."
        }
      },
      504
    );

  try {
    const response = await callApi({
      method: "GET",
      pathname: "/api/douyin/web/fetch_video_comment_replies?aweme_id=738xxx&comment_id=comment_1",
      token: "secret-token"
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.code, 50001);
    assert.match(response.payload.message, /fallback timed out/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("XHS_API_TOKEN", originalToken);
    restoreEnv("DOUYIN_SERVICE_URL", originalBaseUrl);
  }
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

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
