import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import { loadConfig } from "../config.js";
import { runGrowthAgent } from "../agent/growthAgent.js";
import { runContentAgent } from "../content/agent.js";
import { publishContentDraft } from "../content/publisher.js";
import {
  getActivePersona,
  getContentProjectDetail,
  listContentProjects,
  saveContentEvent,
  saveAccountPersona,
  suggestAccountPersona,
  updateContentDraftBody,
  updateContentDraftStatus
} from "../content/repository.js";
import { openDb } from "../db/client.js";
import { initSchema } from "../db/schema.js";
import type { ContentType } from "../domain/types.js";
import { listActiveNotes } from "../notes/importNotes.js";
import { listNotes, saveNote, updateNoteStatus } from "../notes/repository.js";
import { syncMyXhsNotes } from "../notes/syncXhs.js";
import { parseKeywordArg } from "../runs/keywords.js";
import { searchOnlyPosts } from "../runs/searchOnly.js";
import { generateDraftsForInteractions } from "../runs/generateDrafts.js";
import { generateAndPublishInteractions } from "../runs/generateAndPublish.js";
import { publishConfirmedInteractions } from "../runs/publish.js";
import { getDefaultCdpPort, openCdpLoginWindow, syncCdpCookiesToMcp } from "../auth/cdpLogin.js";
import {
  captureCdpLoginFrame,
  dispatchCdpBrowserAction,
  dispatchCdpLoginInput,
  getCdpLoginTarget,
  streamCdpBrowserFrames
} from "../auth/cdpRemote.js";
import {
  getDashboardStats,
  getInteractions,
  getRecentRuns,
  updateInteractionDraft,
  updateInteractionStatus
} from "./queries.js";
import { handlePublicXhsApi, isPublicXhsApiPath } from "./publicXhsApi.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.outputDir, { recursive: true });
const db = openDb(config);
initSchema(db);

const publicDir = path.join(config.rootDir, "public");
const debugScreenshotDir = path.join(config.rootDir, "mcp", "xiaohongshu", "data", "debug");
const port = Number(process.env.PORT ?? 4173);
const browserRuntimeUrl =
  process.env.BROWSER_RUNTIME_URL ||
  process.env.XHS_BROWSER_RUNTIME_URL ||
  `http://127.0.0.1:${process.env.BROWSER_RUNTIME_PORT || process.env.XHS_BROWSER_RUNTIME_PORT || 18100}`;
const noVncHost = process.env.BROWSER_NOVNC_HOST || process.env.XHS_NOVNC_HOST || "127.0.0.1";
const noVncPort = Number(process.env.BROWSER_NOVNC_PORT || process.env.XHS_NOVNC_PORT || 6080);
const noVncViewerUrl = "/novnc/vnc.html?autoconnect=1&resize=scale&path=novnc/websockify";
const legacyCdpLoginEnabled =
  process.env.KATO_ENABLE_LEGACY_CDP_LOGIN === "1" || process.env.XHS_LEGACY_CDP_LOGIN_ENABLED === "1";
type OperationState = "running" | "completed" | "failed" | "cancelled";
class OperationCancelledError extends Error {
  constructor(message = "操作已取消") {
    super(message);
    this.name = "OperationCancelledError";
  }
}
interface Operation {
  id: string;
  name: string;
  state: OperationState;
  logs: string[];
  itemStatuses: Record<string, string>;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  cancelRequested?: boolean;
}
const operations = new Map<string, Operation>();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/novnc")) {
      proxyNoVncHttp(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/api/") || isPublicXhsApiPath(url.pathname)) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/novnc")) {
    socket.destroy();
    return;
  }
  proxyNoVncUpgrade(req, socket, head, url);
});

server.listen(port, () => {
  console.log(`Dashboard: http://localhost:${port}`);
});

