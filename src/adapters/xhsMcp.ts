import { readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AppConfig, XhsConfig } from "../config.js";
import { resolveFromRoot } from "../config.js";
import type { XhsComment, XhsPost } from "../domain/types.js";

export interface XhsAdapter {
  searchPosts(query: string, limit: number, options?: XhsAdapterRequestOptions): Promise<XhsPost[]>;
  getPost(post: XhsPost | string, options?: XhsAdapterRequestOptions): Promise<XhsPost | null>;
  getComments?(post: XhsPost | string, limit: number, options?: XhsAdapterRequestOptions): Promise<XhsComment[]>;
  openPost(url: string): Promise<void>;
  prefillComment(url: string, comment: string): Promise<boolean>;
  publishComment(post: XhsPost, comment: string, options?: XhsAdapterRequestOptions): Promise<boolean>;
  likePost?(post: XhsPost, options?: XhsAdapterRequestOptions): Promise<boolean>;
  close?(): Promise<void>;
}

export interface XhsAdapterRequestOptions {
  signal?: AbortSignal;
}

export function createXhsAdapter(config: AppConfig): XhsAdapter {
  if (config.xhs.provider === "http") {
    return new HttpMcpXhsAdapter(config.xhs);
  }

  if (config.xhs.provider === "stdio") {
    return new StdioMcpXhsAdapter(config.xhs);
  }

  return new FixtureXhsAdapter(config);
}

class FixtureXhsAdapter implements XhsAdapter {
  private readonly posts: XhsPost[];

  constructor(config: AppConfig) {
    if (!config.xhs.fixturePath) {
      throw new Error("Fixture provider requires xhs.fixturePath.");
    }
    const fixturePath = resolveFromRoot(config.rootDir, config.xhs.fixturePath);
    this.posts = JSON.parse(readFileSync(fixturePath, "utf8")) as XhsPost[];
  }

  async searchPosts(query: string, limit: number, _options?: XhsAdapterRequestOptions): Promise<XhsPost[]> {
    const normalized = normalize(query);
    return this.posts
      .filter((post) => {
        const haystack = normalize(`${post.title} ${post.snippet}`);
        return haystack.includes(normalized) || [...normalized].some((char) => haystack.includes(char));
      })
      .slice(0, limit);
  }

  async getPost(postOrUrl: XhsPost | string, _options?: XhsAdapterRequestOptions): Promise<XhsPost | null> {
    const idOrUrl = typeof postOrUrl === "string" ? postOrUrl : postOrUrl.id || postOrUrl.url;
    return this.posts.find((post) => post.id === idOrUrl || post.url === idOrUrl) ?? null;
  }

  async getComments(_postOrUrl: XhsPost | string, _limit: number, _options?: XhsAdapterRequestOptions): Promise<XhsComment[]> {
    return [];
  }

  async openPost(url: string): Promise<void> {
    console.log(`[fixture] Open manually: ${url}`);
  }

  async prefillComment(_url: string, _comment: string): Promise<boolean> {
    return false;
  }

  async publishComment(post: XhsPost, comment: string, _options?: XhsAdapterRequestOptions): Promise<boolean> {
    console.log(`[fixture] Would publish to ${post.url}: ${comment}`);
    return true;
  }

  async likePost(post: XhsPost, _options?: XhsAdapterRequestOptions): Promise<boolean> {
    console.log(`[fixture] Would like ${post.url}`);
    return true;
  }
}

interface ToolNames {
  searchPosts: string;
  getPost?: string;
  openPost?: string;
  prefillComment?: string;
  publishComment?: string;
  likePost?: string;
}

class HttpMcpXhsAdapter implements XhsAdapter {
  private readonly client: JsonRpcHttpClient;
  private readonly restBaseUrl: string;
  private readonly restTimeoutMs = normalizePositiveEnv("XHS_REST_TIMEOUT_MS", 90_000);
  private readonly tools: ToolNames;
  private initialized = false;

