import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handlePublicBilibiliApi } from "../src/dashboard/publicBilibiliApi.js";

test("serverx-compatible Bilibili API exposes video endpoints and cookie update", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.XHS_API_TOKEN;
  const originalBaseUrl = process.env.BILIBILI_SERVICE_URL;
  const calls: string[] = [];
  process.env.XHS_API_TOKEN = "secret-token";
  process.env.BILIBILI_SERVICE_URL = "http://fake-bilibili.local";

  globalThis.fetch = async (input, init) => {
    const requestUrl = String(input);
    calls.push(requestUrl);
    if (requestUrl.includes("/api/v1/videos/search")) {
      return jsonResponse({
        success: true,
        data: {
          result: [
            {
              bvid: "BV1xx",
              aid: 123456,
              title: "视频标题",
              author: "UP主昵称",
              mid: 123
            }
          ],
          page: { pn: 1, ps: 20, count: 100 }
        }
      });
    }
    if (requestUrl.includes("/api/v1/videos/detail")) {
      return jsonResponse({
        success: true,
        data: {
          bvid: "BV1xx",
          aid: 123456,
          cid: 789,
          title: "视频标题",
          owner: { mid: 123, name: "UP主昵称" },
          stat: { view: 1000, reply: 15, favorite: 20, coin: 3, share: 2, like: 50 }
        }
      });
    }
    if (requestUrl.includes("/api/v1/videos/comment_replies")) {
      return jsonResponse({
        success: true,
        data: {
          replies: [
            {
              rpid: "222",
              parent: "111",
              root: "111",
              content: { message: "子评论内容" },
              member: { mid: "123", uname: "评论用户" }
            }
          ],
          page: { num: 1, size: 20, count: 10 }
        }
      });
    }
    if (requestUrl.includes("/api/v1/videos/comments")) {
      return jsonResponse({
        success: true,
        data: {
          replies: [
            {
              rpid: "111",
              parent: "0",
              root: "0",
              content: { message: "评论内容" },
              member: { mid: "123", uname: "评论用户" },
              rcount: 2
            }
          ],
          page: { num: 1, size: 20, count: 100 }
        }
      });
    }
    if (requestUrl.includes("/api/v1/browser/update-cookie")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.match(String(body.cookie), /SESSDATA=xxx/);
      return jsonResponse({ success: true, data: { updated: true } });
    }
    throw new Error(`Unexpected fetch ${requestUrl}`);
  };

  try {
    const search = await callApi({
      method: "GET",
      pathname: "/api/bilibili/web/search_videos?keyword=%E8%AF%BE%E7%A8%8B&pn=1&ps=20",
      token: "secret-token"
    });
    assert.equal(search.status, 200);
    assert.equal(search.payload.code, 200);
    assert.equal(search.payload.data.result[0].bvid, "BV1xx");
    assert.equal(search.payload.data.result[0].author, "UP主昵称");

    const detail = await callApi({
      method: "GET",
      pathname: "/api/bilibili/web/fetch_one_video?bvid=BV1xx",
      token: "secret-token"
    });
    assert.equal(detail.payload.data.bvid, "BV1xx");
    assert.equal(detail.payload.data.owner.name, "UP主昵称");

    const comments = await callApi({
      method: "GET",
      pathname: "/api/bilibili/web/fetch_video_comments?bvid=BV1xx&pn=1&ps=20",
      token: "secret-token"
    });
    assert.equal(comments.payload.data.replies[0].rpid, "111");
    assert.equal(comments.payload.data.replies[0].content.message, "评论内容");

    const replies = await callApi({
      method: "GET",
      pathname: "/api/bilibili/web/fetch_comment_reply?bvid=BV1xx&root=111",
      token: "secret-token"
    });
    assert.equal(replies.payload.data.replies[0].root, "111");

    const cookie = await callApi({
      method: "POST",
      pathname: "/api/bilibili/web/update_cookie",
      token: "secret-token",
      body: { service: "bilibili", cookie: "SESSDATA=xxx; bili_jct=xxx;" }
    });
    assert.equal(cookie.payload.data.message, "Cookie for bilibili updated successfully");
    assert.equal(calls.some((item) => item.includes("/api/v1/browser/update-cookie")), true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("XHS_API_TOKEN", originalToken);
    restoreEnv("BILIBILI_SERVICE_URL", originalBaseUrl);
  }
});

test("serverx-compatible Bilibili API returns standard error code without token", async () => {
  const originalToken = process.env.XHS_API_TOKEN;
  process.env.XHS_API_TOKEN = "secret-token";
  try {
    const response = await callApi({
      method: "GET",
      pathname: "/api/bilibili/web/search_videos?keyword=test"
    });
    assert.equal(response.status, 401);
    assert.equal(response.payload.code, 40101);
    assert.equal(response.payload.data, null);
  } finally {
    restoreEnv("XHS_API_TOKEN", originalToken);
  }
});

test("serverx-compatible Bilibili API maps cookie challenge to 40101", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.XHS_API_TOKEN;
  const originalBaseUrl = process.env.BILIBILI_SERVICE_URL;
  process.env.XHS_API_TOKEN = "secret-token";
  process.env.BILIBILI_SERVICE_URL = "http://fake-bilibili.local";
  globalThis.fetch = async () =>
    jsonResponse(
      {
        success: false,
        error: { code: "COOKIE_EXPIRED", message: "cookie expired or anti-bot challenge" }
      },
      401
    );
  try {
    const response = await callApi({
      method: "GET",
      pathname: "/api/bilibili/web/search_videos?keyword=test",
      token: "secret-token"
    });
    assert.equal(response.status, 401);
    assert.equal(response.payload.code, 40101);
    assert.equal(response.payload.message, "cookie expired or anti-bot challenge");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("XHS_API_TOKEN", originalToken);
    restoreEnv("BILIBILI_SERVICE_URL", originalBaseUrl);
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

  const handled = await handlePublicBilibiliApi(req, res, new URL(options.pathname, "http://localhost"));
  assert.equal(handled, true);
  return { status: Number(res.statusCode), payload: responseBody ? JSON.parse(responseBody) : undefined };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
