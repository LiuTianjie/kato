import assert from "node:assert/strict";
import test from "node:test";
import type { Note, ScoredPost } from "../src/domain/types.js";
import { generateComment, generateInteractionDraft } from "../src/runs/commentProvider.js";

test("local comment provider returns a concrete non-template comment", async () => {
  const originalProvider = process.env.COMMENT_PROVIDER;
  delete process.env.COMMENT_PROVIDER;
  try {
    const comment = await generateComment(samplePost(), sampleNote());
    assert.ok(comment.length >= 40);
    assert.ok(comment.length <= 90);
    assert.match(comment, /AI工具|流程|提示词/);
    assert.match(comment, /「AI效率工具工作流」/);
  } finally {
    restoreEnv("COMMENT_PROVIDER", originalProvider);
  }
});

test("ark comment provider calls the configured chat completions endpoint", async () => {
  const originalProvider = process.env.COMMENT_PROVIDER;
  const originalKey = process.env.ARK_API_KEY;
  const originalModel = process.env.ARK_MODEL;
  const originalBaseUrl = process.env.ARK_BASE_URL;
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | null = null;

  process.env.COMMENT_PROVIDER = "ark";
  process.env.ARK_API_KEY = "test-key";
  process.env.ARK_MODEL = "test-model";
  process.env.ARK_BASE_URL = "https://ark.test/api/v3";
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body));
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "这个工作流拆得挺实用，尤其是把输入和复盘固定下来。我之前也整理过类似流程，发现先定判断标准会更稳。"
            }
          }
        ]
      }),
      { status: 200 }
    );
  };

  try {
    const comment = await generateComment(samplePost(), sampleNote());
    assert.equal(capturedUrl, "https://ark.test/api/v3/chat/completions");
    assert.equal(capturedBody?.model, "test-model");
    assert.ok(comment.length <= 90);
    assert.match(comment, /工作流/);
    assert.match(comment, /「AI效率工具工作流」/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("COMMENT_PROVIDER", originalProvider);
    restoreEnv("ARK_API_KEY", originalKey);
    restoreEnv("ARK_MODEL", originalModel);
    restoreEnv("ARK_BASE_URL", originalBaseUrl);
  }
});

test("ark interaction agent selects a note and returns a comment draft", async () => {
  const originalProvider = process.env.COMMENT_PROVIDER;
  const originalKey = process.env.ARK_API_KEY;
  const originalModel = process.env.ARK_MODEL;
  const originalBaseUrl = process.env.ARK_BASE_URL;
  const originalFetch = globalThis.fetch;

  process.env.COMMENT_PROVIDER = "ark";
  process.env.ARK_API_KEY = "test-key";
  process.env.ARK_MODEL = "test-model";
  process.env.ARK_BASE_URL = "https://ark.test/api/v3";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    assert.match(body.messages.at(-1)?.content ?? "", /我的笔记库/);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"noteId":1,"comment":"你说的输入、判断、输出固定下来很关键。我之前也整理过类似流程，发现先把判断标准写清楚，后面复盘和自动化都会稳很多。","rationale":"关键词和场景都匹配"}'
            }
          }
        ]
      }),
      { status: 200 }
    );
  };

  try {
    const result = await generateInteractionDraft(samplePost(), [sampleNote()]);
    assert.equal(result.note?.id, 1);
    assert.match(result.comment, /判断标准/);
    assert.match(result.comment, /「AI效率工具工作流」/);
    assert.ok(result.comment.length <= 90);
    assert.doesNotMatch(result.comment, /https?:\/\//);
    assert.doesNotMatch(result.comment, /xiaohongshu\.com/);
    assert.match(result.rationale, /匹配/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("COMMENT_PROVIDER", originalProvider);
    restoreEnv("ARK_API_KEY", originalKey);
    restoreEnv("ARK_MODEL", originalModel);
    restoreEnv("ARK_BASE_URL", originalBaseUrl);
  }
});