  constructor(config: XhsConfig) {
    const url = config.mcp?.url ?? "http://localhost:18060/mcp";
    this.client = new JsonRpcHttpClient(url);
    this.restBaseUrl = url.replace(/\/mcp\/?$/, "");
    this.tools = {
      searchPosts: config.mcp?.tools?.searchPosts ?? "search_feeds",
      getPost: config.mcp?.tools?.getPost ?? "get_feed_detail",
      openPost: config.mcp?.tools?.openPost,
      prefillComment: config.mcp?.tools?.prefillComment,
      publishComment: config.mcp?.tools?.publishComment ?? "post_comment_to_feed",
      likePost: config.mcp?.tools?.likePost ?? "like_feed"
    };
  }

  async searchPosts(query: string, limit: number, options: XhsAdapterRequestOptions = {}): Promise<XhsPost[]> {
    if (this.tools.searchPosts === "search_feeds") {
      return this.searchFeedsRest(query, limit, options);
    }

    await this.ensureInitialized();
    const result = await this.callTool(this.tools.searchPosts, { query, limit });
    return coercePosts(result).slice(0, limit);
  }

  async getPost(postOrUrl: XhsPost | string, options: XhsAdapterRequestOptions = {}): Promise<XhsPost | null> {
    if (!this.tools.getPost) return null;
    const post = typeof postOrUrl === "string" ? urlToPost(postOrUrl) : postOrUrl;
    if (this.tools.getPost === "get_feed_detail" && post.xsecToken) {
      return this.getFeedDetailRest(post, options);
    }

    await this.ensureInitialized();
    const result = await this.callTool(this.tools.getPost, {
      idOrUrl: post.url || post.id,
      url: post.url,
      feed_id: post.id,
      xsec_token: post.xsecToken,
      load_all_comments: false,
      max_comment_items: 10
    });
    return coercePosts(result)[0] ?? null;
  }

  async getComments(postOrUrl: XhsPost | string, limit: number, options: XhsAdapterRequestOptions = {}): Promise<XhsComment[]> {
    return this.getFeedCommentsRest(typeof postOrUrl === "string" ? urlToPost(postOrUrl) : postOrUrl, limit, options);
  }

  async openPost(url: string): Promise<void> {
    if (!this.tools.openPost) {
      openExternal(url);
      return;
    }
    await this.ensureInitialized();
    await this.callTool(this.tools.openPost, { url });
  }

  async prefillComment(url: string, comment: string): Promise<boolean> {
    if (!this.tools.prefillComment) return false;
    await this.ensureInitialized();
    await this.callTool(this.tools.prefillComment, { url, comment });
    return true;
  }

  async publishComment(post: XhsPost, comment: string, options: XhsAdapterRequestOptions = {}): Promise<boolean> {
    if (!this.tools.publishComment) {
      throw new Error("No publishComment MCP tool configured.");
    }
    if (this.tools.publishComment === "post_comment_to_feed") {
      if (!post.xsecToken) {
        throw new Error(`Cannot publish ${post.id}: missing xsec_token from search results.`);
      }
      await this.postCommentRest(post, comment, options);
      return true;
    }

    await this.ensureInitialized();
    await this.callTool(this.tools.publishComment, {
      id: post.id,
      url: post.url,
      feed_id: post.id,
      xsec_token: post.xsecToken,
      comment,
      content: comment
    });
    return true;
  }

  async likePost(post: XhsPost, options: XhsAdapterRequestOptions = {}): Promise<boolean> {
    if (!this.tools.likePost) return false;
    if (!post.xsecToken) {
      throw new Error(`Cannot like ${post.id}: missing xsec_token from search results.`);
    }
    if (this.tools.likePost === "like_feed") {
      await this.likeFeedRest(post, options);
      return true;
    }
    await this.ensureInitialized();
    await this.callTool(this.tools.likePost, {
      feed_id: post.id,
      xsec_token: post.xsecToken,
      unlike: false
    });
    return true;
  }

