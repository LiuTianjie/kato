import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { RunSlot } from "../domain/types.js";
import { listActiveNotes } from "../notes/importNotes.js";
import type { OperationLogger } from "../operations/logger.js";
import { runDiscovery, type RunResult } from "../runs/runner.js";

export interface GrowthAgentRunOptions {
  limit: number;
  keywords?: string[];
  slot?: RunSlot;
  generateDrafts?: boolean;
  logger?: OperationLogger;
}

export async function runGrowthAgent(
  db: Db,
  config: AppConfig,
  options: GrowthAgentRunOptions
): Promise<RunResult> {
  const notes = listActiveNotes(db);
  if (!notes.length) {
    throw new Error("请先在我的笔记库添加至少一条 active 笔记，再生成互动队列。");
  }

  return runDiscovery(db, config, {
    slot: options.slot ?? "manual",
    limit: options.limit,
    keywords: options.keywords,
    generateDrafts: options.generateDrafts,
    logger: options.logger
  });
}
