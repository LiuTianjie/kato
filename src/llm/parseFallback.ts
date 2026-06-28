/**
 * LLM 解析兜底:当规则/字段映射从非空上游 payload 里抽不出结果时
 * (通常意味着平台改版导致字段路径失配),把原始 payload 交给模型,
 * 让它按目标语义抽出"松散 item 列表"。调用方再用各自既有的归一化函数
 * (如 toServerxDouyinVideo)把松散 item 收敛成最终 shape——这样 LLM 只负责
 * "从哪取值",字段形状仍由确定性代码保证,且 raw 依旧保留。
 *
 * 约束(对应调研结论):
 *  - 默认关闭,仅 KATO_LLM_PARSE_FALLBACK=1 启用,且只在"规则解析失败 + 上游有内容"时触发,绝不进正常路径。
 *  - 永不抛错:任何失败(无 key / 超时 / 非法 JSON / schema 不符)都返回 null,调用方回退到原空结果。
 *  - 控成本:payload 截断后再喂模型;用默认模型但限制 max_tokens;单次短超时。
 */

import { callArk, canUseArk, parseArkJson, ArkError } from "./arkClient.js";

export type ParseFallbackKind = "video" | "comment";

export interface ParseFallbackInput {
  platform: string;
  kind: ParseFallbackKind;
  /** 上游原始 payload(会被截断后喂给模型) */
  payload: unknown;
  /** 期望抽取的字段说明,指导模型从 payload 里找值 */
  fieldHint: string;
  signal?: AbortSignal;
}

const MAX_PAYLOAD_CHARS = normalizePositiveEnv("KATO_LLM_PARSE_MAX_CHARS", 12_000);
const MAX_ITEMS = normalizePositiveEnv("KATO_LLM_PARSE_MAX_ITEMS", 30);
const TIMEOUT_MS = normalizePositiveEnv("KATO_LLM_PARSE_TIMEOUT_MS", 20_000);

export function isParseFallbackEnabled(): boolean {
  return process.env.KATO_LLM_PARSE_FALLBACK === "1" && canUseArk("default");
}

/**
 * 返回松散 item 列表(交给调用方各自的归一化函数),或 null 表示兜底未产出可用结果。
 * 永不抛错。
 */
export async function extractItemsWithLlm(input: ParseFallbackInput): Promise<Record<string, unknown>[] | null> {
  if (!isParseFallbackEnabled()) return null;

  const payloadText = truncate(safeStringify(input.payload), MAX_PAYLOAD_CHARS);
  if (!payloadText || payloadText === "{}" || payloadText === "null") return null;

  try {
    const content = await callArk(
      [
        {
          role: "system",
          content:
            "你是数据抽取器。给你一段平台接口返回的原始 JSON,你要从中找出目标条目并抽取指定字段。" +
            "只输出严格 JSON,不要 Markdown,不要解释。找不到就返回空数组。不要编造不存在的值。"
        },
        {
          role: "user",
          content: [
            `平台:${input.platform}`,
            `目标类型:${input.kind === "video" ? "视频/帖子条目" : "评论条目"}`,
            "需要抽取的字段(从原始 JSON 的真实值里取,不存在则省略该字段):",
            input.fieldHint,
            "",
            "原始 JSON:",
            payloadText,
            "",
            `返回格式:{"items":[ ...最多 ${MAX_ITEMS} 条对象 ]}。每条对象用上面字段名作为 key。`
          ].join("\n")
        }
      ],
      {
        modelKind: "default",
        temperature: 0,
        maxTokens: 2000,
        timeoutMs: TIMEOUT_MS,
        retries: 1,
        signal: input.signal,
        label: `LLM parse fallback (${input.platform}/${input.kind})`
      }
    );

    const parsed = parseArkJson<{ items?: unknown }>(content, "LLM parse fallback");
    const items = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
    const normalized = items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .slice(0, MAX_ITEMS);
    return normalized.length ? normalized : null;
  } catch (error) {
    // ArkError(无 key/超时/HTTP) 与解析异常一律静默回退,不影响采集
    if (!(error instanceof ArkError)) {
      console.warn(`[parseFallback] unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

function normalizePositiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