  private async postCommentRest(post: XhsPost, comment: string, options: XhsAdapterRequestOptions = {}): Promise<void> {
    const response = await fetchWithTimeout(new URL("/api/v1/feeds/comment", this.restBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feed_id: post.id,
        xsec_token: post.xsecToken,
        content: comment
      })
    }, this.restTimeoutMs, options.signal);
    if (!response.ok) {
      throw new Error(`XHS REST comment failed: HTTP ${response.status} ${await response.text()}`);
    }
  }

  private async likeFeedRest(post: XhsPost, options: XhsAdapterRequestOptions = {}): Promise<void> {
    const response = await fetchWithTimeout(new URL("/api/v1/feeds/like", this.restBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feed_id: post.id,
        xsec_token: post.xsecToken,
        unlike: false
      })
    }, this.restTimeoutMs, options.signal);
    if (!response.ok) {
      throw new Error(`XHS REST like failed: HTTP ${response.status} ${await response.text()}`);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kato", version: "0.1.0" }
    });
    await this.client.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client.request("tools/call", {
      name,
      arguments: args
    });
    assertToolResultOk(name, result);
    return result;
  }

  private async searchFeedsRest(query: string, limit: number, options: XhsAdapterRequestOptions = {}): Promise<XhsPost[]> {
    const url = new URL("/api/v1/feeds/search", this.restBaseUrl);
    url.searchParams.set("keyword", query);
    const response = await fetchWithTimeout(url, {}, this.restTimeoutMs, options.signal);
    if (!response.ok) {
      throw new Error(`XHS REST search failed: HTTP ${response.status} ${await response.text()}`);
    }
    return coercePosts(await response.json()).slice(0, limit);
  }

  private async getFeedDetailRest(post: XhsPost, options: XhsAdapterRequestOptions = {}): Promise<XhsPost | null> {
    const response = await fetchWithTimeout(new URL("/api/v1/feeds/detail", this.restBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feed_id: post.id,
        xsec_token: post.xsecToken,
        load_all_comments: false,
        comment_config: {
          max_comment_items: 10,
          scroll_speed: "normal"
        }
      })
    }, this.restTimeoutMs, options.signal);
    if (!response.ok) {
      throw new Error(`XHS REST detail failed: HTTP ${response.status} ${await response.text()}`);
    }
    return coercePosts(await response.json())[0] ?? post;
  }

  private async getFeedCommentsRest(post: XhsPost, limit: number, options: XhsAdapterRequestOptions = {}): Promise<XhsComment[]> {
    const response = await fetchWithTimeout(new URL("/api/v1/feeds/comments", this.restBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feed_id: post.id,
        xsec_token: post.xsecToken,
        url: post.url,
        limit
      })
    }, this.restTimeoutMs, options.signal);
    if (!response.ok) {
      throw new Error(`XHS REST comments failed: HTTP ${response.status} ${await response.text()}`);
    }
    return coerceComments(await response.json()).slice(0, limit);
  }
}

class StdioMcpXhsAdapter implements XhsAdapter {
  private readonly client: JsonRpcStdioClient;
  private readonly tools: ToolNames;
  private initialized = false;

  constructor(config: XhsConfig) {
    if (!config.mcp?.command) {
      throw new Error("xhs.config.local.json must include mcp.command when provider is stdio.");
    }

    this.client = new JsonRpcStdioClient(config.mcp.command, config.mcp.args ?? [], {
      ...process.env,
      ...(config.mcp.env ?? {})
    });
    this.tools = {
      searchPosts: config.mcp.tools?.searchPosts ?? "xhs.searchPosts",
      getPost: config.mcp.tools?.getPost ?? "xhs.getPost",
      openPost: config.mcp.tools?.openPost ?? "xhs.openPost",
      prefillComment: config.mcp.tools?.prefillComment ?? "xhs.prefillComment",
      publishComment: config.mcp.tools?.publishComment,
      likePost: config.mcp.tools?.likePost ?? "like_feed"
    };
  }

