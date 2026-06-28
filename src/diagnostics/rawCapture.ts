/**
 * 采集原始 payload 落盘(诊断 / 阶段 2 LLM 解析兜底的前提)。
 *
 * 触发场景:平台 service 返回了非空上游数据,但归一化后"应有结果却为空"——
 * 这通常意味着平台改版导致字段路径失配。把当时的请求上下文 + 原始 payload
 * 落到 data/raw/<platform>/,供线上排错和后续 LLM 兜底重解析使用。
 *
 * 约束:
 *  - 默认关闭,仅 KATO_RAW_CAPTURE=1 时启用,避免无谓磁盘占用。
 *  - 永不抛错进请求路径:内部全程 try/catch,失败只 warn。
 *  - 有界:单文件超过上限轮转,每平台目录文件数超过上限按时间裁剪,
 *    单条 payload 截断,防止磁盘被打爆。
 *  - 脱敏:cookie / token / 签名 / xsec_token 等敏感字段落盘前 redact。
 */

import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = normalizePositiveEnv("KATO_RAW_CAPTURE_MAX_FILE_BYTES", 5_000_000);
const MAX_FILES_PER_PLATFORM = normalizePositiveEnv("KATO_RAW_CAPTURE_MAX_FILES", 50);
const MAX_PAYLOAD_CHARS = normalizePositiveEnv("KATO_RAW_CAPTURE_MAX_PAYLOAD_CHARS", 20_000);
const MAX_STRING_CHARS = 2_000;

const SENSITIVE_KEY_PATTERN =
  /cookie|token|authorization|sessdata|bili_jct|x-s|x-t|x-bogus|a_bogus|sign|mstoken|verifyfp|sec_uid|secuid|password|secret/i;

export interface RawCaptureInput {
  platform: string;
  /** 采集动作:search / detail / comments / comment_replies */
  kind: string;
  /** 触发原因,例如 "empty-result" */
  reason: string;
  /** 请求上下文(关键词 / id / 分页),会被脱敏 */
  request?: unknown;
  /** 上游原始 payload,会被脱敏 + 截断 */
  payload?: unknown;
  /** 额外说明 */
  note?: string;
}

export function isRawCaptureEnabled(): boolean {
  return process.env.KATO_RAW_CAPTURE === "1";
}

function captureBaseDir(): string {
  return process.env.KATO_RAW_CAPTURE_DIR || path.join(process.cwd(), "data", "raw");
}

/**
 * 落盘一条原始 payload 记录。永不抛错。
 * 仅当 KATO_RAW_CAPTURE=1 时实际写入。
 */
export async function captureRawPayload(input: RawCaptureInput): Promise<void> {
  if (!isRawCaptureEnabled()) return;
  try {
    const platform = safeSegment(input.platform);
    const kind = safeSegment(input.kind);
    const dir = path.join(captureBaseDir(), platform);
    await mkdir(dir, { recursive: true });

    const record = {
      ts: new Date().toISOString(),
      platform,
      kind,
      reason: input.reason,
      note: input.note,
      request: sanitize(input.request),
      payload: truncatePayload(sanitize(input.payload))
    };
    const line = `${JSON.stringify(record)}\n`;

    const target = await resolveTargetFile(dir, kind, line.length);
    await appendFile(target, line, "utf8");
    await pruneOldFiles(dir).catch(() => {});
  } catch (error) {
    // 诊断功能不能影响主流程
    console.warn(`[rawCapture] failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 当天文件超过大小上限时按序号轮转。 */
async function resolveTargetFile(dir: string, kind: string, incomingBytes: number): Promise<string> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const base = path.join(dir, `${kind}-${day}`);
  let seq = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = seq === 0 ? `${base}.jsonl` : `${base}.${seq}.jsonl`;
    const size = await fileSize(candidate);
    if (size + incomingBytes <= MAX_FILE_BYTES || size === 0) return candidate;
    seq += 1;
    if (seq > 10_000) return candidate; // 安全阀,理论上到不了
  }
}

async function pruneOldFiles(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const jsonl = entries.filter((name) => name.endsWith(".jsonl"));
  if (jsonl.length <= MAX_FILES_PER_PLATFORM) return;
  const withTime = await Promise.all(
    jsonl.map(async (name) => {
      const full = path.join(dir, name);
      const info = await stat(full).catch(() => null);
      return { full, mtime: info?.mtimeMs ?? 0 };
    })
  );
  withTime.sort((a, b) => a.mtime - b.mtime);
  const removeCount = withTime.length - MAX_FILES_PER_PLATFORM;
  await Promise.all(withTime.slice(0, removeCount).map((item) => unlink(item.full).catch(() => {})));
}

/** 递归脱敏:命中敏感 key 的值整体 redact,长字符串截断。 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (value == null) return value;
  if (typeof value === "string") return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…[truncated]` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitize(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

function truncatePayload(value: unknown): unknown {
  const text = (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  if (text.length <= MAX_PAYLOAD_CHARS) return value;
  return { _truncated: true, _originalChars: text.length, preview: `${text.slice(0, MAX_PAYLOAD_CHARS)}…` };
}

async function fileSize(file: string): Promise<number> {
  const info = await stat(file).catch(() => null);
  return info?.size ?? 0;
}

function safeSegment(value: string): string {
  const cleaned = String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "unknown";
}

function normalizePositiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
