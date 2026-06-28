import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadDotEnv } from "./env.js";
import { arkModelFor, resolveArkSettings } from "./llm/arkClient.js";

export interface XhsConfig {
  provider: "fixture" | "stdio" | "http";
  fixturePath?: string;
  mcp?: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    tools?: {
      searchPosts?: string;
      getPost?: string;
      openPost?: string;
      prefillComment?: string;
      publishComment?: string;
      likePost?: string;
    };
  };
}

export interface ArkConfigSnapshot {
  /** 是否具备最低生产条件:有 key 且能解析出默认模型 */
  enabled: boolean;
  hasApiKey: boolean;
  baseUrl: string;
  defaultModel?: string;
  fastModel?: string;
  relevanceModel?: string;
  contentModel?: string;
}

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  outputDir: string;
  sqlitePath: string;
  xhs: XhsConfig;
  ark: ArkConfigSnapshot;
}

function loadArkSnapshot(): ArkConfigSnapshot {
  const settings = resolveArkSettings();
  return {
    enabled: Boolean(settings.apiKey && arkModelFor("default", settings)),
    hasApiKey: Boolean(settings.apiKey),
    baseUrl: settings.baseUrl,
    defaultModel: settings.defaultModel,
    fastModel: settings.fastModel,
    relevanceModel: settings.relevanceModel,
    contentModel: settings.contentModel
  };
}

export function loadConfig(rootDir = process.cwd()): AppConfig {
  loadDotEnv(rootDir);
  const localPath = path.join(rootDir, "xhs.config.local.json");
  const examplePath = path.join(rootDir, "xhs.config.example.json");
  const configPath = existsSync(localPath) ? localPath : examplePath;
  const xhs = JSON.parse(readFileSync(configPath, "utf8")) as XhsConfig;
  const dataDir = path.join(rootDir, "data");
  const outputDir = path.join(rootDir, "output");

  return {
    rootDir,
    dataDir,
    outputDir,
    sqlitePath: path.join(dataDir, "app.sqlite"),
    xhs,
    ark: loadArkSnapshot()
  };
}

export function resolveFromRoot(rootDir: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(rootDir, maybeRelative);
}
