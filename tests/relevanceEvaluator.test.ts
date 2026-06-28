import assert from "node:assert/strict";
import test from "node:test";
import type { Note, ScoredPost } from "../src/domain/types.js";
import { evaluatePostRelevance, shouldUseArkRelevance } from "../src/runs/relevanceEvaluator.js";

test("relevance evaluator uses rules when ARK is not configured", async () => {
  const env = snapshotArkEnv();
  delete process.env.RELEVANCE_PROVIDER;
  delete process.env.COMMENT_PROVIDER;
  try {
    assert.equal(shouldUseArkRelevance(), false);
    const decision = await evaluatePostRelevance(samplePost(), [sampleNote()], ["AI工具"]);
    assert.equal(decision.source, "rules");
    assert.equal(decision.keep, true);
  } finally {
    env.restore();
  }
});

test("relevance evaluator falls back to rules when ARK call fails (never throws)", async () => {
  const env = snapshotArkEnv();
  const originalFetch = globalThis.fetch;
  process.env.RELEVANCE_PROVIDER = "ark";
  process.env.ARK_API_KEY = "k";
  process.env.ARK_MODEL = "m";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("upstream down", { status: 500 });
  };
  try {
    assert.equal(shouldUseArkRelevance(), true);
    // ARK 持续 500,重试耗尽后必须静默回退规则,而不是把错误抛给采集主流程
    const decision = await evaluatePostRelevance(samplePost(), [sampleNote()], ["AI工具"]);
    assert.equal(decision.source, "rules");
    assert.ok(calls >= 1, "ARK should have been attempted");
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

test("relevance evaluator rejects spam posts by rules", async () => {
  const env = snapshotArkEnv();
  delete process.env.RELEVANCE_PROVIDER;
  delete process.env.COMMENT_PROVIDER;
  try {
    const spam: ScoredPost = {
      ...samplePost(),
      title: "互赞互关抽奖",
      snippet: "互赞互关，低价代发，薅羊毛",
      matchedKeywords: [],
      score: 5
    };
    const decision = await evaluatePostRelevance(spam, [sampleNote()], ["AI工具"]);
    assert.equal(decision.keep, false);
    assert.equal(decision.source, "rules");
  } finally {
    env.restore();
  }
});

function samplePost(): ScoredPost {
  return {
    id: "post-1",
    url: "https://www.xiaohongshu.com/explore/abc123",
    title: "我常用的 AI工具 效率工作流",
    snippet: "分享几个把 AI工具 串进日常工作流的具体做法，附判断标准和复盘方式。",
    author: "效率研究所",
    likeCount: 200,
    commentCount: 30,
    score: 40,
    matchedKeywords: ["AI工具"],
    reason: "命中关键词：AI工具"
  };
}

function sampleNote(): Note {
  return {
    id: 1,
    title: "AI效率工具工作流",
    url: "https://www.xiaohongshu.com/explore/note1",
    summary: "整理常用 AI 工具如何串进日常工作流",
    keywords: ["AI工具", "效率", "工作流"],
    scenarios: ["日常办公", "内容创作"],
    status: "active"
  };
}

function snapshotArkEnv(): { restore: () => void } {
  const keys = ["RELEVANCE_PROVIDER", "COMMENT_PROVIDER", "RELEVANCE_EVALUATOR", "ARK_API_KEY", "ARK_MODEL", "ARK_RELEVANCE_MODEL", "ARK_FAST_MODEL"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  return {
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}