test("comment sanitizer removes URLs from model output", async () => {
  const originalProvider = process.env.COMMENT_PROVIDER;
  const originalKey = process.env.ARK_API_KEY;
  const originalModel = process.env.ARK_MODEL;
  const originalBaseUrl = process.env.ARK_BASE_URL;
  const originalFetch = globalThis.fetch;

  process.env.COMMENT_PROVIDER = "ark";
  process.env.ARK_API_KEY = "test-key";
  process.env.ARK_MODEL = "test-model";
  process.env.ARK_BASE_URL = "https://ark.test/api/v3";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "你这个点很实用，我之前也整理过类似流程，先把判断标准固定下来会稳很多 https://www.xiaohongshu.com/example-note-1?xsec_token=abc"
            }
          }
        ]
      }),
      { status: 200 }
    );

  try {
    const comment = await generateComment(samplePost(), sampleNote());
    assert.match(comment, /判断标准/);
    assert.match(comment, /「AI效率工具工作流」/);
    assert.ok(comment.length <= 90);
    assert.doesNotMatch(comment, /https?:\/\//);
    assert.doesNotMatch(comment, /xiaohongshu\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("COMMENT_PROVIDER", originalProvider);
    restoreEnv("ARK_API_KEY", originalKey);
    restoreEnv("ARK_MODEL", originalModel);
    restoreEnv("ARK_BASE_URL", originalBaseUrl);
  }
});

test("comment sanitizer caps overlong model output", async () => {
  const originalProvider = process.env.COMMENT_PROVIDER;
  const originalKey = process.env.ARK_API_KEY;
  const originalModel = process.env.ARK_MODEL;
  const originalBaseUrl = process.env.ARK_BASE_URL;
  const originalFetch = globalThis.fetch;

  process.env.COMMENT_PROVIDER = "ark";
  process.env.ARK_API_KEY = "test-key";
  process.env.ARK_MODEL = "test-model";
  process.env.ARK_BASE_URL = "https://ark.test/api/v3";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "你这条讲得很细，尤其是把输入、判断、输出和复盘都固定下来这一点很关键。很多人卡住不是工具不够多，而是不知道怎么把流程变成每天真的会用的动作。我之前也整理过类似的AI效率工具工作流，发现先把判断标准写清楚，后面复盘和自动化都会稳很多。"
            }
          }
        ]
      }),
      { status: 200 }
    );

  try {
    const comment = await generateComment(samplePost(), sampleNote());
    assert.ok(comment.length <= 90);
    assert.match(comment, /「AI效率工具工作流」/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("COMMENT_PROVIDER", originalProvider);
    restoreEnv("ARK_API_KEY", originalKey);
    restoreEnv("ARK_MODEL", originalModel);
    restoreEnv("ARK_BASE_URL", originalBaseUrl);
  }
});

function samplePost(): ScoredPost {
  return {
    id: "sample-002",
    url: "https://www.xiaohongshu.com/explore/sample-002",
    title: "ChatGPT工作流怎么真正落地",
    snippet: "不是收藏一堆提示词，而是把输入、判断、输出和复盘都固定下来。",
    author: "AI实操笔记",
    likeCount: 256,
    commentCount: 76,
    publishedAt: "2026-05-09T13:10:00+08:00",
    score: 34.5,
    matchedKeywords: ["ChatGPT工作流", "AI工具"],
    reason: "命中关键词：ChatGPT工作流、AI工具；评论区已有讨论热度"
  };
}

function sampleNote(): Note {
  return {
    id: 1,
    title: "AI效率工具工作流",
    url: "https://www.xiaohongshu.com/example-note-1",
    summary: "整理了从信息收集到自动化执行的AI工具组合和避坑经验",
    keywords: ["AI工具", "效率工具", "ChatGPT工作流"],
    scenarios: ["有人分享效率流程", "有人卡在自动化落地"],
    status: "active"
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
