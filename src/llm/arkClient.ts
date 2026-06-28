/**
 * 火山方舟(ARK / 豆包,OpenAI 兼容 /chat/completions)统一客户端。
 *
 * 合并原先散落在 relevanceEvaluator / commentProvider / draftProvider 三处、
 * 几乎一模一样的 callArk 实现,集中提供:
 *  - AbortSignal 超时(默认 30s,可配)
 *  - 429 / 5xx / 网络抖动的退避重试(默认 2 次)
 *  - token 用量埋点(进程内累计,供成本可见)
 *  - 统一的 JSON 解析(剥 ```fence``` + 正则兜底)
 *
 * 设计约束:env 仍是惟一真相来源,每次调用惰性读取(resolveArkSettings),
 * 保证测试可通过改 process.env 覆盖,且无 key 部署不会在 import 期就崩。
 */

export type ArkChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ArkModelKind = "default" | "relevance" | "content";

export interface ArkSettings {
  apiKey?: string;
  baseUrl: string;
  defaultModel?: string;
  fastModel?: string;
  relevanceModel?: string;
  contentModel?: string;
}

export interface ArkCallOptions {
  /** 显式模型;不传则用 modelKind 推导 */
  model?: string;
  /** 按用途选模型;默认 "default"(ARK_MODEL) */
  modelKind?: ArkModelKind;
  temperature?: number;
  maxTokens?: number;
  /** 单次请求超时,默认 30000ms */
  timeoutMs?: number;
  /** 失败重试次数(不含首次),默认 2 */
  retries?: number;
  /** 上游取消信号(如 serverx 断开);触发时立即放弃,不重试 */
  signal?: AbortSignal;
  /** 错误信息里的场景标签,便于定位是哪条链路 */
  label?: string;
}

export interface ArkUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ArkResult {
  content: string;
  model: string;
  usage?: ArkUsage;
}

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 400;

/** 进程内用量累计。多 worker 部署里这是 per-process 视角,够做成本观测。 */
const usageTotals: ArkUsage & { calls: number } = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0
};

export class ArkError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ArkError";
  }
}

export class ArkCancelledError extends Error {
  constructor(message = "Ark request was cancelled.") {
    super(message);
    this.name = "ArkCancelledError";
  }
}

/** 每次调用都重新读 env,保持测试可覆盖、无 key 部署不崩。 */
export function resolveArkSettings(): ArkSettings {
  return {
    apiKey: process.env.ARK_API_KEY || undefined,
    baseUrl: (process.env.ARK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ""),
    defaultModel: process.env.ARK_MODEL || undefined,
    fastModel: process.env.ARK_FAST_MODEL || undefined,
    relevanceModel: process.env.ARK_RELEVANCE_MODEL || undefined,
    contentModel: process.env.CONTENT_MODEL || undefined
  };
}

/** 按用途推导模型,沿用各模块原本的降级链。 */
export function arkModelFor(kind: ArkModelKind, settings: ArkSettings = resolveArkSettings()): string | undefined {
  if (kind === "relevance") return settings.relevanceModel || settings.fastModel || settings.defaultModel;
  if (kind === "content") return settings.contentModel || settings.defaultModel;
  return settings.defaultModel;
}

/** 是否具备调用 ARK 的最低条件(有 key 且能解析出对应模型)。 */
export function canUseArk(kind: ArkModelKind = "default", settings: ArkSettings = resolveArkSettings()): boolean {
  return Boolean(settings.apiKey && arkModelFor(kind, settings));
}

export function getArkUsageTotals(): Readonly<ArkUsage & { calls: number }> {
  return { ...usageTotals };
}

export function resetArkUsageTotals(): void {
  usageTotals.calls = 0;
  usageTotals.promptTokens = 0;
  usageTotals.completionTokens = 0;
  usageTotals.totalTokens = 0;
}

/** 主入口:返回模型文本。失败抛 ArkError / ArkCancelledError。 */
export async function callArk(messages: ArkChatMessage[], options: ArkCallOptions = {}): Promise<string> {
  return (await callArkDetailed(messages, options)).content;
}

export async function callArkDetailed(messages: ArkChatMessage[], options: ArkCallOptions = {}): Promise<ArkResult> {
  const settings = resolveArkSettings();
  const label = options.label ?? "Ark";
  const model = options.model ?? arkModelFor(options.modelKind ?? "default", settings);
  if (!settings.apiKey || !model) {
    throw new ArkError(null, `${label} requires ARK_API_KEY and a model.`, false);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, (options.retries ?? DEFAULT_RETRIES) + 1);
  const body = JSON.stringify({
    model,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    messages
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new ArkCancelledError();
    try {
      return await requestOnce(settings, model, body, timeoutMs, options.signal, label);
    } catch (error) {
      lastError = error;
      if (error instanceof ArkCancelledError) throw error;
      const retryable = error instanceof ArkError ? error.retryable : true;
      if (!retryable || attempt === maxAttempts - 1) break;
      await delay(RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 200), options.signal);
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new ArkError(null, `${label} failed after ${maxAttempts} attempts.`, false);
}

async function requestOnce(
  settings: ArkSettings,
  model: string,
  body: string,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  label: string
): Promise<ArkResult> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body,
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await safeText(response);
      throw new ArkError(response.status, `${label} failed: HTTP ${response.status} ${text}`, isRetryableStatus(response.status));
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new ArkError(response.status, `${label} returned empty content.`, true);

    const usage = recordUsage(payload.usage);
    return { content, model, usage };
  } catch (error) {
    if (isAbortError(error)) {
      if (timedOut) throw new ArkError(null, `${label} timed out after ${timeoutMs}ms.`, true);
      throw new ArkCancelledError();
    }
    if (error instanceof ArkError) throw error;
    // 网络层错误(DNS/连接重置等)可重试
    throw new ArkError(null, `${label} request error: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * 统一 JSON 解析:先剥 ```json / ``` 围栏直接 parse,失败再用正则抓第一个花括号块。
 * 解析不出抛错,交由调用方决定回退。
 */
export function parseArkJson<T = unknown>(value: string, label = "Ark"): T {
  const trimmed = value
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = /\{[\s\S]*\}/.exec(trimmed);
    if (!match) throw new ArkError(null, `${label} did not return JSON: ${value}`, false);
    return JSON.parse(match[0]) as T;
  }
}

function recordUsage(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): ArkUsage | undefined {
  if (!usage) {
    usageTotals.calls += 1;
    return undefined;
  }
  const promptTokens = Number(usage.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens) || 0;
  usageTotals.calls += 1;
  usageTotals.promptTokens += promptTokens;
  usageTotals.completionTokens += completionTokens;
  usageTotals.totalTokens += totalTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ArkCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ArkCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