  async searchPosts(query: string, limit: number): Promise<XhsPost[]> {
    await this.ensureInitialized();
    const result = await this.callTool(this.tools.searchPosts, { query, limit });
    return coercePosts(result);
  }

  async getPost(postOrUrl: XhsPost | string): Promise<XhsPost | null> {
    await this.ensureInitialized();
    if (!this.tools.getPost) return null;
    const post = typeof postOrUrl === "string" ? urlToPost(postOrUrl) : postOrUrl;
    const result = await this.callTool(this.tools.getPost, {
      idOrUrl: post.url || post.id,
      url: post.url,
      feed_id: post.id,
      xsec_token: post.xsecToken,
      load_all_comments: false,
      max_comment_items: 10
    });
    const posts = coercePosts(result);
    return posts[0] ?? null;
  }

  async getComments(postOrUrl: XhsPost | string, limit: number): Promise<XhsComment[]> {
    await this.ensureInitialized();
    const post = typeof postOrUrl === "string" ? urlToPost(postOrUrl) : postOrUrl;
    const result = await this.callTool("get_feed_comments", {
      idOrUrl: post.url || post.id,
      url: post.url,
      feed_id: post.id,
      xsec_token: post.xsecToken,
      limit
    });
    return coerceComments(result).slice(0, limit);
  }

  async openPost(url: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.tools.openPost) {
      openExternal(url);
      return;
    }
    await this.callTool(this.tools.openPost, { url });
  }

  async prefillComment(url: string, comment: string): Promise<boolean> {
    await this.ensureInitialized();
    try {
      if (!this.tools.prefillComment) return false;
      await this.callTool(this.tools.prefillComment, { url, comment });
      return true;
    } catch (error) {
      console.warn(`Prefill unavailable for ${url}: ${(error as Error).message}`);
      return false;
    }
  }

  async publishComment(post: XhsPost, comment: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.tools.publishComment) {
      throw new Error("No publishComment MCP tool configured.");
    }
    await this.callTool(this.tools.publishComment, {
      id: post.id,
      url: post.url,
      feed_id: post.id,
      xsec_token: post.xsecToken,
      comment,
      content: comment
    });
    return true;
  }

  async likePost(post: XhsPost): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.tools.likePost) return false;
    await this.callTool(this.tools.likePost, {
      id: post.id,
      url: post.url,
      feed_id: post.id,
      xsec_token: post.xsecToken,
      unlike: false
    });
    return true;
  }

  async close(): Promise<void> {
    this.client.close();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kato", version: "0.1.0" }
    });
    this.client.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client.request("tools/call", {
      name,
      arguments: args
    });
    assertToolResultOk(name, result);
    return result;
  }
}

function assertToolResultOk(toolName: string, result: unknown): void {
  if (!result || typeof result !== "object") return;
  const maybeResult = result as { isError?: unknown; is_error?: unknown; content?: unknown };
  if (maybeResult.isError !== true && maybeResult.is_error !== true) return;
  const message = extractToolText(maybeResult.content) || `MCP tool failed: ${toolName}`;
  throw new Error(message);
}

function extractToolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

class JsonRpcHttpClient {
  private sessionId: string | null = null;

  constructor(private readonly url: string) {}

  async request(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    const payload = await this.send({ jsonrpc: "2.0", id, method, params });
    if (payload.error) throw new Error(payload.error.message ?? `MCP HTTP method failed: ${method}`);
    return payload.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params });
  }

  private async send(payload: unknown): Promise<{ result?: unknown; error?: { message?: string } }> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {})
      },
      body: JSON.stringify(payload)
    });

    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) this.sessionId = nextSessionId;

    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (!text.trim()) return {};

    if (contentType.includes("text/event-stream")) {
      return parseSseJson(text);
    }

    return JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  }
}

