import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig, resolveFromRoot } from "./config.js";
import { runGrowthAgent } from "./agent/growthAgent.js";
import { openDb } from "./db/client.js";
import { initSchema } from "./db/schema.js";
import type { RunSlot } from "./domain/types.js";
import { importNotesFromCsv, listActiveNotes } from "./notes/importNotes.js";
import { markInteraction } from "./runs/approval.js";
import { parseKeywordArg } from "./runs/keywords.js";
import { publishConfirmedInteractions } from "./runs/publish.js";
import {
  getDefaultCdpPort,
  openBrowserViewerLogin,
  openCdpLoginWindow,
  syncBrowserViewerCookiesToMcp,
  syncCdpCookiesToMcp
} from "./auth/cdpLogin.js";

type Args = Record<string, string | boolean>;

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.outputDir, { recursive: true });
  const db = openDb(config);

  try {
    if (command !== "help") initSchema(db);

    switch (command) {
      case "init-db": {
        console.log(`Database ready: ${config.sqlitePath}`);
        break;
      }
      case "notes:import": {
        const file = String(args._ ?? args.file ?? "data/notes.csv");
        const count = importNotesFromCsv(db, resolveFromRoot(config.rootDir, file));
        console.log(`Imported ${count} notes.`);
        break;
      }
      case "run": {
        const slot = parseSlot(String(args.slot ?? "manual"));
        const limit = Number(args.limit ?? 30);
        const keywords = parseKeywordArg(typeof args.keywords === "string" ? args.keywords : undefined);
        const result = await runGrowthAgent(db, config, { slot, limit, keywords });
        console.log(`Run ${result.runId} queued ${result.queued ?? result.drafted} interactions.`);
        console.log(`Markdown: ${result.markdownPath}`);
        console.log(`CSV: ${result.csvPath}`);
        break;
      }
      case "publish": {
        const ids = collectInteractionIds(args);
        const result = await publishConfirmedInteractions(db, config, ids);
        console.log(`Published ${result.published} interactions via MCP. Skipped ${result.skipped}.`);
        break;
      }
      case "mark": {
        const interactionId = requiredNumber(args, "interaction-id");
        const status = String(args.status ?? "");
        const count = markInteraction(db, interactionId, status);
        console.log(`Updated ${count} interaction.`);
        break;
      }
      case "doctor": {
        const notes = listActiveNotes(db);
        console.log(`Root: ${config.rootDir}`);
        console.log(`Provider: ${config.xhs.provider}`);
        console.log(`Database: ${config.sqlitePath}`);
        console.log(`Active notes: ${notes.length}`);
        console.log(`Output: ${path.join(config.outputDir, "runs")}`);
        break;
      }
      case "auth:cdp": {
        if (args.legacy === true) {
          const result = await openCdpLoginWindow(config, {
            account: typeof args.account === "string" ? args.account : undefined,
            port: Number(args.port ?? getDefaultCdpPort()),
            restart: args.restart === true,
            wait: args.wait === true,
            syncCookies: args["sync-cookies"] === true,
            timeoutMs: Number(args.timeout ?? 300) * 1000
          });
          console.log(`Legacy CDP: ${result.cdpUrl}`);
          console.log(`DevTools targets: ${result.devtoolsUrl}`);
          console.log(`MCP: ${result.mcpBaseUrl}`);
          console.log(`Account: ${result.account}`);
          console.log(`Cookies: ${result.profileDir}`);
          console.log(`Login page: ${result.loginUrl}`);
          console.log(result.alreadyRunning ? "Chrome: reused existing container CDP browser" : "Chrome: requested MCP container browser");
          if (result.restarted) console.log("Chrome: restarted container browser before opening login");
          if (result.loggedIn !== undefined) {
            console.log(result.loggedIn ? "Login: confirmed" : "Login: still waiting or timed out");
            if (!result.loggedIn) process.exitCode = 1;
          } else {
            console.log("请在打开的 Chrome 窗口中完成登录 / 二次验证。");
          }
          if (result.cookiesPath) {
            console.log(`Cookies: exported ${result.exportedCookies ?? 0} to ${result.cookiesPath}`);
          }
          break;
        }
        const result = await openBrowserViewerLogin(config, typeof args.account === "string" ? args.account : undefined);
        console.log(`Dashboard: ${result.dashboardUrl}`);
        console.log(`Browser viewer: ${result.viewerUrl}`);
        console.log(`MCP: ${result.mcpBaseUrl}`);
        console.log(`Account: ${result.account}`);
        console.log(`Login page: ${result.loginUrl}`);
        console.log("请在 Dashboard 的浏览器接管 Tab 内完成登录 / 二次验证。");
        break;
      }
      case "auth:sync-cookies": {
        const result =
          args.legacy === true
            ? await syncCdpCookiesToMcp(config, Number(args.port ?? getDefaultCdpPort()))
            : await syncBrowserViewerCookiesToMcp(config);
        console.log(`Cookies: exported ${result.exportedCookies} to ${result.cookiesPath}`);
        const storageResult = result as { storagePath?: string; exportedStorageOrigins?: number };
        if (storageResult.storagePath) {
          console.log(`Storage: exported ${storageResult.exportedStorageOrigins ?? 0} origins to ${storageResult.storagePath}`);
        }
        break;
      }
      default:
        printHelp();
    }
  } finally {
    db.close();
  }
}

function parseArgs(values: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      args._ = value;
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function requiredNumber(args: Args, key: string): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`Missing or invalid --${key}.`);
  return value;
}

function parseSlot(value: string): RunSlot {
  if (value === "morning" || value === "noon" || value === "evening" || value === "manual") return value;
  throw new Error("--slot must be morning, noon, evening, or manual.");
}

function printHelp(): void {
  console.log(`
Usage:
  npm run init-db
  npm run notes:import -- data/notes.csv
  npm run run -- --slot manual --limit 30
  npm run publish -- --interaction-id 1
  npm run mark -- --interaction-id 1 --status posted_by_user
  npm run auth:cdp
  npm run auth:sync-cookies
  npm run auth:sync-cookies -- --legacy
`);
}

function collectInteractionIds(args: Args): number[] {
  if (args["interaction-id"]) return [Number(args["interaction-id"])];
  if (typeof args.ids === "string") {
    return args.ids
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isFinite(id));
  }
  return [];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
