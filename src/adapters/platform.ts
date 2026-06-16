import type { AppConfig } from "../config.js";
import { createDouyinAdapter, type DouyinAdapter } from "./douyin.js";
import { createXhsAdapter, type XhsAdapter } from "./xhsMcp.js";
import { requirePlatformSpec } from "../platforms/registry.js";
import type { PlatformId } from "../platforms/types.js";

export type KatoPlatformAdapter = XhsAdapter | DouyinAdapter;

export function createPlatformAdapter(platform: PlatformId | string, config: AppConfig): KatoPlatformAdapter {
  const spec = requirePlatformSpec(platform);
  if (spec.id === "xhs") return createXhsAdapter(config) as XhsAdapter;
  if (spec.id === "douyin") return createDouyinAdapter();
  throw new Error(`${spec.label} adapter is not implemented yet.`);
}

export function createImplementedPlatformAdapter(platform: PlatformId | string, config: AppConfig): KatoPlatformAdapter {
  return createPlatformAdapter(platform, config);
}
