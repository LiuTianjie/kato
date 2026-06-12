import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { initSchema } from "../src/db/schema.js";
import { listNotes } from "../src/notes/repository.js";
import { syncMyXhsNotes } from "../src/notes/syncXhs.js";

test("syncMyXhsNotes imports current profile feeds into the note library", async () => {
  const fixture = createFixture();
  const originalFetch = globalThis.fetch;
  const db = openDb(fixture.config);
  const logs: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/user/me")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            data: {
              userBasicInfo: { nickname: "运营号" },
              feeds: [
                {
                  id: "note-1",
                  xsecToken: "xsec-1",
                  noteCard: {
                    displayTitle: "AI效率工具工作流"
                  }
                }
              ]
            }
          }
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/api/v1/feeds/detail") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            feed_id: "note-1",
            data: {
              note: {
                noteId: "note-1",
                xsecToken: "xsec-1",
                title: "AI效率工具工作流",
                desc: "整理从信息收集到自动化执行的 AI 工具组合和避坑经验。"
              }
            }
          }
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    initSchema(db);
    const result = await syncMyXhsNotes(db, fixture.config, {
      limit: 10,
      logger: { log: (message) => logs.push(message) }
    });
    assert.deepEqual(result, { imported: 1, skipped: 0, profileName: "运营号" });
    const notes = listNotes(db);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, "AI效率工具工作流");
    assert.match(notes[0].summary, /自动化执行/);
    assert.equal(notes[0].status, "active");
    assert.ok(logs.some((line) => line.includes("MCP 获取当前登录账号主页")));
    assert.ok(logs.some((line) => line.includes("MCP 读取我的笔记详情")));
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

function createFixture(): { rootDir: string; config: AppConfig } {
  const rootDir = path.join(tmpdir(), `redbook-sync-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const dataDir = path.join(rootDir, "data");
  const outputDir = path.join(rootDir, "output");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  return {
    rootDir,
    config: {
      rootDir,
      dataDir,
      outputDir,
      sqlitePath: path.join(dataDir, "app.sqlite"),
      xhs: {
        provider: "http",
        mcp: { url: "http://xhs.local/mcp" }
      }
    }
  };
}