process.on("SIGINT", () => {
  db.close();
  server.close(() => process.exit(0));
});

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (await handlePublicXhsApi(req, res, url, { config, db })) return;

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(res, 200, {
      ...getDashboardStats(db),
      notes: listNotes(db)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/notes") {
    sendJson(res, 200, { notes: listNotes(db) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/account-persona") {
    const persona = getActivePersona(db);
    sendJson(res, 200, { persona: persona ?? suggestAccountPersona(db), generated: !persona });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/account-persona") {
    const body = await readJson(req);
    sendJson(res, 200, {
      persona: saveAccountPersona(db, {
        name: String(body.name ?? ""),
        positioning: String(body.positioning ?? ""),
        targetReaders: String(body.targetReaders ?? ""),
        tone: String(body.tone ?? ""),
        commonPhrases: asStringArray(body.commonPhrasesAsArray) ?? String(body.commonPhrases ?? ""),
        bannedPhrases: asStringArray(body.bannedPhrasesAsArray) ?? String(body.bannedPhrases ?? ""),
        experienceBank: String(body.experienceBank ?? ""),
        status: body.status === "paused" ? "paused" : "active"
      })
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/notes") {
    const body = await readJson(req);
    sendJson(res, 200, {
      note: saveNote(db, {
        id: optionalNumber(asScalar(body.id)),
        title: String(body.title ?? ""),
        url: String(body.url ?? ""),
        summary: String(body.summary ?? ""),
        keywords: asStringArray(body.keywordsAsArray) ?? String(body.keywords ?? ""),
        scenarios: asStringArray(body.scenariosAsArray) ?? String(body.scenarios ?? ""),
        status: body.status === "paused" ? "paused" : "active"
      })
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/notes/status") {
    const body = await readJson(req);
    const id = optionalNumber(asScalar(body.id));
    if (!id) throw new Error("Missing note id.");
    sendJson(res, 200, { note: updateNoteStatus(db, id, body.status === "paused" ? "paused" : "active") });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/notes/sync") {
    const body = await readJson(req);
    if (body.async) {
      const operation = startOperation("同步我的小红书笔记", async (logger) => {
        const result = await syncMyXhsNotes(db, config, { limit: optionalNumber(asScalar(body.limit)) ?? 30, logger });
        ensureGeneratedPersona(result.profileName, logger);
        return result;
      });
      sendJson(res, 202, { operationId: operation.id });
      return;
    }
    const result = await syncMyXhsNotes(db, config, { limit: optionalNumber(asScalar(body.limit)) ?? 30 });
    ensureGeneratedPersona(result.profileName);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/runs") {
    sendJson(res, 200, { runs: getRecentRuns(db, Number(url.searchParams.get("limit") ?? 30)) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/content-projects") {
    sendJson(res, 200, { projects: listContentProjects(db, Number(url.searchParams.get("limit") ?? 30)) });
    return;
  }

  if (req.method === "GET" && url.pathname.match(/^\/api\/content-projects\/\d+$/)) {
    const id = Number(url.pathname.split("/").filter(Boolean).at(-1));
    sendJson(res, 200, getContentProjectDetail(db, id));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/content-projects") {
    const body = await readJson(req);
    const keyword = String(body.keyword ?? "");
    const contentType = normalizeContentType(String(body.contentType ?? "auto"));
    const sourceLimit = optionalNumber(asScalar(body.sourceLimit)) ?? 8;
    if (body.async) {
      const operation = startOperation("内容生产", (logger) =>
        runContentAgent(db, config, {
          keyword,
          contentType,
          sourceLimit,
          logger
        })
      );
      sendJson(res, 202, { operationId: operation.id });
      return;
    }
    sendJson(res, 200, await runContentAgent(db, config, { keyword, contentType, sourceLimit }));
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/content-drafts\/\d+$/)) {
    const body = await readJson(req);
    const id = Number(url.pathname.split("/").filter(Boolean).at(-1));
    sendJson(res, 200, {
      draft: updateContentDraftBody(db, id, {
        titleCandidates: asStringArray(body.titleCandidates) ?? undefined,
        coverText: body.coverText == null ? undefined : String(body.coverText),
        body: body.body == null ? undefined : String(body.body),
        tags: asStringArray(body.tags) ?? undefined,
        imagePlan: asStringArray(body.imagePlan) ?? undefined,
        visualStyle: body.visualStyle == null ? undefined : String(body.visualStyle),
        imagePaths: asStringArray(body.imagePaths) ?? undefined
      })
    });
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/content-drafts\/\d+\/status$/)) {
    const body = await readJson(req);
    const id = Number(url.pathname.split("/").filter(Boolean).at(-2));
    const draft = updateContentDraftStatus(db, id, String(body.status ?? ""));
    saveContentEvent(db, {
      projectId: draft.projectId,
      level: "info",
      stage: "review",
      message: `草稿状态更新：${draft.status}`,
      metadata: { draftId: draft.id, status: draft.status }
    });
    sendJson(res, 200, { draft });
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/content-drafts\/\d+\/publish$/)) {
    const id = Number(url.pathname.split("/").filter(Boolean).at(-2));
    const body = await readJson(req);
    if (body.async) {
      const operation = startOperation("发布图文笔记", (logger) => publishContentDraft(db, config, id, logger));
      sendJson(res, 202, { operationId: operation.id });
      return;
    }
    sendJson(res, 200, await publishContentDraft(db, config, id));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/interactions") {
    sendJson(res, 200, {
      interactions: getInteractions(db, {
        runId: optionalNumber(url.searchParams.get("runId")),
        status: url.searchParams.get("status") ?? undefined,
        limit: optionalNumber(url.searchParams.get("limit")) ?? 120
      })
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/post-search") {
    const body = await readJson(req);
    const result = await searchOnlyPosts(config, {
      limit: Number(body.limit ?? 20),
      keywords: parseKeywordArg(typeof body.keywords === "string" ? body.keywords : undefined)
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/runs") {
    const body = await readJson(req);
    if (body.async) {
      const operation = startOperation("搜索帖子入队", (logger) =>
        runGrowthAgent(db, config, {
          limit: Number(body.limit ?? 30),
          keywords: parseKeywordArg(typeof body.keywords === "string" ? body.keywords : undefined),
          generateDrafts: Boolean(body.generateDrafts),
          logger
        })
      );
      sendJson(res, 202, { operationId: operation.id });
      return;
    }
    const result = await runGrowthAgent(db, config, {
      limit: Number(body.limit ?? 30),
      keywords: parseKeywordArg(typeof body.keywords === "string" ? body.keywords : undefined),
      generateDrafts: Boolean(body.generateDrafts)
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/interactions/generate") {
    const body = await readJson(req);
    if (body.async) {
      const ids = parseIds(body);
      const operation = startOperation("批量生成评论", (logger) =>
        generateDraftsForInteractions(db, config, ids, logger)
      );
      sendJson(res, 202, { operationId: operation.id });
      return;
    }
    const result = await generateDraftsForInteractions(db, config, parseIds(body));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/interactions/generate-publish") {
    const body = await readJson(req);
    if (body.async) {
      const ids = parseIds(body);
      const operation = startOperation("批量评论并发布", (logger) =>
        generateAndPublishInteractions(db, config, ids, logger)
      );
      sendJson(res, 202, { operationId: operation.id });
      return;
    }
    const result = await generateAndPublishInteractions(db, config, parseIds(body));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/interactions/status") {
    const body = await readJson(req);
    const changed = updateInteractionStatus(db, parseIds(body), String(body.status));
    sendJson(res, 200, { changed });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/interactions/draft") {
    const body = await readJson(req);
    const id = optionalNumber(asScalar(body.id));
    if (!id) throw new Error("Missing interaction id.");
    const changed = updateInteractionDraft(db, id, String(body.draftComment ?? ""));
    sendJson(res, 200, { changed });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/interactions/publish") {
    const body = await readJson(req);
    if (body.async) {
      const ids = parseIds(body);
      const operation = startOperation("批量发布评论", (logger) =>
        publishConfirmedInteractions(db, config, ids, logger)
      );
      sendJson(res, 202, { operationId: operation.id });
      return;
    }
    const result = await publishConfirmedInteractions(db, config, parseIds(body));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/operations/")) {
    const id = url.pathname.split("/").filter(Boolean).at(-1);
    const operation = id ? operations.get(id) : null;
    if (!operation) {
      sendJson(res, 404, { error: "Operation not found" });
      return;
    }
    sendJson(res, 200, operation);
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/operations\/[^/]+\/cancel$/)) {
    const id = url.pathname.split("/").filter(Boolean).at(-2);
    const operation = id ? operations.get(id) : null;
    if (!operation) {
      sendJson(res, 404, { error: "Operation not found" });
      return;
    }
    if (operation.state === "running") {
      operation.cancelRequested = true;
      operation.updatedAt = new Date().toISOString();
      operation.logs.push(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 已请求取消，当前步骤结束后停止`);
    }
    sendJson(res, 200, operation);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/mcp/login-status") {
    sendJson(res, 200, await fetchMcpJson("/api/v1/login/status"));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mcp/browser/restart") {
    const result = await postMcpJson("/api/v1/browser/restart", { reason: "dashboard" }, 130_000);
    await waitForBrowserViewerReady(10_000);
    sendJson(res, 200, { ...(result as Record<string, unknown>), viewerUrl: noVncViewerUrl });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser-viewer/open") {
    await postRuntimeJson("/browser/open", { url: "https://www.xiaohongshu.com/explore" }, 45_000);
    await waitForBrowserViewerReady(10_000);
    sendJson(res, 200, {
      opened: true,
      viewerUrl: noVncViewerUrl,
      loginUrl: "https://www.xiaohongshu.com/explore"
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser-viewer/action") {
    const body = await readJson(req);
    sendJson(res, 200, await runBrowserViewerAction(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser-viewer/sync-cookies") {
    const result = await postMcpJson("/api/v1/browser/sync-cookies", {}, 35_000);
    sendJson(res, 200, unwrapMcpData(result));
    return;
  }

  if (url.pathname.startsWith("/api/cdp-login/") && !legacyCdpLoginEnabled) {
    sendJson(res, 410, { error: "Legacy CDP login API is disabled. Use /api/browser-viewer/* instead." });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cdp-login/open") {
    const body = await readJson(req);
    const result = await openCdpLoginWindow(config, {
      account: typeof body.account === "string" ? body.account : undefined,
      port: Number(body.port ?? getDefaultCdpPort()),
      restart: body.restart === true
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cdp-login/sync-cookies") {
    const body = await readJson(req);
    const result = await syncCdpCookiesToMcp(config, Number(body.port ?? getDefaultCdpPort()));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cdp-login/target") {
    sendJson(res, 200, await getCdpLoginTarget(config, { ensure: url.searchParams.get("ensure") === "1" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cdp-login/frame") {
    sendJson(
      res,
      200,
      await captureCdpLoginFrame(config, {
        ensure: url.searchParams.get("ensure") === "1",
        width: Number(url.searchParams.get("width") || 0) || undefined,
        height: Number(url.searchParams.get("height") || 0) || undefined
      })
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cdp-login/screencast") {
    await streamCdpSse(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cdp-login/input") {
    const body = await readJson(req);
    sendJson(res, 200, await dispatchCdpLoginInput(config, body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cdp-login/browser-action") {
    const body = await readJson(req);
    sendJson(res, 200, await dispatchCdpBrowserAction(config, body));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/debug-screenshots") {
    sendJson(res, 200, { screenshots: listDebugScreenshots(Number(url.searchParams.get("limit") ?? 24)) });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/debug-screenshots/")) {
    serveDebugScreenshot(res, decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? ""));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function streamCdpSse(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");

  const sendEvent = (event: string, data: unknown) => {
    if (res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await streamCdpBrowserFrames(config, {
      ensure: url.searchParams.get("ensure") === "1",
      width: Number(url.searchParams.get("width") || 0) || undefined,
      height: Number(url.searchParams.get("height") || 0) || undefined,
      signal: controller.signal,
      onInfo: (info) => sendEvent("info", info),
      onFrame: (frame) => sendEvent("frame", frame)
    });
  } catch (error) {
    if (!res.destroyed) {
      sendEvent("error", { error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    if (!res.destroyed) res.end();
  }
}

function listDebugScreenshots(limit: number): Array<{
  name: string;
  url: string;
  size: number;
  mtime: string;
}> {
  mkdirSync(debugScreenshotDir, { recursive: true });
  return readdirSync(debugScreenshotDir)
    .filter((name) => isSafeDebugScreenshotName(name))
    .map((name) => {
      const filePath = path.join(debugScreenshotDir, name);
      const stats = statSync(filePath);
      return {
        name,
        url: `/api/debug-screenshots/${encodeURIComponent(name)}`,
        size: stats.size,
        mtime: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 24);
}

function serveDebugScreenshot(res: ServerResponse, name: string): void {
  if (!isSafeDebugScreenshotName(name)) {
    sendJson(res, 400, { error: "Invalid screenshot name" });
    return;
  }
  const filePath = path.normalize(path.join(debugScreenshotDir, name));
  if (!filePath.startsWith(debugScreenshotDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: "Screenshot not found" });
    return;
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  createReadStream(filePath).pipe(res);
}

function isSafeDebugScreenshotName(name: string): boolean {
  return /^[\w.-]+\.png$/i.test(name) && !name.includes("..") && path.basename(name) === name;
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  res.setHeader("Content-Type", contentType(filePath));
  createReadStream(filePath).pipe(res);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function parseIds(body: Record<string, unknown>): number[] {
  const raw = Array.isArray(body.ids) ? body.ids : [body.id].filter(Boolean);
  return raw.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function optionalNumber(value: string | number | boolean | null | undefined): number | undefined {
  if (!value) return undefined;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function asScalar(value: unknown): string | number | boolean | null | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item));
}

function normalizeContentType(value: string): ContentType {
  return ["auto", "news", "opinion", "guide", "tips", "list", "case"].includes(value)
    ? (value as ContentType)
    : "auto";
}

function ensureGeneratedPersona(profileName?: string, logger?: { log(message: string): void }): void {
  if (getActivePersona(db)) return;
  const persona = saveAccountPersona(db, suggestAccountPersona(db, profileName));
  logger?.log(`已根据账号和笔记库生成人设草稿：${persona.name}`);
}

async function fetchMcpJson(endpoint: string, timeoutMs = 20_000): Promise<unknown> {
  const base = config.xhs.mcp?.url ? new URL(config.xhs.mcp.url).origin : "http://localhost:18060";
  const response = await fetchWithTimeout(`${base}${endpoint}`, {}, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `MCP ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function postMcpJson(endpoint: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<unknown> {
  const base = config.xhs.mcp?.url ? new URL(config.xhs.mcp.url).origin : "http://localhost:18060";
  const response = await fetchWithTimeout(`${base}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `MCP ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function fetchRuntimeJson(endpoint: string, timeoutMs = 20_000): Promise<unknown> {
  const response = await fetchWithTimeout(`${browserRuntimeUrl.replace(/\/$/, "")}${endpoint}`, {}, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `Browser runtime ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

async function postRuntimeJson(endpoint: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<unknown> {
  const response = await fetchWithTimeout(`${browserRuntimeUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || isMcpFailure(data)) {
    throw new Error(mcpErrorMessage(data, `Browser runtime ${endpoint} failed: HTTP ${response.status}`));
  }
  return data;
}

function isMcpFailure(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "success" in payload && (payload as { success?: unknown }).success === false);
}

function mcpErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown; message?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function unwrapMcpData(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

async function runBrowserViewerAction(body: Record<string, unknown>): Promise<{ ok: true }> {
  const action = String(body.action ?? "");
  const payload = action === "navigate" ? { ...body, url: normalizeViewerUrl(String(body.url ?? "")) } : body;
  await postRuntimeJson("/browser/action", payload, 20_000);
  return { ok: true };
}

async function waitForBrowserViewerReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const runtime = await fetchRuntimeJson("/health?ensure=1", 3_000);
      const ready = (runtime as { runtime?: { noVnc?: { ready?: boolean } } }).runtime?.noVnc?.ready === true;
      if (ready) return;
      lastError = "runtime noVNC not ready";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(400);
  }
  throw new Error(`noVNC 未就绪：${lastError || "等待超时"}`);
}

function probeTcpPort(port: number, host: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, host);
    const done = (error?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`${host}:${port} 连接超时`)));
    socket.on("connect", () => done());
    socket.on("error", (error) => done(error));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeViewerUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "https://www.xiaohongshu.com/explore";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`;
  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(value)}`;
}

function proxyNoVncHttp(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const upstreamPath = stripNoVncPrefix(url);
  const proxyReq = httpRequest(
    {
      hostname: noVncHost,
      port: noVncPort,
      method: req.method,
      path: upstreamPath,
      headers: { ...req.headers, host: `${noVncHost}:${noVncPort}` }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", (error) => {
    if (!res.headersSent) sendJson(res, 502, { error: `noVNC 不可用：${error.message}` });
    else res.destroy(error);
  });
  req.pipe(proxyReq);
}

function proxyNoVncUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
  const upstreamPath = stripNoVncPrefix(url);
  const upstream = connectTcp(noVncPort, noVncHost);
  upstream.on("connect", () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}`)
      .join("\r\n");
    upstream.write(`${req.method ?? "GET"} ${upstreamPath} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
}

function stripNoVncPrefix(url: URL): string {
  const stripped = url.pathname.replace(/^\/novnc\/?/, "/") || "/";
  return `${stripped}${url.search}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function startOperation(
  name: string,
  task: (logger: { log(message: string): void; throwIfCancelled(): void }) => Promise<unknown>
): Operation {
  const now = new Date().toISOString();
  const operation: Operation = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    state: "running",
    logs: [],
    itemStatuses: {},
    createdAt: now,
    updatedAt: now
  };
  operations.set(operation.id, operation);
  const logger = {
    throwIfCancelled() {
      if (operation.cancelRequested) throw new OperationCancelledError();
    },
    log(message: string) {
      this.throwIfCancelled();
      operation.logs.push(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`);
      operation.updatedAt = new Date().toISOString();
    },
    setItemStatus(itemId: number, label: string) {
      operation.itemStatuses[String(itemId)] = label;
      operation.updatedAt = new Date().toISOString();
    }
  };
  logger.log(`${name}开始`);
  task(logger)
    .then((result) => {
      if (operation.cancelRequested) throw new OperationCancelledError();
      operation.result = result;
      operation.state = "completed";
      logger.log(`${name}完成`);
    })
    .catch((error) => {
      operation.error = error instanceof Error ? error.message : String(error);
      operation.state = error instanceof OperationCancelledError ? "cancelled" : "failed";
      operation.cancelRequested = operation.state === "cancelled" ? true : operation.cancelRequested;
      operation.logs.push(
        `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${
          operation.state === "cancelled" ? `${name}已取消` : `${name}失败：${operation.error}`
        }`
      );
    })
    .finally(() => {
      operation.updatedAt = new Date().toISOString();
    });
  return operation;
}
