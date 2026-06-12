import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { createXhsAdapter } from "../src/adapters/xhsMcp.js";

test("http adapter parses XHS browser service REST search data.feeds responses", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];

  globalThis.fetch = async (_input, init) => {
    urls.push(String(_input));
    assert.equal(init?.method, undefined);
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          feeds: [
            {
              xsecToken: "xsec-token",
              id: "feed-1",
              noteCard: {
                displayTitle: "AI工具真实搜索结果",
                user: { nickname: "作者A" },
                interactInfo: {
                  likedCount: "433",
                  commentCount: "22"
                }
              }
            }
          ],
          count: 1
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const adapter = createXhsAdapter(httpConfig());
    const posts = await adapter.searchPosts("AI工具", 5);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, "feed-1");
    assert.equal(posts[0].xsecToken, "xsec-token");
    assert.equal(posts[0].author, "作者A");
    assert.equal(posts[0].likeCount, 433);
    assert.equal(posts[0].commentCount, 22);
    assert.match(posts[0].url, /xiaohongshu\.com\/explore\/feed-1/);

    assert.equal(urls.length, 1);
    assert.match(urls[0], /^http:\/\/fake\.local\/api\/v1\/feeds\/search\?keyword=AI/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("http adapter publishes plain comment text through REST without related note metadata", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(_input), body });
    return new Response(JSON.stringify({ success: true, data: { posted: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const adapter = createXhsAdapter(httpConfig());
    await adapter.publishComment(
      {
        id: "target-feed",
        url: "https://www.xiaohongshu.com/explore/target-feed?xsec_token=target-token",
        title: "目标帖子",
        snippet: "目标内容",
        xsecToken: "target-token"
      },
      "这是一条确认发布的评论"
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://fake.local/api/v1/feeds/comment");
    assert.equal(calls[0].body.feed_id, "target-feed");
    assert.equal(calls[0].body.xsec_token, "target-token");
    assert.equal(calls[0].body.content, "这是一条确认发布的评论");
    assert.equal(calls[0].body.related_feed_id, undefined);
    assert.equal(calls[0].body.related_xsec_token, undefined);
    assert.equal(calls[0].body.related_title, undefined);
    assert.equal(calls[0].body.related_url, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function httpConfig(): AppConfig {
  return {
    rootDir: "/tmp/redbook-adapter-test",
    dataDir: "/tmp/redbook-adapter-test/data",
    outputDir: "/tmp/redbook-adapter-test/output",
    sqlitePath: "/tmp/redbook-adapter-test/data/app.sqlite",
    xhs: {
      provider: "http",
      mcp: { url: "http://fake.local/mcp" }
    }
  };
}
