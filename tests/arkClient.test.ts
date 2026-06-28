import assert from "node:assert/strict";
import test from "node:test";
import {
  ArkError,
  arkModelFor,
  callArk,
  canUseArk,
  parseArkJson,
  resetArkUsageTotals,
  getArkUsageTotals
} from "../src/llm/arkClient.js";

test("parseArkJson strips code fences and parses", () => {
  assert.deepEqual(parseArkJson('```json\n{"keep":true}\n```'), { keep: true });
  assert.deepEqual(parseArkJson('{"a":1}'), { a: 1 });
});

test("parseArkJson falls back to first brace block", () => {
  assert.deepEqual(parseArkJson('前面有噪声 {"keep":false} 后面有噪声'), { keep: false });
});

test("parseArkJson throws on non-JSON", () => {
  assert.throws(() => parseArkJson("完全不是 JSON", "test"), /did not return JSON/);
});

test("arkModelFor follows the documented fallback chains", () => {
  const settings = {
    baseUrl: "https://ark.test/api/v3",
    defaultModel: "default-m",
    fastModel: "fast-m",
    relevanceModel: "rel-m",
    contentModel: "content-m"
  };
  assert.equal(arkModelFor("relevance", settings), "rel-m");
  assert.equal(arkModelFor("content", settings), "content-m");
  assert.equal(arkModelFor("default", settings), "default-m");

  // relevance 降级到 fast 再到 default
  assert.equal(arkModelFor("relevance", { baseUrl: "x", defaultModel: "d", fastModel: "f" }), "f");
  assert.equal(arkModelFor("relevance", { baseUrl: "x", defaultModel: "d" }), "d");
  // content 降级到 default
  assert.equal(arkModelFor("content", { baseUrl: "x", defaultModel: "d" }), "d");
});

test("canUseArk requires key and resolvable model", () => {
  const originalKey = process.env.ARK_API_KEY;
  const originalModel = process.env.ARK_MODEL;
  try {
    process.env.ARK_API_KEY = "k";
    process.env.ARK_MODEL = "m";
    assert.equal(canUseArk("default"), true);
    delete process.env.ARK_API_KEY;
    assert.equal(canUseArk("default"), false);
    process.env.ARK_API_KEY = "k";
    delete process.env.ARK_MODEL;
    assert.equal(canUseArk("default"), false);
  } finally {
    restoreEnv("ARK_API_KEY", originalKey);
    restoreEnv("ARK_MODEL", originalModel);
  }
});

test("callArk throws non-retryable ArkError when key/model missing", async () => {
  const originalKey = process.env.ARK_API_KEY;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  delete process.env.ARK_API_KEY;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    await assert.rejects(callArk([{ role: "user", content: "hi" }], { model: "m" }), ArkError);
    assert.equal(calls, 0, "missing key must short-circuit before any fetch");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("ARK_API_KEY", originalKey);
  }
});

test("callArk retries on 5xx then succeeds, and records usage", async () => {
  const originalKey = process.env.ARK_API_KEY;
  const originalBaseUrl = process.env.ARK_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.ARK_API_KEY = "k";
  process.env.ARK_BASE_URL = "https://ark.test/api/v3";
  resetArkUsageTotals();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("upstream busy", { status: 503 });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }),
      { status: 200 }
    );
  };
  try {
    const content = await callArk([{ role: "user", content: "hi" }], { model: "m", retries: 2 });
    assert.equal(content, "ok");
    assert.equal(calls, 2, "should retry once after 503");
    assert.equal(getArkUsageTotals().totalTokens, 15);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("ARK_API_KEY", originalKey);
    restoreEnv("ARK_BASE_URL", originalBaseUrl);
  }
});

test("callArk does not retry on 400 and surfaces ArkError", async () => {
  const originalKey = process.env.ARK_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.ARK_API_KEY = "k";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  };
  try {
    await assert.rejects(callArk([{ role: "user", content: "hi" }], { model: "m", retries: 3 }), ArkError);
    assert.equal(calls, 1, "4xx (except 408/429) must not retry");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("ARK_API_KEY", originalKey);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
