import assert from "node:assert/strict";
import test from "node:test";
import { createDouyinAdapter } from "../src/adapters/douyin.js";

test("douyin adapter parses search service responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.DOUYIN_SERVICE_URL;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  process.env.DOUYIN_SERVICE_URL = "http://fake-douyin.local";

  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          posts: [
            {
              id: "7372484719365098803",
              url: "https://www.douyin.com/video/7372484719365098803",
              title: "课程体验反馈",
              snippet: "课程体验反馈 正文",
              author: "用户A",
              likeCount: 12,
              commentCount: 3,
              raw: { aweme_id: "7372484719365098803", desc: "课程体验反馈" }
            }
          ]
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const adapter = createDouyinAdapter();
    const posts = await adapter.searchPosts("课程", 5);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].platform, "douyin");
    assert.equal(posts[0].id, "7372484719365098803");
    assert.equal(posts[0].author, "用户A");
    assert.equal(posts[0].commentCount, 3);
    assert.equal(calls[0].url, "http://fake-douyin.local/api/v1/posts/search");
    assert.equal(calls[0].body.keyword, "课程");
    assert.equal(calls[0].body.limit, 5);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("DOUYIN_SERVICE_URL", originalBaseUrl);
  }
});

test("douyin adapter reads comments and preserves parent ids", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.DOUYIN_SERVICE_URL;
  process.env.DOUYIN_SERVICE_URL = "http://fake-douyin.local";

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: true,
        data: {
          comments: [
            {
              id: "comment-1",
              content: "这个体验不好",
              author: "用户B",
              parentId: "parent-1",
              raw: { cid: "comment-1", text: "这个体验不好" }
            }
          ],
          cursor: "20",
          has_more: true
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  try {
    const adapter = createDouyinAdapter();
    const comments = await adapter.getComments?.("https://www.douyin.com/video/7372484719365098803", 10);
    assert.equal(comments?.length, 1);
    assert.equal(comments?.[0].platform, "douyin");
    assert.equal(comments?.[0].id, "comment-1");
    assert.equal(comments?.[0].parentId, "parent-1");
    assert.deepEqual((comments?.[0].raw as { cid?: string }).cid, "comment-1");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("DOUYIN_SERVICE_URL", originalBaseUrl);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
