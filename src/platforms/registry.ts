import type { PlatformId, PlatformSpec } from "./types.js";

export const DEFAULT_PLATFORM_ID: PlatformId = "xhs";

export const PLATFORM_SPECS: Record<PlatformId, PlatformSpec> = {
  xhs: {
    id: "xhs",
    label: "小红书",
    serviceName: "xiaohongshu",
    homeUrl: "https://www.xiaohongshu.com/explore",
    cookieDomains: [".xiaohongshu.com", ".xhslink.com", ".xhscdn.com"],
    defaultDataDir: "/app/mcp/xiaohongshu/data",
    defaultServicePort: 18060,
    implemented: true,
    capabilities: {
      search: true,
      detail: true,
      comments: true,
      write: true,
      login: true
    },
    searchUrl: (query) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`
  },
  bilibili: {
    id: "bilibili",
    label: "B站",
    serviceName: "bilibili",
    homeUrl: "https://www.bilibili.com",
    cookieDomains: [".bilibili.com", ".biligame.com"],
    defaultDataDir: "/app/data/platforms/bilibili",
    implemented: false,
    capabilities: {
      search: false,
      detail: false,
      comments: false,
      write: false,
      login: false
    },
    searchUrl: (query) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`
  },
  douyin: {
    id: "douyin",
    label: "抖音",
    serviceName: "douyin",
    homeUrl: "https://www.douyin.com",
    cookieDomains: [".douyin.com"],
    defaultDataDir: "/app/data/platforms/douyin",
    defaultServicePort: 18070,
    implemented: true,
    capabilities: {
      search: true,
      detail: true,
      comments: true,
      write: false,
      login: true
    },
    searchUrl: (query) => `https://www.douyin.com/search/${encodeURIComponent(query)}`
  }
};

export function listPlatformSpecs(): PlatformSpec[] {
  return Object.values(PLATFORM_SPECS);
}

export function parsePlatformId(value: unknown): PlatformId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "redbook" || normalized === "xiaohongshu" || normalized === "xhs") return "xhs";
  if (normalized === "bilibili" || normalized === "bili" || normalized === "b站") return "bilibili";
  if (normalized === "douyin" || normalized === "dy" || normalized === "抖音") return "douyin";
  return null;
}

export function normalizePlatformId(value: unknown, fallback: PlatformId = DEFAULT_PLATFORM_ID): PlatformId {
  return parsePlatformId(value) ?? fallback;
}

export function getPlatformSpec(value: unknown, fallback: PlatformId = DEFAULT_PLATFORM_ID): PlatformSpec {
  return PLATFORM_SPECS[normalizePlatformId(value, fallback)];
}

export function requirePlatformSpec(value: unknown): PlatformSpec {
  const platformId = parsePlatformId(value);
  if (!platformId) throw new Error(`Unknown platform: ${String(value)}`);
  return PLATFORM_SPECS[platformId];
}

export function normalizePlatformViewerUrl(platform: PlatformSpec | PlatformId, raw: string): string {
  const spec = typeof platform === "string" ? PLATFORM_SPECS[platform] : platform;
  const value = raw.trim();
  if (!value) return spec.homeUrl;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`;
  return spec.searchUrl(value);
}
