import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { OperationLogger } from "../operations/logger.js";
import {
  getContentDraftById,
  saveContentEvent,
  updateContentDraftPublishState
} from "./repository.js";

export interface ContentPublishResult {
  draftId: number;
  publishStatus: "published" | "failed";
  output: string;
}

export async function publishContentDraft(
  db: Db,
  config: AppConfig,
  draftId: number,
  logger?: OperationLogger
): Promise<ContentPublishResult> {
  const draft = getContentDraftById(db, draftId);
  if (draft.status !== "approved") {
    recordEvent(db, draft.projectId, "warn", "publish", "草稿未审核通过，拒绝发布", { draftId, status: draft.status });
    throw new Error("草稿必须先审核通过，才能发布。");
  }
  if (!draft.imagePaths.length) {
    recordEvent(db, draft.projectId, "warn", "publish", "草稿缺少本地图片路径，拒绝发布", { draftId });
    throw new Error("图文发布至少需要一个本地图片路径。");
  }
  const title = draft.titleCandidates[0]?.trim();
  if (!title) throw new Error("草稿缺少标题候选。");
  if (!draft.body.trim()) throw new Error("草稿正文为空。");

  logger?.log(`发布图文笔记：${title}`);
  recordEvent(db, draft.projectId, "info", "publish", "开始发布图文笔记", {
    draftId,
    title,
    imageCount: draft.imagePaths.length
  });
  updateContentDraftPublishState(db, draftId, { publishStatus: "publishing" });

  try {
    const output = await runPublishScript(config, {
      title,
      body: composePublishBody(draft.body, draft.tags),
      imagePaths: draft.imagePaths
    });
    const publishedUrl = extractUrl(output);
    updateContentDraftPublishState(db, draftId, {
      publishStatus: "published",
      publishedUrl: publishedUrl || null,
      publishError: null
    });
    recordEvent(db, draft.projectId, "info", "publish", "图文笔记发布完成", {
      draftId,
      publishedUrl: publishedUrl || undefined
    });
    logger?.log("图文笔记发布完成");
    return { draftId, publishStatus: "published", output };
  } catch (error) {
    const message = errorMessage(error);
    updateContentDraftPublishState(db, draftId, {
      publishStatus: "failed",
      publishError: message
    });
    recordEvent(db, draft.projectId, "error", "publish", "图文笔记发布失败", { draftId, error: message });
    throw error;
  }
}

async function runPublishScript(
  config: AppConfig,
  input: { title: string; body: string; imagePaths: string[] }
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "kato-publish-"));
  const titleFile = path.join(dir, "title.txt");
  const contentFile = path.join(dir, "content.txt");
  try {
    await writeFile(titleFile, input.title, "utf8");
    await writeFile(contentFile, input.body, "utf8");
    const command = process.env.XHS_PUBLISH_COMMAND || "python3";
    const scriptPath =
      process.env.XHS_PUBLISH_SCRIPT_PATH ||
      path.join(config.rootDir, "mcp", "xiaohongshu", "source", "skills", "post-to-xhs", "scripts", "publish_pipeline.py");
    const args = [
      scriptPath,
      "--headless",
      "--auto-publish",
      "--title-file",
      titleFile,
      "--content-file",
      contentFile,
      "--images",
      ...input.imagePaths
    ];
    const account = process.env.XHS_PUBLISH_ACCOUNT?.trim();
    if (account) args.push("--account", account);
    return await runCommand(command, args);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`发布脚本失败（exit ${code ?? "unknown"}）：${output.trim()}`));
      }
    });
  });
}

function composePublishBody(body: string, tags: string[]): string {
  const tagLine = tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .join(" ");
  return tagLine ? `${body.trim()}\n\n${tagLine}` : body.trim();
}

function recordEvent(
  db: Db,
  projectId: number,
  level: "info" | "warn" | "error",
  stage: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  try {
    saveContentEvent(db, { projectId, level, stage, message, metadata });
  } catch {
    // Publishing must surface the original failure, not event-write failures.
  }
}

function extractUrl(output: string): string | undefined {
  return /https:\/\/www\.xiaohongshu\.com\/[^\s)）]+/.exec(output)?.[0];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
