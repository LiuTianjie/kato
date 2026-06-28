import assert from "node:assert/strict";
import test from "node:test";
import { extractItemsWithLlm, isParseFallbackEnabled } from "../src/llm/parseFallback.js";

const SAMPLE_PAYLOAD = {
  data: [
    { item_id: "v1", caption: "深度学习入门", uname: "AI老师" },
    { item_id: "v2", caption: "提示词技巧", uname: "效率达人" }
  ]
};

test("parse fallback is disabled by default", () => {
  const env = snapshot();
  try {
    delete process.env.KATO_LLM_PARSE_FALLBACK;
    process.env.ARK_API_KEY = "k";
    process.env.ARK_MODEL = "m";
    assert.equal(isParseFallbackEnabled(), false);
  } finally {
    env.restore();
  }
});

test("parse fallback requires both flag and ARK key", () => {
  const env = snapshot();
  try {
    process.env.KATO_LLM_PARSE_FALLBACK = "1";
    delete process.env.ARK_API_KEY;
    assert.equal(isParseFallbackEnabled(), false);
    process.env.ARK_API_KEY = "k";
    process.env.ARK_MODEL = "m";
    assert.equal(isParseFallbackEnabled(), true);
  } finally {
    env.restore();
  }
});

test("extractItemsWithLlm returns null when disabled (no fetch)", async () => {
  const env = snapshot();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    delete process.env.KATO_LLM_PARSE_FALLBACK;
    const result = await extractItemsWithLlm({ platform: "douyin", kind: "video", payload: SAMPLE_PAYLOAD, fieldHint: "x" });
    assert.equal(result, null);
    assert.equal(calls, 0, "disabled fallback must not call the model");
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

test("extractItemsWithLlm parses items from model response", async () => {
  const env = snapshot();
  const originalFetch = globalThis.fetch;
  process.env.KATO_LLM_PARSE_FALLBACK = "1";
  process.env.ARK_API_KEY = "k";
  process.env.ARK_MODEL = "m";
  let sentPayload = "";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    sentPayload = body.messages.at(-1)?.content ?? "";
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"items":[{"aweme_id":"v1","desc":"深度学习入门","author":{"nickname":"AI老师"}},{"aweme_id":"v2","desc":"提示词技巧","author":{"nickname":"效率达人"}}]}'
            }
          }
        ]
      }),
      { status: 200 }
    );
  };
  try {
    const result = await extractItemsWithLlm({
      platform: "douyin",
      kind: "video",
      payload: SAMPLE_PAYLOAD,
      fieldHint: "aweme_id、desc、author:{nickname}"
    });
    assert.ok(result, "should recover items");
    assert.equal(result?.length, 2);
    assert.equal((result?.[0] as Record<string, unknown>).aweme_id, "v1");
    assert.match(sentPayload, /原始 JSON/);
    assert.match(sentPayload, /v1/);
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

test("extractItemsWithLlm returns null on HTTP error (never throws)", async () => {
  const env = snapshot();
  const originalFetch = globalThis.fetch;
  process.env.KATO_LLM_PARSE_FALLBACK = "1";
  process.env.ARK_API_KEY = "k";
  process.env.ARK_MODEL = "m";
  globalThis.fetch = async () => new Response("upstream down", { status: 500 });
  try {
    const result = await extractItemsWithLlm({ platform: "douyin", kind: "video", payload: SAMPLE_PAYLOAD, fieldHint: "x" });
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

test("extractItemsWithLlm returns null on non-JSON model output", async () => {
  const env = snapshot();
  const originalFetch = globalThis.fetch;
  process.env.KATO_LLM_PARSE_FALLBACK = "1";
  process.env.ARK_API_KEY = "k";
  process.env.ARK_MODEL = "m";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "完全不是 JSON 的回答" } }] }), { status: 200 });
  try {
    const result = await extractItemsWithLlm({ platform: "douyin", kind: "video", payload: SAMPLE_PAYLOAD, fieldHint: "x" });
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

test("extractItemsWithLlm returns null when model finds nothing (empty array)", async () => {
  const env = snapshot();
  const originalFetch = globalThis.fetch;
  process.env.KATO_LLM_PARSE_FALLBACK = "1";
  process.env.ARK_API_KEY = "k";
  process.env.ARK_MODEL = "m";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }), { status: 200 });
  try {
    const result = await extractItemsWithLlm({ platform: "douyin", kind: "comment", payload: SAMPLE_PAYLOAD, fieldHint: "x" });
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
    env.restore();
  }
});

function snapshot(): { restore: () => void } {
  const keys = ["KATO_LLM_PARSE_FALLBACK", "ARK_API_KEY", "ARK_MODEL", "ARK_BASE_URL"];
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