class JsonRpcStdioClient extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = Buffer.alloc(0);

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.child.on("exit", (code) => {
      for (const item of this.pending.values()) {
        item.reject(new Error(`MCP server exited with code ${code ?? "unknown"}`));
      }
      this.pending.clear();
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    const payload = { jsonrpc: "2.0", id, method, params };
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Timed out calling MCP method ${method}`));
        }
      }, 60_000).unref();
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.child.kill();
  }

  private send(payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        throw new Error("Invalid MCP response: missing Content-Length.");
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;

      const message = JSON.parse(this.buffer.slice(bodyStart, bodyEnd).toString("utf8"));
      this.buffer = this.buffer.slice(bodyEnd);
      this.handleMessage(message);
    }
  }

  private handleMessage(message: { id?: string; result?: unknown; error?: { message?: string } }): void {
    if (!message.id) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "Unknown MCP error"));
    } else {
      pending.resolve(message.result);
    }
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason ?? new Error("XHS request was aborted."));
  };
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`XHS request timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function normalizePositiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function coercePosts(value: unknown): XhsPost[] {
  const raw = unwrapMcpContent(value);
  const list = extractPostList(raw);
  return list
    .map((item) => item as Partial<XhsPost> & Record<string, unknown>)
    .map(normalizePostShape)
    .filter((item) => item.url && (item.title || item.snippet))
    .map((item) => ({
      id: String(item.id ?? item.url),
      url: String(item.url),
      title: String(item.title ?? ""),
      snippet: String(item.snippet ?? item.description ?? item.content ?? ""),
      author: item.author ? String(item.author) : undefined,
      xsecToken: item.xsecToken ? String(item.xsecToken) : undefined,
      likeCount: toOptionalNumber(item.likeCount ?? item.likes),
      commentCount: toOptionalNumber(item.commentCount ?? item.comments),
      publishedAt: item.publishedAt ? String(item.publishedAt) : undefined
    }));
}

function coerceComments(value: unknown): XhsComment[] {
  const raw = unwrapMcpContent(value);
  const list = extractCommentList(raw);
  return list
    .map((item) => item as Record<string, unknown>)
    .map((item) => ({
      id: String(item.id ?? item.comment_id ?? item.commentId ?? ""),
      content: String(item.content ?? item.text ?? item.comment_content ?? ""),
      author: optionalText(item.author ?? item.author_name ?? item.nickname),
      parentId: optionalText(item.parentId ?? item.parent_id ?? item.parent_comment_id ?? item.parentCommentId)
    }))
    .filter((item) => item.id && item.content);
}

function unwrapMcpContent(value: unknown): unknown {
  const candidate = value as { content?: Array<{ type?: string; text?: string }> };
  if (!candidate?.content?.length) return value;
  const text = candidate.content.find((item) => item.type === "text")?.text;
  if (!text) return value;
  try {
    return JSON.parse(text);
  } catch {
    return [{ id: text, url: text, title: text, snippet: "" }];
  }
}

function toOptionalNumber(value: unknown): number | undefined {
  const numberValue = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function extractPostList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const item = raw as Record<string, unknown> | null;
  if (!item) return [];
  const data = item.data as Record<string, unknown> | unknown[] | undefined;
  if (Array.isArray(data)) return data;
  const nestedData = data?.data as Record<string, unknown> | undefined;
  if (nestedData) return [nestedData];
  const candidates = [
    item,
    data,
    (item.search as Record<string, unknown> | undefined)?.feeds,
    (item.feed as Record<string, unknown> | undefined)?.feeds,
    item.feeds
  ] as Array<Record<string, unknown> | undefined>;

  for (const candidate of candidates) {
    const value = candidate?._value ?? candidate?.value ?? candidate?.list ?? candidate?.items ?? candidate?.feeds;
    if (Array.isArray(value)) return value;
  }

  if (item.note || data?.note) return [item.note ? item : data];
  return item.url || item.id ? [item] : [];
}

function extractCommentList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const item = raw as Record<string, unknown> | null;
  if (!item) return [];
  const data = item.data as Record<string, unknown> | unknown[] | undefined;
  if (Array.isArray(data)) return data;
  const candidates = [
    item,
    data,
    (data as Record<string, unknown> | undefined)?.comments,
    (data as Record<string, unknown> | undefined)?.items,
    item.comments,
    item.items,
    item.comment_list
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizePostShape(item: Partial<XhsPost> & Record<string, unknown>): Partial<XhsPost> & Record<string, unknown> {
  const noteCard = item.noteCard as Record<string, unknown> | undefined;
  const note = item.note as Record<string, unknown> | undefined;
  const user = (noteCard?.user ?? note?.user ?? item.user) as Record<string, unknown> | undefined;
  const interactInfo = (noteCard?.interactInfo ?? note?.interactInfo ?? item.interactInfo) as
    | Record<string, unknown>
    | undefined;
  const id = String(item.id ?? note?.noteId ?? item.noteId ?? "");
  const rawUrl = String(item.url ?? "");
  const xsecToken = String(item.xsecToken ?? note?.xsecToken ?? item.xsec_token ?? extractXsecToken(rawUrl) ?? "");
  const url = normalizeXhsUrl(rawUrl, id, xsecToken);
  return {
    ...item,
    id,
    xsecToken: xsecToken || undefined,
    url,
    title: String(item.title ?? note?.title ?? noteCard?.displayTitle ?? ""),
    snippet: String(item.snippet ?? item.description ?? item.content ?? note?.desc ?? noteCard?.displayTitle ?? ""),
    author: String(item.author ?? user?.nickname ?? user?.nickName ?? ""),
    likeCount: toOptionalNumber(item.likeCount ?? interactInfo?.likedCount ?? interactInfo?.likeCount),
    commentCount: toOptionalNumber(item.commentCount ?? interactInfo?.commentCount),
    publishedAt: item.publishedAt ?? (note?.time ? new Date(Number(note.time) * 1000).toISOString() : undefined)
  };
}

function optionalText(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function buildXhsUrl(id: string, xsecToken: string): string {
  const url = new URL(`https://www.xiaohongshu.com/explore/${encodeURIComponent(id || "unknown")}`);
  if (xsecToken) url.searchParams.set("xsec_token", xsecToken);
  return url.toString();
}

function normalizeXhsUrl(rawUrl: string, id: string, xsecToken: string): string {
  const fallback = buildXhsUrl(id, xsecToken);
  const value = rawUrl.trim();
  if (!value) return fallback;
  try {
    const url = new URL(normalizeUrlCandidate(value));
    if (xsecToken && isXhsExploreUrl(url) && !url.searchParams.get("xsec_token")) {
      url.searchParams.set("xsec_token", xsecToken);
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

function extractXsecToken(rawUrl: string): string {
  try {
    return new URL(normalizeUrlCandidate(rawUrl.trim())).searchParams.get("xsec_token") ?? "";
  } catch {
    return "";
  }
}

function normalizeUrlCandidate(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://www.xiaohongshu.com${value}`;
  if (/^(www\.)?xiaohongshu\.com(\/|$)/i.test(value)) return `https://${value}`;
  return value;
}

function isXhsExploreUrl(url: URL): boolean {
  return /(^|\.)xiaohongshu\.com$/i.test(url.hostname) && url.pathname.split("/").includes("explore");
}

function urlToPost(value: string): XhsPost {
  try {
    const url = new URL(value);
    const id = url.pathname.split("/").filter(Boolean).at(-1) ?? value;
    return {
      id,
      url: value,
      title: "",
      snippet: "",
      xsecToken: url.searchParams.get("xsec_token") ?? undefined
    };
  } catch {
    return { id: value, url: value, title: "", snippet: "" };
  }
}

function parseSseJson(text: string): { result?: unknown; error?: { message?: string } } {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .at(-1);
  return data ? JSON.parse(data) : {};
}

function openExternal(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
}
