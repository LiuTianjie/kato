import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const SERVICE_LOG_LIMIT = normalizePositiveEnv("DOUYIN_SERVICE_LOG_LIMIT", 600);
let serviceLogSeq = 0;
const serviceLogs = [];

let stealthPluginReady = false;
try {
  chromium.use(StealthPlugin());
  stealthPluginReady = true;
} catch (error) {
  serviceLog("warn", "stealth", `Stealth plugin unavailable; using custom fingerprint fallback only: ${errorMessage(error)}`);
}

const PORT = Number(process.env.PORT || process.env.DOUYIN_SERVICE_PORT || 18070);
const BROWSER_RUNTIME_URL =
  process.env.DOUYIN_BROWSER_RUNTIME_URL ||
  process.env.BROWSER_WORKER_RUNTIME_URL ||
  process.env.BROWSER_RUNTIME_URL ||
  "http://127.0.0.1:18111";
const VIEWER_RUNTIME_URL =
  process.env.DOUYIN_VIEWER_RUNTIME_URL ||
  "http://127.0.0.1:18110";
const INTERNAL_CDP_PORT = Number(process.env.DOUYIN_INTERNAL_CDP_PORT || process.env.BROWSER_CDP_PORT || 9224);
const PROFILE_DIR = process.env.DOUYIN_PROFILE_DIR || process.env.BROWSER_PROFILE_DIR || "/app/data/platforms/douyin/worker-profile";
const COOKIES_PATH = process.env.DOUYIN_COOKIES_PATH || "/app/data/platforms/douyin/cookies.json";
const STORAGE_PATH = process.env.DOUYIN_STORAGE_PATH || "/app/data/platforms/douyin/storage.json";
const CDP_CONNECT_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_CDP_CONNECT_TIMEOUT_MS", 30_000);
const CDP_CONNECT_ATTEMPTS = normalizePositiveEnv("DOUYIN_CDP_CONNECT_ATTEMPTS", 3);
const BROWSER_STATUS_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_BROWSER_STATUS_TIMEOUT_MS", 2_000);
const BROWSER_RUNTIME_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_BROWSER_RUNTIME_TIMEOUT_MS", 30_000);
const HEALTH_ENSURE_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_HEALTH_ENSURE_TIMEOUT_MS", 20_000);
const BROWSER_TASK_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_BROWSER_TASK_TIMEOUT_MS", 180_000);
const DOUYIN_COMMENTS_DIRECT_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_COMMENTS_DIRECT_TIMEOUT_MS", 20_000);
const DOUYIN_REPLIES_DIRECT_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_REPLIES_DIRECT_TIMEOUT_MS", 12_000);
const DOUYIN_REPLIES_PAGE_FALLBACK_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_REPLIES_PAGE_FALLBACK_TIMEOUT_MS", 32_000);
const DOUYIN_REPLIES_PAGE_MAX_ROUNDS = normalizePositiveEnv("DOUYIN_REPLIES_PAGE_MAX_ROUNDS", 6);
const DOUYIN_REPLIES_PAGE_FALLBACK_ENABLED = process.env.DOUYIN_REPLIES_PAGE_FALLBACK_ENABLED === "1";
const DOUYIN_COMMENTS_FULL_PAGE_SIZE = normalizePositiveEnv("DOUYIN_COMMENTS_FULL_PAGE_SIZE", 50);
const DOUYIN_COMMENTS_FULL_REPLY_PAGE_SIZE = normalizePositiveEnv("DOUYIN_COMMENTS_FULL_REPLY_PAGE_SIZE", 50);
const DOUYIN_COMMENTS_FULL_MAX_ROOT_PAGES = normalizePositiveEnv("DOUYIN_COMMENTS_FULL_MAX_ROOT_PAGES", 300);
const DOUYIN_COMMENTS_FULL_MAX_REPLY_PAGES = normalizePositiveEnv("DOUYIN_COMMENTS_FULL_MAX_REPLY_PAGES", 300);
const DOUYIN_SIGNER_URL = stringValue(process.env.DOUYIN_SIGNER_URL || "");
const DOUYIN_SIGNER_REQUIRED = process.env.DOUYIN_SIGNER_REQUIRED === "1";
const DOUYIN_SIGNER_TIMEOUT_MS = normalizePositiveEnv("DOUYIN_SIGNER_TIMEOUT_MS", 8_000);
const DOUYIN_GENERATE_MISSING_TOKENS = process.env.DOUYIN_GENERATE_MISSING_TOKENS !== "0";
const HUMAN_DELAY_ENABLED = process.env.DOUYIN_HUMAN_DELAY_ENABLED !== "0";
const TASK_DELAY_MIN_MS = normalizeNonNegativeEnv("DOUYIN_BROWSER_TASK_DELAY_MIN_MS", 900);
const TASK_DELAY_MAX_MS = normalizeDelayMax("DOUYIN_BROWSER_TASK_DELAY_MAX_MS", 2_600, TASK_DELAY_MIN_MS);
const BROWSER_QUEUE_MAX_PENDING = normalizePositiveEnv("DOUYIN_BROWSER_QUEUE_MAX_PENDING", 12);
const BROWSER_QUEUE_RECENT_LIMIT = normalizePositiveEnv("DOUYIN_BROWSER_QUEUE_RECENT_LIMIT", 24);
const BROWSER_VERSION = detectChromeVersion();
const BROWSER_MAJOR_VERSION = process.env.DOUYIN_BROWSER_MAJOR_VERSION || BROWSER_VERSION.major;
const WINDOWS_USER_AGENT =
  process.env.DOUYIN_BROWSER_USER_AGENT ||
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION.full} Safari/537.36`;
const WINDOWS_ACCEPT_LANGUAGE = process.env.DOUYIN_BROWSER_ACCEPT_LANGUAGE || "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7";
const WINDOWS_NAVIGATOR_PLATFORM = process.env.DOUYIN_NAVIGATOR_PLATFORM || "Win32";
const WINDOWS_PLATFORM_VERSION = process.env.DOUYIN_BROWSER_PLATFORM_VERSION || "10.0.0";
const WINDOWS_UA_METADATA = {
  brands: [
    { brand: "Google Chrome", version: BROWSER_MAJOR_VERSION },
    { brand: "Chromium", version: BROWSER_MAJOR_VERSION },
    { brand: "Not/A)Brand", version: "24" }
  ],
  fullVersionList: [
    { brand: "Google Chrome", version: BROWSER_VERSION.full },
    { brand: "Chromium", version: BROWSER_VERSION.full },
    { brand: "Not/A)Brand", version: "24.0.0.0" }
  ],
  fullVersion: BROWSER_VERSION.full,
  platform: "Windows",
  platformVersion: WINDOWS_PLATFORM_VERSION,
  architecture: "x86",
  bitness: "64",
  model: "",
  mobile: false,
  wow64: false
};
const DOUYIN_COOKIE_DOMAINS = [".douyin.com", "douyin.com", ".iesdouyin.com", "iesdouyin.com", ".amemv.com", "amemv.com", "bytedance"];
const DOUYIN_LOGIN_COOKIE_NAMES = new Set([
  "sessionid",
  "sessionid_ss",
  "sid_guard",
  "sid_tt",
  "uid_tt",
  "uid_tt_ss",
  "sid_ucp_v1",
  "ssid_ucp_v1",
  "sso_uid_tt",
  "sso_uid_tt_ss",
  "passport_auth_status",
  "passport_auth_status_ss",
  "passport_fe_beating_status",
  "login_status",
  "n_mh"
]);
let contextPromise;
let restartPromise;
let browserTaskTail = Promise.resolve();
let browserTaskSeq = 0;
let browserTaskGeneration = 0;
let browserTaskPending = 0;
let browserTaskActive = null;
let browserTaskActiveContext = null;
let browserTaskRecords = new Map();
let browserTaskRecent = [];
let cookiePersistTimer;

class BrowserTaskTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserTaskTimeoutError";
  }
}

class BrowserTaskCancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserTaskCancelledError";
  }
}

class BrowserQueueBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserQueueBusyError";
    this.statusCode = 429;
    this.code = "QUEUE_BUSY";
  }
}

class DouyinChallengeRequiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DouyinChallengeRequiredError";
    this.statusCode = 428;
    this.code = "CHALLENGE_REQUIRED";
    this.details = details;
  }
}

class DouyinUpstreamTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DouyinUpstreamTimeoutError";
    this.statusCode = 504;
    this.code = "UPSTREAM_TIMEOUT";
    this.details = details;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const requestSignal = createRequestAbortSignal(req, res);

    if (req.method === "GET" && url.pathname === "/api/v1/browser/logs") {
      const since = Number(url.searchParams.get("since") || 0);
      const limit = Number(url.searchParams.get("limit") || 200);
      sendJson(res, 200, { success: true, data: { logs: serviceLogsSince(since, limit), cursor: serviceLogSeq } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/queue/reset") {
      const body = await readJson(req).catch(() => ({}));
      const result = resetBrowserTaskQueue(String(body.reason || "manual reset"));
      sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/restart") {
      const body = await readJson(req).catch(() => ({}));
      serviceLog("warn", "browser", "Browser restart requested.", { reason: body.reason || "manual" });
      const data = await restartBrowser(`priority:${String(body.reason || "manual")}`);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const ensure = url.searchParams.get("ensure") === "1";
      const browser = await healthBrowserSummary({ ensure });
      const auth = await persistedLoginStatus().catch((error) => ({ is_logged_in: false, cookie_count: 0, error: errorMessage(error) }));
      const ok = ensure ? browser.running === true : true;
      sendJson(res, ok ? 200 : 503, { ok, service: "kato-douyin-browser", browser, auth });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/login/status") {
      const data = await loginStatus();
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/export-auth") {
      const data = await persistedAuthPayload();
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/sync-cookies") {
      await openViewerForStorageExport().catch((error) => {
        serviceLog("info", "storage", `Douyin viewer navigation before storage sync skipped: ${errorMessage(error)}`);
      });
      const cookies = await exportViewerCookies(DOUYIN_COOKIE_DOMAINS);
      const storage = await exportViewerStorage(DOUYIN_COOKIE_DOMAINS, ["https://www.douyin.com"]).catch((error) => {
        serviceLog("warn", "storage", `Douyin browser storage sync failed: ${errorMessage(error)}`);
        return [];
      });
      await persistCookies(cookies, "manual-sync");
      if (storage.length) {
        await persistStorage(storage, "manual-sync");
      } else {
        serviceLog("info", "storage", "Douyin browser storage sync returned no origins; keeping existing storage file.");
      }
      const context = contextPromise ? await contextPromise.catch(() => undefined) : undefined;
      if (context && cookies.length) await addCookiesToContext(context, cookies, "manual-sync");
      if (context && storage.length) await restoreStorage(context, storage).catch((error) => {
        serviceLog("warn", "storage", `Douyin worker storage restore after sync failed: ${errorMessage(error)}`);
      });
      const exportedCookies = cookies.length;
      const auth = summarizeLoginStatus(cookies, "viewer-sync", { storageOrigins: storage.length });
      serviceLog("info", "cookies", "Douyin browser cookies synced manually.", { exportedCookies, exportedStorageOrigins: storage.length });
      sendJson(res, 200, {
        success: true,
        data: { cookiesPath: COOKIES_PATH, storagePath: STORAGE_PATH, exportedCookies, exportedStorageOrigins: storage.length, auth }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/update-cookie") {
      const body = await readJson(req);
      const cookieHeader = String(body.cookie || body.cookies || "").trim();
      if (!cookieHeader) throw new Error("cookie is required.");
      const cookies = parseCookieHeader(cookieHeader, ".douyin.com");
      if (!cookies.length) throw new Error("No valid cookie pairs found.");
      await persistCookies(cookies, "serverx-update");
      const context = contextPromise ? await contextPromise.catch(() => undefined) : undefined;
      if (context) await addCookiesToContext(context, cookies, "serverx-update");
      serviceLog("info", "cookies", "Douyin cookies updated from API.", { count: cookies.length });
      sendJson(res, 200, {
        success: true,
        data: { cookiesPath: COOKIES_PATH, updatedCookies: cookies.length, auth: summarizeLoginStatus(cookies, "api-update") }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/links/resolve") {
      const body = await readJson(req);
      const data = await enqueueBrowserTask("links:resolve", async (taskContext) => {
        await applyRequestAuth(body.auth, "links:resolve");
        return resolveDouyinLink(String(body.url || body.text || ""), taskContext);
      }, {
        signal: requestSignal
      });
      sendJson(res, 200, { success: true, data });
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/v1/posts/search") {
      const body = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
      const keyword = String(body.keyword || body.query || "").trim();
      const limit = normalizeLimit(body.limit, 20);
      const page = normalizePositiveInt(body.page, 1);
      const data = await enqueueBrowserTask("posts:search", (taskContext) => searchPosts(keyword, limit, {
        auth: body.auth,
        page,
        cursor: body.cursor,
        sort_type: normalizeDouyinSortType(body.sort_type, body.sort_label),
        publish_time: body.publish_time,
        taskContext
      }), {
        signal: requestSignal
      });
      sendJson(res, 200, {
        success: true,
        data: {
          posts: data,
          items: data,
          count: data.length,
          page,
          page_size: limit,
          has_more: data.length >= limit
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/posts/detail") {
      const body = await readJson(req);
      const post = await enqueueBrowserTask("posts:detail", (taskContext) => getPostDetail(body, taskContext), { signal: requestSignal });
      sendJson(res, 200, { success: true, data: { post, item: post, items: post ? [post] : [] } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/posts/comments") {
      const body = await readJson(req);
      const limit = normalizeLimit(body.limit || body.count || body.max_comments, 20);
      const result = await enqueueBrowserTask("posts:comments", (taskContext) => getPostComments(body, limit, taskContext), {
        signal: requestSignal
      });
      sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/posts/comments_full") {
      const body = await readJson(req);
      const result = await enqueueBrowserTask("posts:comments_full", (taskContext) => getPostCommentsFull(body, taskContext), {
        signal: requestSignal
      });
      sendJson(res, 200, { success: true, data: result });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/posts/comment_replies") {
      const body = await readJson(req);
      const limit = normalizeLimit(body.limit || body.count || body.max_comments, 20);
      const result = await enqueueBrowserTask("posts:comment_replies", (taskContext) => getCommentReplies(body, limit, taskContext), {
        signal: requestSignal
      });
      sendJson(res, 200, { success: true, data: result });
      return;
    }

    sendJson(res, 404, { success: false, error: { code: "NOT_FOUND", message: "Endpoint not found." } });
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof BrowserTaskCancelledError) {
      serviceLog("info", "request", `${req.method || "GET"} ${req.url || "/"} cancelled: ${message}`);
      sendJson(res, 499, { success: false, error: { code: "CLIENT_CLOSED_REQUEST", message } });
      return;
    }
    if (error instanceof BrowserQueueBusyError) {
      serviceLog("info", "request", `${req.method || "GET"} ${req.url || "/"} queue busy: ${message}`);
      sendJson(res, error.statusCode, { success: false, error: { code: error.code, message, queue: browserQueueSummary() } });
      return;
    }
    if (error instanceof DouyinChallengeRequiredError) {
      serviceLog("warn", "request", `${req.method || "GET"} ${req.url || "/"} requires Douyin challenge: ${message}`, error.details);
      sendJson(res, error.statusCode, { success: false, error: { code: error.code, message, details: error.details } });
      return;
    }
    if (error instanceof DouyinUpstreamTimeoutError) {
      serviceLog("warn", "request", `${req.method || "GET"} ${req.url || "/"} upstream timeout: ${message}`, error.details);
      sendJson(res, error.statusCode, { success: false, error: { code: error.code, message, details: error.details } });
      return;
    }
    serviceLog("error", "request", `${req.method || "GET"} ${req.url || "/"} failed: ${message}`);
    sendJson(res, 500, { success: false, error: { code: "INTERNAL_ERROR", message } });
  }
});

server.listen(PORT, () => {
  serviceLog("info", "service", `kato-douyin-browser listening on http://0.0.0.0:${PORT}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  try {
    const context = contextPromise ? await contextPromise.catch(() => undefined) : undefined;
    if (context) await persistContextCookies(context, "shutdown").catch(() => undefined);
    await context?.browser()?.close().catch(() => undefined);
  } finally {
    stopCookieAutoPersist();
    server.close();
    process.exit(0);
  }
}

async function healthBrowserSummary({ ensure = false } = {}) {
  if (!ensure) return browserSummary();
  try {
    await withTimeout(ensureContext(), HEALTH_ENSURE_TIMEOUT_MS, "Browser health ensure timed out.");
  } catch (error) {
    return {
      running: false,
      queue: browserQueueSummary(),
      stealth: stealthSummary(),
      error: errorMessage(error)
    };
  }
  return browserSummary();
}

async function browserSummary() {
  const runtime = await runtimeBrowserSummary().catch((error) => ({ ok: false, error: errorMessage(error) }));
  if (!contextPromise) return { running: false, queue: browserQueueSummary(), stealth: stealthSummary(), runtime };
  try {
    const context = await withTimeout(contextPromise, BROWSER_STATUS_TIMEOUT_MS, "Browser status timed out.");
    return { running: true, pages: context.pages().length, queue: browserQueueSummary(), stealth: stealthSummary(), runtime };
  } catch (error) {
    return {
      running: false,
      queue: browserQueueSummary(),
      stealth: stealthSummary(),
      runtime,
      error: errorMessage(error)
    };
  }
}

function stealthSummary() {
  return {
    plugin: stealthPluginReady,
    customFingerprint: true,
    platform: "Windows",
    cdp: "internal-loopback"
  };
}

async function ensureContext() {
  if (!contextPromise) {
    contextPromise = launchContext().catch((error) => {
      contextPromise = undefined;
      throw error;
    });
  }
  return contextPromise;
}

async function launchContext() {
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(path.dirname(COOKIES_PATH), { recursive: true });
  try {
    await ensureRuntimeBrowser();
    await waitForCdpHttp();
    const browser = await connectBrowserOverCdp();
    const context = browser.contexts()[0] || (await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "zh-CN" }));
    await configureContextFingerprint(context);
    await loadCookies(context);
    await loadStorage(context);
    startCookieAutoPersist(context);
    context.on("page", (page) => {
      page.setDefaultTimeout(30_000);
      applyPageFingerprint(page).catch((error) => {
        serviceLog("warn", "stealth", `Page fingerprint apply failed: ${errorMessage(error)}`);
      });
    });
    await verifyContextReady(context);
    return context;
  } catch (error) {
    stopCookieAutoPersist();
    throw error;
  }
}

async function configureContextFingerprint(context) {
  await context.setExtraHTTPHeaders({ "Accept-Language": WINDOWS_ACCEPT_LANGUAGE }).catch(() => undefined);
  await context.addInitScript(
    ({ userAgent, platform, platformVersion, brands, fullVersionList, languages }) => {
      const defineGetter = (target, key, value) => {
        try {
          Object.defineProperty(target, key, { get: () => value, configurable: true });
        } catch {
          // Browser-owned descriptors may be locked on some builds.
        }
      };

      defineGetter(Navigator.prototype, "platform", platform);
      defineGetter(Navigator.prototype, "userAgent", userAgent);
      defineGetter(Navigator.prototype, "appVersion", userAgent.replace(/^Mozilla\//, ""));
      defineGetter(Navigator.prototype, "languages", languages);
      defineGetter(Navigator.prototype, "language", languages[0]);
      defineGetter(Navigator.prototype, "webdriver", undefined);
      defineGetter(Navigator.prototype, "maxTouchPoints", 0);

      const userAgentData = {
        brands,
        mobile: false,
        platform: "Windows",
        getHighEntropyValues: async (hints = []) => {
          const values = {
            brands,
            mobile: false,
            platform: "Windows",
            architecture: "x86",
            bitness: "64",
            model: "",
            platformVersion,
            uaFullVersion: fullVersionList[0]?.version || "",
            fullVersionList
          };
          return Object.fromEntries(hints.map((hint) => [hint, values[hint]]).filter(([, value]) => value !== undefined));
        },
        toJSON: () => ({ brands, mobile: false, platform: "Windows" })
      };
      defineGetter(Navigator.prototype, "userAgentData", userAgentData);
    },
    {
      userAgent: WINDOWS_USER_AGENT,
      platform: WINDOWS_NAVIGATOR_PLATFORM,
      platformVersion: WINDOWS_PLATFORM_VERSION,
      brands: WINDOWS_UA_METADATA.brands,
      fullVersionList: WINDOWS_UA_METADATA.fullVersionList,
      languages: ["zh-CN", "zh", "en-US", "en"]
    }
  ).catch((error) => serviceLog("warn", "stealth", `Context fingerprint init failed: ${errorMessage(error)}`));

  await Promise.all(context.pages().map((page) => applyPageFingerprint(page)));
}

async function applyPageFingerprint(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Emulation.setUserAgentOverride", {
      userAgent: WINDOWS_USER_AGENT,
      acceptLanguage: WINDOWS_ACCEPT_LANGUAGE,
      platform: "Windows",
      userAgentMetadata: WINDOWS_UA_METADATA
    });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function verifyContextReady(context) {
  const page = await context.newPage();
  try {
    await applyPageFingerprint(page).catch(() => undefined);
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10_000 });
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
  }
}

async function newTaskPage(taskContext) {
  taskContext?.throwIfCancelled?.();
  const context = await ensureContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  taskContext.page = page;
  page.on("crash", () => {
    serviceLog("error", "browser", "Task page crashed.", { task: `#${taskContext.id}:${taskContext.label}`, url: safeLogUrl(page.url()) });
  });
  await applyPageFingerprint(page).catch((error) => serviceLog("warn", "stealth", `Task page fingerprint apply failed: ${errorMessage(error)}`));
  bindTaskPage(taskContext, page);
  return page;
}

function enqueueBrowserTask(label, task, options = {}) {
  if (browserTaskPending >= BROWSER_QUEUE_MAX_PENDING) {
    throw new BrowserQueueBusyError(
      `Douyin browser queue is busy: pending=${browserTaskPending}, max=${BROWSER_QUEUE_MAX_PENDING}. Retry after current tasks finish or restart Kato.`
    );
  }
  const id = ++browserTaskSeq;
  const generation = browserTaskGeneration;
  const timeoutMs = normalizePositiveInt(options.timeoutMs, BROWSER_TASK_TIMEOUT_MS);
  const queuedAt = Date.now();
  const taskContext = createBrowserTaskContext(id, label, options.signal);
  trackBrowserTask({ id, label, status: "queued", queuedAt: new Date(queuedAt).toISOString(), timeoutMs, generation });
  browserTaskPending += 1;

  const run = async () => {
    let removedFromPending = false;
    const removeFromPending = () => {
      if (removedFromPending) return;
      browserTaskPending = Math.max(0, browserTaskPending - 1);
      removedFromPending = true;
    };
    let markCancelled;
    let finalStatus = "completed";
    let finalError = "";
    try {
      if (generation !== browserTaskGeneration) {
        removeFromPending();
        throw new BrowserTaskCancelledError(`Browser task #${id}:${label} was dropped by queue reset.`);
      }
      removeFromPending();
      taskContext.throwIfCancelled();
      const startedAt = new Date().toISOString();
      browserTaskActive = { id, label, startedAt, cancelled: false };
      browserTaskActiveContext = taskContext;
      markCancelled = () => {
        if (browserTaskActive?.id !== id) return;
        browserTaskActive.cancelled = true;
        browserTaskActive.cancelReason = abortReasonMessage(taskContext.signal);
        updateBrowserTaskRecord(id, { status: "cancelling", cancelled: true, cancelReason: browserTaskActive.cancelReason });
        serviceLog("info", "queue", `Browser task #${id} cancelled: ${label}.`, { reason: browserTaskActive.cancelReason });
      };
      taskContext.signal.addEventListener("abort", markCancelled, { once: true });
      const waitedMs = Date.now() - queuedAt;
      updateBrowserTaskRecord(id, { status: "running", startedAt, waitMs: waitedMs });
      serviceLog("info", "queue", `Browser task #${id} started: ${label}.`, {
        waitedMs,
        pending: browserTaskPending
      });
      const jitterMs = await humanDelay(`task:${label}`, TASK_DELAY_MIN_MS, TASK_DELAY_MAX_MS, { log: true, signal: taskContext.signal });
      if (jitterMs > 0) updateBrowserTaskRecord(id, { delayMs: jitterMs });
      const lease = await acquireRuntimeLease(label, timeoutMs, taskContext);
      taskContext.leaseId = lease.leaseId;
      if (browserTaskActive?.id === id) {
        browserTaskActive.leaseId = lease.leaseId;
        updateBrowserTaskRecord(id, { leaseId: lease.leaseId });
      }
      return await runBrowserTaskWithTimeout(label, task, timeoutMs, taskContext);
    } catch (error) {
      finalStatus = error instanceof BrowserTaskCancelledError ? "cancelled" : "failed";
      finalError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      removeFromPending();
      const activeMs = browserTaskActive?.id === id ? Date.now() - Date.parse(browserTaskActive.startedAt) : 0;
      if (browserTaskActive?.id === id) {
        serviceLog("info", "queue", `Browser task #${id} finished: ${label}.`, { activeMs, pending: browserTaskPending });
        if (markCancelled) taskContext.signal.removeEventListener("abort", markCancelled);
        browserTaskActive = null;
        browserTaskActiveContext = null;
      }
      finishBrowserTaskRecord(id, finalStatus, { error: finalError, activeMs });
      await closeTaskPage(taskContext, "task finished").catch(() => undefined);
      await releaseRuntimeLease(taskContext.leaseId).catch(() => undefined);
    }
  };

  const result = browserTaskTail.then(run, run);
  browserTaskTail = result.catch(() => undefined);
  return result;
}

function resetBrowserTaskQueue(reason) {
  const previous = browserQueueSummary();
  browserTaskGeneration += 1;
  browserTaskPending = 0;
  browserTaskTail = Promise.resolve();
  for (const record of Array.from(browserTaskRecords.values())) {
    if (record.status === "queued") finishBrowserTaskRecord(record.id, "cancelled", { cancelReason: `queue reset: ${reason}` });
  }
  if (browserTaskActiveContext) {
    updateBrowserTaskRecord(browserTaskActiveContext.id, { status: "cancelling", cancelled: true, cancelReason: `queue reset: ${reason}` });
    browserTaskActiveContext.abort(new BrowserTaskCancelledError(`Browser task queue reset: ${reason}`));
  }
  serviceLog("warn", "queue", "Douyin browser task queue reset.", { reason, previous, generation: browserTaskGeneration });
  return { reset: true, reason, previous, queue: browserQueueSummary() };
}

async function runBrowserTaskWithTimeout(label, task, timeoutMs, taskContext) {
  let timer;
  const taskPromise = Promise.resolve().then(() => task(taskContext));
  const abortPromise = new Promise((_, reject) => {
    if (taskContext.signal.aborted) {
      reject(taskAbortReason(taskContext.signal));
      return;
    }
    taskContext.signal.addEventListener("abort", () => reject(taskAbortReason(taskContext.signal)), { once: true });
  });
  try {
    timer = setTimeout(() => taskContext.abort(new BrowserTaskTimeoutError(`Browser task ${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    return await Promise.race([taskPromise, abortPromise]);
  } catch (error) {
    if (error instanceof BrowserTaskTimeoutError) {
      taskPromise.catch(() => undefined);
      await resetBrowserAfterTaskTimeout(label, taskContext);
    } else if (error instanceof BrowserTaskCancelledError) {
      taskPromise.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resetBrowserAfterTaskTimeout(label, taskContext) {
  serviceLog("warn", "queue", `Browser task timed out; resetting Chromium before next task: ${label}`);
  const oldContextPromise = contextPromise;
  contextPromise = undefined;
  stopCookieAutoPersist();
  if (oldContextPromise) {
    const context = await withTimeout(oldContextPromise, 1_500, "Timed-out browser context close timed out.").catch(() => undefined);
    await withTimeout(context?.browser()?.close(), 1_500, "Timed-out browser close timed out.").catch(() => undefined);
  }
  await requestRuntimeRestart(`douyin task timeout: ${label}`, taskContext?.leaseId);
}

function createBrowserTaskContext(id, label, externalSignal) {
  const controller = new AbortController();
  const context = {
    id,
    label,
    signal: controller.signal,
    page: undefined,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw taskAbortReason(controller.signal);
    }
  };

  if (externalSignal) {
    const abortFromExternal = () => context.abort(taskAbortReason(externalSignal, `Browser task ${label} cancelled because client disconnected.`));
    if (externalSignal.aborted) abortFromExternal();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  return context;
}

function bindTaskPage(taskContext, page) {
  if (!taskContext?.signal) return;
  const closePage = () => closeCancelledTaskPage(taskContext, page);
  if (taskContext.signal.aborted) {
    closePage();
    throw taskAbortReason(taskContext.signal);
  }
  taskContext.signal.addEventListener("abort", closePage, { once: true });
}

function closeCancelledTaskPage(taskContext, page) {
  if (!page || page.isClosed()) return;
  serviceLog("warn", "queue", `Closing active page for cancelled task #${taskContext.id}: ${taskContext.label}.`, {
    reason: abortReasonMessage(taskContext.signal)
  });
  page.close({ runBeforeUnload: false }).catch(() => undefined);
}

async function closeTaskPage(taskContext, reason) {
  const page = taskContext?.page;
  taskContext.page = undefined;
  if (!page || page.isClosed()) return;
  serviceLog("info", "queue", `Closing task page after ${reason}.`, {
    task: `#${taskContext.id}:${taskContext.label}`,
    url: safeLogUrl(page.url())
  });
  await page.close({ runBeforeUnload: false }).catch(() => undefined);
}

async function withBrowserRecovery(label, task, taskContext) {
  try {
    taskContext?.throwIfCancelled?.();
    return await task();
  } catch (error) {
    if (error instanceof BrowserTaskCancelledError || error instanceof BrowserTaskTimeoutError) throw error;
    if (!isRecoverableBrowserError(error)) throw error;
    taskContext?.throwIfCancelled?.();
    serviceLog("warn", "browser", `Recoverable browser error in ${label}; restarting.`, { error: errorMessage(error).slice(0, 240) });
    await restartBrowser(`${label}: ${errorMessage(error).slice(0, 240)}`, taskContext);
    taskContext?.throwIfCancelled?.();
    return task();
  }
}

function isRecoverableBrowserError(error) {
  return /Page crashed|Target closed|Browser has been closed|Execution context was destroyed|Protocol error|connectOverCDP|CDP|timed out/i.test(
    errorMessage(error)
  );
}

async function restartBrowser(reason = "manual", taskContext) {
  if (restartPromise) return restartPromise;
  restartPromise = withTimeout(
    (async () => {
      serviceLog("warn", "browser", `Restarting runtime browser: ${reason}`);
      const oldContextPromise = contextPromise;
      contextPromise = undefined;
      stopCookieAutoPersist();
      if (oldContextPromise) {
        const context = await withTimeout(oldContextPromise, 1_500, "Old browser context close timed out.").catch(() => undefined);
        if (context) await persistContextCookies(context, "restart").catch(() => undefined);
        await withTimeout(context?.browser()?.close(), 1_500, "Old browser close timed out.").catch(() => undefined);
      }
      await requestRuntimeRestart(reason, taskContext?.leaseId);
      await ensureContext();
      return { restarted: true, reason, browser: await browserSummary() };
    })(),
    120_000,
    "Browser restart timed out."
  ).finally(() => {
    restartPromise = undefined;
  });
  return restartPromise;
}

async function loginStatus() {
  const persisted = await persistedLoginStatus();
  if (persisted.cookie_count > 0 || persisted.storage_origin_count > 0) return persisted;
  return {
    ...persisted,
    is_logged_in: false,
    source: "file",
    username: ""
  };
}

async function searchPosts(keyword, limit, options = {}) {
  const taskContext = options.taskContext;
  return withBrowserRecovery(
    "searchPosts",
    async () => {
      await applyRequestAuth(options.auth, "posts:search");
      if (!keyword.trim()) return [];
      const pageNumber = normalizePositiveInt(options.page, 1);
      const page = await newTaskPage(taskContext);
      const offset = normalizeCursorOffset(options.cursor, (pageNumber - 1) * limit);
      const fallbackScrollPages = Math.max(2, pageNumber + 1, Math.floor(offset / Math.max(limit, 1)) + 2);
      serviceLog("info", "posts", "Douyin search requested.", { keyword, limit, page: pageNumber, cursor: options.cursor, offset });
      let directSearch = false;
      let payloads = [];
      try {
        await prepareDouyinApiPage(page, "search:api");
        const directPayload = await withTimeout(
          fetchSearchInPage(page, {
            keyword,
            offset,
            count: limit,
            sort_type: options.sort_type,
            publish_time: options.publish_time
          }),
          25_000,
          "Douyin search API timed out."
        );
        payloads = [{ kind: "search", url: "direct:general-search", payload: directPayload }];
        directSearch = true;
      } catch (error) {
        serviceLog("warn", "posts", `Direct search API failed, falling back to page search: ${errorMessage(error)}`);
        const capture = startDouyinResponseCapture(page, ["search"]);
        const targetUrl = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
        try {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((navigationError) => {
            serviceLog("warn", "posts", `Search navigation warning: ${errorMessage(navigationError)}`);
          });
          await humanDelay("search:settle", 2_500, 5_500, { signal: taskContext?.signal });
          await autoScroll(page, fallbackScrollPages, taskContext);
        } finally {
          payloads = await capture.stop();
        }
      }
      taskContext?.throwIfCancelled?.();
      const parsedPosts = uniquePosts(extractPostsFromPayloads(payloads));
      const fallbackPosts = parsedPosts.length ? [] : await scrapePosts(page);
      const posts = uniquePosts([...parsedPosts, ...fallbackPosts]);
      posts.sort((left, right) => postTimeValue(right) - postTimeValue(left));
      const relevantPosts = filterPostsByKeyword(posts, keyword);
      const sourcePosts = relevantPosts.length ? relevantPosts : posts;
      const start = directSearch ? 0 : offset;
      const result = sourcePosts.slice(start, start + limit);
      const pageTitle = await page.title().catch(() => "");
      const bodyPreview = result.length ? "" : await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      assertNoDouyinChallenge({ pageTitle, bodyPreview, url: page.url(), task: "searchPosts" });
      serviceLog("info", "posts", "Douyin search completed.", {
        keyword,
        capturedPayloads: payloads.length,
        parsed: posts.length,
        relevant: relevantPosts.length,
        returned: result.length,
        directSearch,
        currentUrl: safeLogUrl(page.url()),
        title: pageTitle,
        bodyPreview: sanitizeLogText(bodyPreview).slice(0, 160)
      });
      return result;
    },
    taskContext
  );
}

async function getPostDetail(body, taskContext) {
  return withBrowserRecovery(
    "getPostDetail",
    async () => {
      await applyRequestAuth(body.auth, "posts:detail");
      const resolved = await normalizePostInput(body, taskContext);
      if (!resolved.awemeId && !resolved.url) throw new Error("aweme_id, id or url is required.");
      const url = resolved.url || canonicalPostUrl(resolved.awemeId);
      serviceLog("info", "detail", "Douyin detail requested.", { awemeId: resolved.awemeId, url: safeLogUrl(url) });
      const page = await newTaskPage(taskContext);
      const capture = startDouyinResponseCapture(page, ["detail", "comment"]);
      let payloads = [];
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });
        await humanDelay("detail:settle", 2_000, 5_000, { signal: taskContext?.signal });
      } finally {
        payloads = await capture.stop();
      }
      await assertPageNotChallenged(page, "getPostDetail");
      const posts = extractPostsFromPayloads(payloads);
      let detail = posts.find((post) => !resolved.awemeId || post.id === resolved.awemeId) || posts[0] || null;
      if (!detail && resolved.awemeId) {
        const fallback = await fetchDetailInPage(page, resolved.awemeId).catch((error) => {
          serviceLog("warn", "detail", `In-page detail fetch failed: ${errorMessage(error)}`);
          return null;
        });
        detail = fallback ? extractPostsFromPayloads([fallback]).find((post) => post.id === resolved.awemeId) || extractPostsFromPayloads([fallback])[0] || null : null;
      }
      detail ||= await scrapeDetail(page, resolved);
      return detail || normalizePost({ aweme_id: resolved.awemeId, share_url: url, desc: "", raw: { url } });
    },
    taskContext
  );
}

async function getPostComments(body, limit, taskContext) {
  return withBrowserRecovery(
    "getPostComments",
    async () => {
      await applyRequestAuth(body.auth, "posts:comments");
      const resolved = await normalizePostInput(body, taskContext);
      if (!resolved.awemeId && !resolved.url) throw new Error("aweme_id, id or url is required.");
      const cursor = normalizeCursor(body.cursor, 0);
      const sortType = normalizeDouyinSortType(body.sort_type, body.sort_label);
      const page = await newTaskPage(taskContext);
      let extracted = { comments: [], cursor: "", hasMore: false };
      let source = "direct";
      let directError = null;
      try {
        await prepareDouyinApiPage(page, "comments:api");
        const directPayload = await withTimeout(
          fetchCommentsInPage(page, "list", { aweme_id: resolved.awemeId, cursor, count: limit, sort_type: sortType }),
          DOUYIN_COMMENTS_DIRECT_TIMEOUT_MS,
          "Douyin comments API timed out."
        );
        extracted = extractCommentsPayload([directPayload], "");
      } catch (error) {
        directError = error;
        serviceLog("warn", "comments", `Direct comments fetch failed: ${errorMessage(error)}`);
      }
      if (directError && !canFallbackCommentsByPage(cursor)) throw directError;
      if (!extracted.comments.length && (isInitialCursor(cursor) || directError)) {
        source = "page";
        extracted = await collectCommentsFromPage(page, resolved, cursor, limit, taskContext);
      }
      const comments = uniqueComments(extracted.comments).slice(0, limit);
      const hasMore = extracted.hasMore || comments.length >= limit;
      const nextCursor = normalizeNextCursor(extracted.cursor, cursor, limit, comments.length, hasMore);
      serviceLog("info", "comments", "Douyin comments completed.", {
        awemeId: resolved.awemeId,
        returned: comments.length,
        cursor,
        nextCursor,
        source
      });
      return {
        comments,
        items: comments,
        cursor: nextCursor,
        has_more: hasMore
      };
    },
    taskContext
  );
}

async function getPostCommentsFull(body, taskContext) {
  return withBrowserRecovery(
    "getPostCommentsFull",
    async () => {
      await applyRequestAuth(body.auth, "posts:comments_full");
      const resolved = await normalizePostInput(body, taskContext);
      if (!resolved.awemeId && !resolved.url) throw new Error("aweme_id, id or url is required.");
      const page = await newTaskPage(taskContext);
      await prepareDouyinApiPage(page, "comments_full:api");
      const itemId = resolved.awemeId;
      const sortType = normalizeDouyinSortType(body.sort_type, body.sort_label);
      const rootPageSize = normalizeFullPageSize(body.page_size || body.limit || body.count, DOUYIN_COMMENTS_FULL_PAGE_SIZE);
      const replyPageSize = normalizeFullPageSize(body.reply_page_size || body.replyPageSize, DOUYIN_COMMENTS_FULL_REPLY_PAGE_SIZE);
      const maxRootPages = normalizeFullPageCount(body.max_root_pages || body.maxRootPages, DOUYIN_COMMENTS_FULL_MAX_ROOT_PAGES);
      const maxReplyPages = normalizeFullPageCount(body.max_reply_pages || body.maxReplyPages, DOUYIN_COMMENTS_FULL_MAX_REPLY_PAGES);
      let cursor = normalizeCursor(body.cursor, 0);
      let rootPages = 0;
      let replyPages = 0;
      let stoppedByLimit = false;
      let stopReason = "";
      const rootComments = [];
      const replyComments = [];
      const failedReplyParents = [];

      while (rootPages < maxRootPages) {
        taskContext?.throwIfCancelled?.();
        const payload = await withTimeout(
          fetchCommentsInPage(page, "list", { aweme_id: itemId, cursor, count: rootPageSize, sort_type: sortType }),
          DOUYIN_COMMENTS_DIRECT_TIMEOUT_MS,
          "Douyin comments full API timed out."
        );
        const extracted = extractCommentsPayload([payload], "");
        const roots = uniqueComments(extracted.comments);
        rootComments.push(...roots);
        rootPages += 1;
        serviceLog("info", "comments", "Douyin comments full root page fetched.", {
          awemeId: itemId,
          cursor,
          nextCursor: extracted.cursor,
          returned: roots.length,
          hasMore: extracted.hasMore
        });
        for (const root of roots) {
          taskContext?.throwIfCancelled?.();
          const replyTotal = Number(root.raw?.reply_comment_total ?? root.raw?.reply_count ?? 0);
          if (!Number.isFinite(replyTotal) || replyTotal <= 0) continue;
          try {
            const replyResult = await fetchAllCommentRepliesInPage(page, {
              itemId,
              commentId: root.id,
              pageSize: replyPageSize,
              sortType,
              maxPages: maxReplyPages,
              taskContext
            });
            replyPages += replyResult.pages;
            replyComments.push(...replyResult.comments);
            if (replyResult.stoppedByLimit) stoppedByLimit = true;
          } catch (error) {
            failedReplyParents.push({
              comment_id: root.id,
              expected: replyTotal,
              error: errorMessage(error).slice(0, 240)
            });
            serviceLog("warn", "comments", "Douyin comments full replies failed.", {
              awemeId: itemId,
              commentId: root.id,
              error: errorMessage(error).slice(0, 240)
            });
          }
        }
        if (!extracted.hasMore) {
          cursor = "";
          stopReason = "no_more";
          break;
        }
        const nextCursor = normalizeNextCursor(extracted.cursor, cursor, rootPageSize, roots.length, extracted.hasMore);
        if (!nextCursor || nextCursor === String(cursor)) {
          cursor = "";
          stopReason = "cursor_not_advanced";
          break;
        }
        cursor = nextCursor;
      }
      if (rootPages >= maxRootPages && cursor) {
        stoppedByLimit = true;
        stopReason = "max_root_pages";
      }
      const uniqueRoots = uniqueComments(rootComments);
      const uniqueReplies = uniqueComments(replyComments.map((comment) => ({ ...comment, parentId: comment.parentId || comment.raw?.reply_id || "" })));
      const comments = uniqueComments([...uniqueRoots, ...uniqueReplies]);
      serviceLog("info", "comments", "Douyin comments full completed.", {
        awemeId: itemId,
        roots: uniqueRoots.length,
        replies: uniqueReplies.length,
        total: comments.length,
        rootPages,
        replyPages,
        failedReplyParents: failedReplyParents.length,
        stoppedByLimit,
        stopReason
      });
      return {
        comments,
        items: comments,
        root_comments: uniqueRoots,
        reply_comments: uniqueReplies,
        cursor,
        has_more: Boolean(cursor && stoppedByLimit),
        stats: {
          root_count: uniqueRoots.length,
          reply_count: uniqueReplies.length,
          total_count: comments.length,
          root_pages: rootPages,
          reply_pages: replyPages,
          failed_reply_parents: failedReplyParents,
          stopped_by_limit: stoppedByLimit,
          stop_reason: stopReason
        }
      };
    },
    taskContext
  );
}

async function fetchAllCommentRepliesInPage(page, { itemId, commentId, pageSize, sortType, maxPages, taskContext }) {
  let cursor = 0;
  let pages = 0;
  const comments = [];
  let stoppedByLimit = false;
  while (pages < maxPages) {
    taskContext?.throwIfCancelled?.();
    const payload = await withTimeout(
      fetchCommentsInPage(page, "reply", { item_id: itemId, comment_id: commentId, cursor, count: pageSize, sort_type: sortType }),
      DOUYIN_REPLIES_DIRECT_TIMEOUT_MS,
      "Douyin comments full replies API timed out."
    );
    const extracted = extractCommentsPayload([payload], commentId);
    comments.push(...extracted.comments.map((comment) => ({ ...comment, parentId: comment.parentId || commentId })));
    pages += 1;
    if (!extracted.hasMore) {
      cursor = "";
      break;
    }
    const nextCursor = normalizeNextCursor(extracted.cursor, cursor, pageSize, extracted.comments.length, extracted.hasMore);
    if (!nextCursor || nextCursor === String(cursor)) break;
    cursor = nextCursor;
  }
  if (pages >= maxPages && cursor) stoppedByLimit = true;
  return { comments: uniqueComments(comments), pages, stoppedByLimit };
}

async function getCommentReplies(body, limit, taskContext) {
  return withBrowserRecovery(
    "getCommentReplies",
    async () => {
      await applyRequestAuth(body.auth, "posts:comment_replies");
      const itemId = String(body.item_id || body.aweme_id || body.id || "").trim();
      const commentId = String(body.comment_id || body.commentId || "").trim();
      if (!itemId || !commentId) throw new Error("item_id/aweme_id and comment_id are required.");
      const cursor = normalizeCursor(body.cursor, 0);
      const sortType = normalizeDouyinSortType(body.sort_type, body.sort_label);
      const page = await newTaskPage(taskContext);
      let extracted = { comments: [], cursor: "", hasMore: false };
      let directError = null;
      let source = "direct";
      try {
        await prepareDouyinApiPage(page, "replies:api");
        const directPayload = await withTimeout(
          fetchCommentsInPage(page, "reply", { item_id: itemId, comment_id: commentId, cursor, count: limit, sort_type: sortType }),
          DOUYIN_REPLIES_DIRECT_TIMEOUT_MS,
          "Douyin replies API timed out."
        );
        extracted = extractCommentsPayload([directPayload], commentId);
      } catch (error) {
        directError = error;
        serviceLog("warn", "comments", `Direct replies fetch failed: ${errorMessage(error)}`);
      }
      if (directError && !isInitialCursor(cursor)) throw directError;
      if (!extracted.comments.length && isInitialCursor(cursor) && DOUYIN_REPLIES_PAGE_FALLBACK_ENABLED) {
        source = "page";
        try {
          extracted = await runStepWithTimeout(
            "comments:reply-page-fallback",
            (signal) => expandRepliesFromPage(page, { itemId, commentId, cursor, limit, signal }),
            DOUYIN_REPLIES_PAGE_FALLBACK_TIMEOUT_MS,
            `Douyin reply page fallback timed out after ${DOUYIN_REPLIES_PAGE_FALLBACK_TIMEOUT_MS}ms.`,
            taskContext?.signal,
            {
              itemId,
              commentId,
              cursor,
              limit,
              directError: directError ? errorMessage(directError).slice(0, 240) : ""
            }
          );
        } catch (error) {
          serviceLog("warn", "comments", "Douyin replies fallback failed; returning empty replies.", {
            itemId,
            commentId,
            cursor,
            limit,
            directError: directError ? errorMessage(directError).slice(0, 240) : "",
            fallbackError: errorMessage(error).slice(0, 240)
          });
          extracted = { comments: [], cursor: "", hasMore: false };
          source = "none";
        }
      } else if (!extracted.comments.length && directError) {
        serviceLog("warn", "comments", "Douyin replies direct fetch failed; page fallback disabled, returning empty replies.", {
          itemId,
          commentId,
          cursor,
          limit,
          directError: errorMessage(directError).slice(0, 240)
        });
        source = "none";
      }
      const comments = uniqueComments(extracted.comments.map((comment) => ({ ...comment, parentId: comment.parentId || commentId }))).slice(0, limit);
      const hasMore = extracted.hasMore || comments.length >= limit;
      const nextCursor = normalizeNextCursor(extracted.cursor, cursor, limit, comments.length, hasMore);
      serviceLog("info", "comments", "Douyin replies completed.", {
        itemId,
        commentId,
        cursor,
        nextCursor,
        returned: comments.length,
        source,
        directFailed: Boolean(directError)
      });
      return {
        comments,
        items: comments,
        cursor: nextCursor,
        has_more: hasMore
      };
    },
    taskContext
  );
}

async function collectCommentsFromPage(page, resolved, cursor, limit, taskContext) {
  const offset = cursorToOffset(cursor);
  const targetCount = offset + limit;
  const maxRounds = Math.min(36, Math.max(4, Math.ceil(targetCount / 8) + 3));
  const capture = startDouyinResponseCapture(page, ["comment"]);
  const payloads = [];
  try {
    await page.goto(resolved.url || canonicalPostUrl(resolved.awemeId), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await humanDelay("comments:settle", 2_000, 4_800, { signal: taskContext?.signal });
    for (let round = 0; round < maxRounds; round += 1) {
      taskContext?.throwIfCancelled?.();
      payloads.push(...(await capture.drain()));
      const collected = uniqueComments(extractCommentsPayload(payloads, "").comments);
      if (collected.length >= targetCount) break;
      await page.mouse.wheel(0, 620 + Math.round(Math.random() * 520)).catch(() => undefined);
      await humanDelay("comments:page-scroll", 700, 1_700, { signal: taskContext?.signal });
    }
  } finally {
    payloads.push(...(await capture.stop()));
  }
  await assertPageNotChallenged(page, "collectCommentsFromPage");
  const extracted = extractCommentsPayload(payloads, "");
  const allComments = uniqueComments(extracted.comments);
  const comments = allComments.slice(offset, offset + limit);
  const hasMore = comments.length > 0 && (extracted.hasMore || allComments.length > offset + comments.length || comments.length >= limit);
  serviceLog("info", "comments", "Douyin comments page fallback completed.", {
    awemeId: resolved.awemeId,
    cursor,
    offset,
    collected: allComments.length,
    returned: comments.length,
    maxRounds
  });
  return {
    comments,
    cursor: hasMore ? String(offset + comments.length) : "",
    hasMore
  };
}

async function resolveDouyinLink(input, taskContext) {
  const raw = input.trim();
  if (!raw) throw new Error("url or text is required.");
  const extractedUrl = extractFirstUrl(raw);
  const directId = extractAwemeId(raw);
  if (!extractedUrl && directId) {
    return { url: canonicalPostUrl(directId), resolvedUrl: canonicalPostUrl(directId), aweme_id: directId, id: directId };
  }
  if (!extractedUrl) throw new Error("No Douyin URL found.");
  let resolvedUrl = extractedUrl;
  try {
    const response = await fetch(extractedUrl, { redirect: "follow", signal: AbortSignal.timeout(12_000), headers: { "User-Agent": WINDOWS_USER_AGENT } });
    resolvedUrl = response.url || extractedUrl;
  } catch (error) {
    serviceLog("warn", "links", `HTTP resolve failed; falling back to browser URL: ${errorMessage(error)}`);
  }
  let awemeId = extractAwemeId(resolvedUrl) || extractAwemeId(extractedUrl);
  if (!awemeId) {
    const page = await newTaskPage(taskContext);
    await page.goto(extractedUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    await humanDelay("link:resolve", 800, 1_800, { signal: taskContext?.signal });
    resolvedUrl = page.url() || resolvedUrl;
    awemeId = extractAwemeId(resolvedUrl);
  }
  return {
    url: extractedUrl,
    resolvedUrl,
    aweme_id: awemeId || "",
    id: awemeId || "",
    canonicalUrl: awemeId ? canonicalPostUrl(awemeId) : resolvedUrl
  };
}

async function expandRepliesFromPage(page, { itemId, commentId, cursor, limit, signal }) {
  const capture = startDouyinResponseCapture(page, ["commentReply"]);
  const matchedPayloads = [];
  try {
    await page.goto(canonicalPostUrl(itemId), { waitUntil: "domcontentloaded", timeout: 35_000 });
    await humanDelay("replies:page-settle", 1_500, 3_000, { signal });
    await assertPageNotChallenged(page, "expandRepliesFromPage");

    for (let scrollIndex = 0; scrollIndex < DOUYIN_REPLIES_PAGE_MAX_ROUNDS; scrollIndex += 1) {
      signal?.throwIfAborted?.();
      const clicked = await clickVisibleReplyExpander(page);
      await humanDelay("replies:expand", 700, 1_600, { signal });
      const payloads = await capture.drain();
      matchedPayloads.push(...payloads.filter((entry) => responseMatchesCommentId(entry.url, commentId)));
      if (matchedPayloads.length) break;
      await page.mouse.wheel(0, clicked ? 360 : 760);
      await humanDelay("replies:scroll", 500, 1_200, { signal });
    }
  } finally {
    const payloads = await capture.stop();
    matchedPayloads.push(...payloads.filter((entry) => responseMatchesCommentId(entry.url, commentId)));
  }

  const extracted = extractCommentsPayload(matchedPayloads, commentId);
  serviceLog("info", "comments", "Douyin reply page expansion completed.", {
    commentId,
    matchedPayloads: matchedPayloads.length,
    returned: extracted.comments.length,
    cursor,
    limit,
    maxRounds: DOUYIN_REPLIES_PAGE_MAX_ROUNDS
  });
  return extracted;
}

async function clickVisibleReplyExpander(page) {
  const selectors = [
    "text=/展开\\d+条回复/",
    "text=/展开.*回复/",
    "text=/查看.*回复/"
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      const visible = await item.isVisible().catch(() => false);
      if (!visible) continue;
      await item.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
      await item.click({ timeout: 3_000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

function responseMatchesCommentId(url, commentId) {
  try {
    return String(new URL(url).searchParams.get("comment_id") || "") === String(commentId || "");
  } catch {
    return false;
  }
}

function startDouyinResponseCapture(page, kinds) {
  const payloads = [];
  const targets = new Set(kinds);
  const onResponse = async (response) => {
    const url = response.url();
    const kind = classifyDouyinResponse(url);
    if (!kind || !targets.has(kind)) return;
    try {
      const payload = await response.json();
      payloads.push({ kind, url, payload });
    } catch {
      // Non-JSON responses are expected for some static resources.
    }
  };
  page.on("response", onResponse);
  return {
    async drain() {
      await delay(250);
      return payloads.splice(0);
    },
    async stop() {
      await delay(250);
      page.off("response", onResponse);
      return payloads.splice(0);
    }
  };
}

function classifyDouyinResponse(url) {
  if (!/douyin\.com/i.test(url) || !/\/aweme\/v1\/web\//i.test(url)) return "";
  if (/\/general\/search\/single\/|\/search\/item\/|\/discover\/search\//i.test(url)) return "search";
  if (/\/aweme\/detail\//i.test(url)) return "detail";
  if (/\/comment\/list\/reply\//i.test(url)) return "commentReply";
  if (/\/comment\/list\//i.test(url)) return "comment";
  return "";
}

async function fetchSearchInPage(page, params) {
  const url = new URL("https://www.douyin.com/aweme/v1/web/general/search/single/");
  const runtimeParams = await readDouyinRuntimeParams(page);
  const defaults = {
    ...douyinWebApiDefaults(runtimeParams),
    search_channel: "aweme_general",
    keyword: params.keyword,
    search_source: "normal_search",
    query_correct_type: "1",
    is_filter_search: "0",
    offset: params.offset,
    count: params.count,
    sort_type: params.sort_type ?? "0",
    publish_time: params.publish_time ?? "0",
    filter_duration: params.filter_duration ?? "0",
    need_filter_settings: "1",
    list_type: "single",
    update_version_code: "170400"
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const requestUrl = await signDouyinApiUrl(page, url.toString(), runtimeParams, "search");
  return fetchJsonInPage(page, requestUrl, 20_000, "Douyin search fetch timed out.");
}

async function fetchCommentsInPage(page, type, params) {
  const endpoint =
    type === "reply" ? "https://www.douyin.com/aweme/v1/web/comment/list/reply/" : "https://www.douyin.com/aweme/v1/web/comment/list/";
  const url = new URL(endpoint);
  const runtimeParams = await readDouyinRuntimeParams(page);
  const defaults = {
    ...douyinWebApiDefaults(runtimeParams),
    item_type: "0",
    ...(type === "reply"
      ? {}
      : {
          insert_ids: "",
          whale_cut_token: "",
          cut_version: "1",
          rcFT: ""
        })
  };
  for (const [key, value] of Object.entries({ ...defaults, ...params })) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  if (type === "reply") {
    serviceLog("info", "comments", "Douyin replies direct request prepared.", {
      itemId: stringValue(params.item_id),
      commentId: stringValue(params.comment_id),
      cursor: stringValue(params.cursor),
      count: stringValue(params.count),
      hasMsToken: Boolean(runtimeParams.msToken),
      hasTtwid: Boolean(runtimeParams.ttwid),
      hasVerifyFp: Boolean(runtimeParams.verifyFp)
    });
  }
  const requestUrl = await signDouyinApiUrl(page, url.toString(), runtimeParams, type === "reply" ? "commentReply" : "comment");
  if (type === "reply") {
    return fetchJsonWithPageCookies(page, requestUrl, 20_000, "Douyin reply fetch timed out.");
  }
  return fetchJsonInPage(page, requestUrl, 20_000, "Douyin comment fetch timed out.");
}

async function fetchJsonWithPageCookies(page, requestUrl, timeoutMs, timeoutMessage) {
  const cookies = await page.context().cookies("https://www.douyin.com").catch(() => []);
  const cookieHeader = cookies
    .filter((cookie) => cookie?.name)
    .map((cookie) => `${cookie.name}=${cookie.value || ""}`)
    .join("; ");
  const response = await fetchWithTimeout(
    requestUrl,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": WINDOWS_ACCEPT_LANGUAGE,
        "user-agent": WINDOWS_USER_AGENT,
        referer: "https://www.douyin.com/",
        ...(cookieHeader ? { cookie: cookieHeader } : {})
      }
    },
    timeoutMs
  ).catch((error) => {
    if (/timed out|abort/i.test(errorMessage(error))) throw new Error(timeoutMessage);
    throw error;
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

function douyinWebApiDefaults(runtimeParams = {}) {
  return {
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    pc_client_type: "1",
    version_code: "290100",
    version_name: "29.1.0",
    cookie_enabled: "true",
    screen_width: runtimeParams.screenWidth || "1920",
    screen_height: runtimeParams.screenHeight || "1080",
    browser_language: runtimeParams.browserLanguage || "zh-CN",
    browser_platform: "Win32",
    browser_name: "Chrome",
    browser_version: BROWSER_VERSION.full,
    browser_online: runtimeParams.browserOnline || "true",
    engine_name: "Blink",
    engine_version: BROWSER_VERSION.full,
    os_name: "Windows",
    os_version: "10",
    cpu_core_num: runtimeParams.hardwareConcurrency || "12",
    device_memory: runtimeParams.deviceMemory || "8",
    platform: "PC",
    downlink: runtimeParams.downlink || "10",
    effective_type: runtimeParams.effectiveType || "4g",
    from_user_page: "1",
    locate_query: "false",
    need_time_list: "1",
    pc_libra_divert: "Windows",
    publish_video_strategy_type: "2",
    round_trip_time: runtimeParams.roundTripTime || "50",
    show_live_replay_strategy: "1",
    time_list_query: "0",
    whale_cut_token: "",
    update_version_code: "170400",
    ...(runtimeParams.webid ? { webid: runtimeParams.webid } : {}),
    ...(runtimeParams.verifyFp ? { verifyFp: runtimeParams.verifyFp, fp: runtimeParams.verifyFp } : {}),
    ...(runtimeParams.msToken ? { msToken: runtimeParams.msToken } : {})
  };
}

async function readDouyinRuntimeParams(page) {
  const params = await page
    .evaluate(() => {
      const cookies = Object.fromEntries(
        document.cookie
          .split(";")
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => {
            const index = item.indexOf("=");
            if (index < 0) return [item, ""];
            return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
          })
      );
      const safeStorageGet = (key) => {
        try {
          return localStorage.getItem(key) || sessionStorage.getItem(key) || "";
        } catch {
          return "";
        }
      };
      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
      return {
        webid: cookies.webid || cookies.s_v_web_id || safeStorageGet("webid") || "",
        verifyFp: cookies.s_v_web_id || safeStorageGet("s_v_web_id") || safeStorageGet("verifyFp") || "",
        msToken: cookies.msToken || "",
        ttwid: cookies.ttwid || "",
        browserLanguage: navigator.language || "zh-CN",
        browserOnline: navigator.onLine ? "true" : "false",
        screenWidth: String(screen.width || window.innerWidth || 1920),
        screenHeight: String(screen.height || window.innerHeight || 1080),
        hardwareConcurrency: String(navigator.hardwareConcurrency || 12),
        deviceMemory: String(navigator.deviceMemory || 8),
        downlink: String(connection.downlink || 10),
        effectiveType: String(connection.effectiveType || "4g"),
        roundTripTime: String(connection.rtt || 50)
      };
    })
    .catch(() => ({}));
  if (!params.verifyFp && DOUYIN_GENERATE_MISSING_TOKENS) params.verifyFp = generateDouyinVerifyFp();
  if (!params.webid && params.verifyFp) params.webid = params.verifyFp;
  if (!params.msToken && DOUYIN_GENERATE_MISSING_TOKENS) params.msToken = generateDouyinMsToken();
  return params;
}

async function fetchJsonInPage(page, requestUrl, timeoutMs, timeoutMessage) {
  return page.evaluate(
    async ({ requestUrl: innerUrl, timeoutMs: innerTimeoutMs, timeoutMessage: innerTimeoutMessage }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(innerTimeoutMessage)), innerTimeoutMs);
      const response = await fetch(innerUrl, {
        credentials: "include",
        signal: controller.signal,
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"
        },
        mode: "cors",
        referrer: "https://www.douyin.com/"
      }).finally(() => clearTimeout(timeout));
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      return response.json();
    },
    { requestUrl, timeoutMs, timeoutMessage }
  );
}

async function signDouyinApiUrl(page, requestUrl, runtimeParams, task) {
  const browserSignedUrl = await signDouyinApiUrlInBrowser(page, requestUrl).catch((error) => {
    serviceLog("warn", "signer", `Douyin browser signer failed for ${task}: ${errorMessage(error)}`);
    return "";
  });
  if (browserSignedUrl && browserSignedUrl !== requestUrl) {
    serviceLog("info", "signer", `Douyin browser signer applied for ${task}.`, { task });
    return browserSignedUrl;
  }

  if (!DOUYIN_SIGNER_URL) return requestUrl;
  try {
    const response = await fetchWithTimeout(
      new URL(DOUYIN_SIGNER_URL),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "douyin",
          task,
          url: requestUrl,
          userAgent: WINDOWS_USER_AGENT,
          runtime: runtimeParams
        })
      },
      DOUYIN_SIGNER_TIMEOUT_MS
    );
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
    }
    const data = payload?.data || payload;
    const signedUrl = stringValue(data.signedUrl || data.url || data.requestUrl);
    if (!signedUrl) throw new Error("Signer response did not include signedUrl/url.");
    serviceLog("info", "signer", `Douyin external signer applied for ${task}.`, { task });
    return signedUrl;
  } catch (error) {
    const message = `Douyin external signer failed for ${task}: ${errorMessage(error)}`;
    if (DOUYIN_SIGNER_REQUIRED) throw new Error(message);
    serviceLog("warn", "signer", message);
    return requestUrl;
  }
}

async function signDouyinApiUrlInBrowser(page, requestUrl) {
  const signature = await page.evaluate((rawUrl) => {
    const acrawler = window.byted_acrawler || window.bytedAcrawler || window.bytedCrawler;
    if (!acrawler || typeof acrawler !== "object") return null;
    const url = new URL(rawUrl);
    const query = url.searchParams.toString();
    const attempts = [
      () => (typeof acrawler.sign === "function" ? acrawler.sign({ url: url.pathname, params: query }) : null),
      () => (typeof acrawler.sign === "function" ? acrawler.sign(query) : null),
      () => (typeof acrawler.frontierSign === "function" ? acrawler.frontierSign({ url: rawUrl }) : null),
      () => (typeof acrawler.frontierSign === "function" ? acrawler.frontierSign(rawUrl) : null)
    ];
    for (const attempt of attempts) {
      try {
        const result = attempt();
        if (result) return result;
      } catch {
        // Try the next known browser-side signing shape.
      }
    }
    return null;
  }, requestUrl);
  return applyDouyinSignatureResult(requestUrl, signature);
}

function applyDouyinSignatureResult(requestUrl, signature) {
  if (!signature) return "";
  if (typeof signature === "string") {
    const value = signature.trim();
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    const url = new URL(requestUrl);
    const text = value.replace(/^\?/, "").replace(/^&/, "");
    if (/=/.test(text)) {
      for (const pair of text.split("&")) {
        const index = pair.indexOf("=");
        if (index <= 0) continue;
        url.searchParams.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return url.toString();
    }
    url.searchParams.set("X-Bogus", value);
    return url.toString();
  }
  if (typeof signature === "object") {
    const signedUrl = stringValue(signature.url || signature.signedUrl || signature.requestUrl);
    if (signedUrl) return signedUrl;
    const url = new URL(requestUrl);
    const xBogus = stringValue(signature["X-Bogus"] || signature.XBogus || signature.x_bogus);
    const aBogus = stringValue(signature.a_bogus || signature.aBogus || signature["a-bogus"]);
    if (xBogus) url.searchParams.set("X-Bogus", xBogus);
    if (aBogus) url.searchParams.set("a_bogus", aBogus);
    return xBogus || aBogus ? url.toString() : "";
  }
  return "";
}

async function fetchDetailInPage(page, awemeId) {
  await prepareDouyinApiPage(page, "detail:api");
  const url = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/");
  const runtimeParams = await readDouyinRuntimeParams(page);
  const defaults = {
    ...douyinWebApiDefaults(runtimeParams),
    aweme_id: awemeId,
    support_h265: "0",
    support_dash: "1"
  };
  for (const [key, value] of Object.entries(defaults)) url.searchParams.set(key, String(value));
  const requestUrl = await signDouyinApiUrl(page, url.toString(), runtimeParams, "detail");
  return fetchJsonInPage(page, requestUrl, 20_000, "Douyin detail fetch timed out.");
}

async function prepareDouyinApiPage(page, task) {
  if (/^https:\/\/www\.douyin\.com\//i.test(page.url())) {
    await assertPageNotChallenged(page, task);
    return;
  }
  await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error) => {
    serviceLog("warn", "browser", `Douyin API origin navigation warning: ${errorMessage(error)}`);
  });
  await humanDelay(task, 500, 1_200);
  await assertPageNotChallenged(page, task);
}

function extractPostsFromPayloads(payloads) {
  const posts = [];
  for (const entry of payloads) {
    const payload = entry?.payload ?? entry;
    for (const item of walkObjects(payload)) {
      const candidate = item.aweme_info || item.aweme_detail || item.aweme || item.item || item;
      if (!candidate || typeof candidate !== "object") continue;
      if (isLikelyDouyinPost(candidate, item)) {
        const post = normalizePost(candidate);
        if (post.id && (post.title || post.snippet || post.url)) posts.push(post);
      }
    }
  }
  return posts;
}

function isLikelyDouyinPost(candidate, wrapper = {}) {
  if (!candidate || typeof candidate !== "object") return false;
  if (wrapper.aweme_info || wrapper.aweme_detail || wrapper.aweme) return Boolean(candidate.aweme_id || candidate.item_id || candidate.id);
  if (candidate.aweme_id || candidate.item_id) return true;
  if (!candidate.id) return false;
  if (candidate.word && ["recom", "sug", "suggest", "history"].includes(String(candidate.type || "").toLowerCase())) return false;
  return Boolean(
    candidate.desc ||
      candidate.title ||
      candidate.caption ||
      candidate.aweme_title ||
      candidate.share_url ||
      candidate.share_info ||
      candidate.author ||
      candidate.statistics ||
      candidate.video
  );
}

function normalizePost(item) {
  const id = stringValue(item.aweme_id ?? item.awemeId ?? item.item_id ?? item.id);
  const title = stringValue(item.desc ?? item.title ?? item.caption ?? item.aweme_title);
  const author = item.author || item.user || item.user_info || {};
  const statistics = item.statistics || item.stats || item.interact_info || {};
  const shareInfo = item.share_info || item.shareInfo || {};
  const shareUrl = stringValue(item.share_url ?? shareInfo.share_url ?? item.url);
  const url = normalizeDouyinUrl(shareUrl, id);
  return {
    platform: "douyin",
    id,
    url,
    title: title || "抖音作品",
    snippet: title,
    author: stringValue(author.nickname ?? author.name ?? author.unique_id ?? author.short_id),
    likeCount: numberValue(statistics.digg_count ?? statistics.like_count ?? statistics.liked_count),
    commentCount: numberValue(statistics.comment_count),
    publishedAt: dateFromSeconds(item.create_time ?? item.createTime),
    raw: item
  };
}

function normalizeDouyinSortType(value, label) {
  if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  const normalized = String(label || "").trim().toLowerCase();
  if (normalized === "latest") return "2";
  if (normalized === "hot") return "1";
  return "0";
}

function normalizeCursorOffset(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return Math.max(0, Number(fallback) || 0);
  return Math.floor(numeric);
}

function postTimeValue(post) {
  const raw = post?.raw || post || {};
  const time = Number(raw.create_time ?? raw.createTime ?? Date.parse(post?.publishedAt || "") / 1000);
  return Number.isFinite(time) ? time : 0;
}

function extractCommentsPayload(payloads, parentId) {
  const comments = [];
  let cursor = "";
  let hasMore = false;
  for (const entry of payloads) {
    const payload = entry?.payload ?? entry;
    const data = payload && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : {};
    cursor ||= stringValue(payload.cursor ?? payload.next_cursor ?? payload.nextCursor ?? data.cursor ?? data.next_cursor ?? data.nextCursor);
    hasMore =
      hasMore ||
      payload.has_more === 1 ||
      payload.has_more === true ||
      payload.hasMore === true ||
      data.has_more === 1 ||
      data.has_more === true ||
      data.hasMore === true;
    const lists = [];
    if (Array.isArray(payload.comments)) lists.push(payload.comments);
    if (Array.isArray(payload.data?.comments)) lists.push(payload.data.comments);
    if (Array.isArray(payload.data)) lists.push(payload.data);
    if (!lists.length) {
      for (const object of walkObjects(payload)) {
        if (Array.isArray(object.comments)) lists.push(object.comments);
      }
    }
    for (const list of lists) {
      for (const item of list) {
        const comment = normalizeComment(item, parentId);
        if (comment.id && comment.content) comments.push(comment);
      }
    }
  }
  return { comments, cursor, hasMore };
}

function normalizeComment(item, parentId = "") {
  const user = item.user || item.user_info || {};
  const id = stringValue(item.cid ?? item.comment_id ?? item.id);
  return {
    platform: "douyin",
    id,
    content: stringValue(item.text ?? item.content ?? item.reply_comment_total_text),
    author: stringValue(user.nickname ?? user.name ?? user.unique_id),
    parentId: stringValue(item.reply_id ?? item.reply_comment_id ?? item.parent_id ?? parentId),
    raw: item
  };
}

async function assertPageNotChallenged(page, task) {
  const pageTitle = await page.title().catch(() => "");
  const bodyPreview = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  assertNoDouyinChallenge({ pageTitle, bodyPreview, url: page.url(), task });
}

function assertNoDouyinChallenge({ pageTitle, bodyPreview, url, task }) {
  const haystack = `${pageTitle}\n${bodyPreview}`;
  if (!/验证码中间页|验证码|验证|captcha|verifycenter|安全验证/i.test(haystack)) return;
  throw new DouyinChallengeRequiredError(
    "Douyin challenge required. Open the Douyin noVNC viewer, complete the verification, sync cookies/storage, then retry.",
    {
      task,
      title: sanitizeLogText(pageTitle),
      url: safeLogUrl(url),
      action: "open_douyin_novnc_then_sync_cookies"
    }
  );
}

async function scrapePosts(page) {
  const items = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="modal_id="]'));
    return anchors.slice(0, 80).map((anchor) => ({
      href: anchor.href,
      text: anchor.textContent?.trim() || anchor.getAttribute("aria-label") || ""
    }));
  }).catch(() => []);
  return items.map((item) => {
    const id = extractAwemeId(item.href);
    return normalizePost({ aweme_id: id, share_url: item.href, desc: item.text });
  }).filter((post) => post.id);
}

async function scrapeDetail(page, resolved) {
  const data = await page.evaluate(() => {
    const meta = (name) =>
      document.querySelector(`meta[property="${name}"]`)?.getAttribute("content") ||
      document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ||
      "";
    const title = meta("og:title") || document.title || "";
    const desc = meta("description") || meta("og:description") || title;
    return { title, desc, url: location.href };
  }).catch(() => null);
  if (!data) return null;
  return normalizePost({ aweme_id: resolved.awemeId || extractAwemeId(data.url), share_url: data.url, desc: data.desc || data.title });
}

async function normalizePostInput(body, taskContext) {
  const rawUrl = stringValue(body.url || body.share_url || body.source_url);
  let awemeId = stringValue(body.aweme_id || body.awemeId || body.item_id || body.id);
  let url = rawUrl;
  if (!awemeId && rawUrl) {
    const resolved = await resolveDouyinLink(rawUrl, taskContext).catch(() => null);
    awemeId = resolved?.aweme_id || extractAwemeId(rawUrl);
    url = resolved?.canonicalUrl || resolved?.resolvedUrl || rawUrl;
  }
  if (!url && awemeId) url = canonicalPostUrl(awemeId);
  return { awemeId, url };
}

function uniquePosts(posts) {
  const seen = new Set();
  const result = [];
  for (const post of posts) {
    const key = post.id || post.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(post);
  }
  return result;
}

function uniqueComments(comments) {
  const seen = new Set();
  const result = [];
  for (const comment of comments) {
    const key = comment.id || `${comment.author}:${comment.content}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(comment);
  }
  return result;
}

function filterPostsByKeyword(posts, keyword) {
  const normalizedKeyword = compactSearchText(keyword);
  if (!normalizedKeyword) return posts;
  const terms = [
    normalizedKeyword,
    ...String(keyword || "")
      .split(/[\s,，、/|]+/)
      .map(compactSearchText)
      .filter((term) => term.length >= 2)
  ];
  const uniqueTerms = [...new Set(terms)];
  return posts.filter((post) => {
    const rawText = safeJsonStringify(post.raw).slice(0, 20_000);
    const haystack = compactSearchText([post.title, post.snippet, post.author, post.url, rawText].filter(Boolean).join(" "));
    return uniqueTerms.some((term) => haystack.includes(term));
  });
}

function shouldRequireKeywordRelevance(keyword) {
  return compactSearchText(keyword).length >= 2;
}

function compactSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s"'“”‘’`~!！?？,，.。:：;；/\\|()[\]{}<>《》【】_-]+/g, "");
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value || "");
  } catch {
    return "";
  }
}

function generateDouyinVerifyFp() {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const timestamp = Date.now().toString(36);
  const chars = Array.from({ length: 36 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]);
  chars[8] = "_";
  chars[13] = "_";
  chars[14] = "4";
  chars[18] = "_";
  chars[19] = alphabet[(alphabet.indexOf(chars[19]) & 3) | 8] || "8";
  chars[23] = "_";
  return `verify_${timestamp}_${chars.join("")}`;
}

function generateDouyinMsToken() {
  return `${randomTokenString(126)}==`;
}

function randomTokenString(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

function isInitialCursor(cursor) {
  if (cursor === "" || cursor === undefined || cursor === null) return true;
  const numeric = Number(cursor);
  return Number.isFinite(numeric) && numeric <= 0;
}

function canFallbackCommentsByPage(cursor) {
  return Number.isFinite(Number(cursor)) && Number(cursor) >= 0;
}

function cursorToOffset(cursor) {
  const numeric = Number(cursor);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

function normalizeNextCursor(rawCursor, requestCursor, limit, returnedCount, hasMore) {
  const raw = stringValue(rawCursor);
  if (!hasMore) return raw;
  const requestNumber = Number(requestCursor);
  const rawNumber = Number(raw);
  if (!Number.isFinite(requestNumber)) return raw;
  if (raw && (!Number.isFinite(rawNumber) || rawNumber > requestNumber)) return raw;
  const step = Math.max(1, returnedCount || limit || 1);
  return String(Math.floor(requestNumber) + step);
}

async function autoScroll(page, rounds, taskContext) {
  for (let index = 0; index < rounds; index += 1) {
    taskContext?.throwIfCancelled?.();
    await page.mouse.wheel(0, 500 + Math.round(Math.random() * 500)).catch(() => undefined);
    await humanDelay("scroll", 650, 1_600, { signal: taskContext?.signal });
  }
}

async function ensureRuntimeBrowser() {
  const payload = await fetchRuntimeJson("/health?ensure=1", {}, BROWSER_RUNTIME_TIMEOUT_MS);
  const ok = payload?.ok === true || payload?.runtime?.cdp?.ready === true;
  if (!ok) throw new Error(`Browser runtime is not ready: ${JSON.stringify(payload).slice(0, 500)}`);
  return payload;
}

async function runtimeBrowserSummary() {
  return fetchRuntimeJson("/health", {}, BROWSER_RUNTIME_TIMEOUT_MS);
}

async function requestRuntimeRestart(reason, leaseId) {
  return fetchRuntimeJson(
    "/browser/restart",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, leaseId })
    },
    120_000
  );
}

async function acquireRuntimeLease(label, timeoutMs, taskContext) {
  const payload = await fetchRuntimeJson(
    "/browser/lease/acquire",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: "douyin-service",
        label,
        waitMs: timeoutMs,
        ttlMs: Math.max(timeoutMs + 120_000, 300_000)
      })
    },
    Math.max(timeoutMs + 15_000, BROWSER_RUNTIME_TIMEOUT_MS)
  );
  taskContext?.throwIfCancelled?.();
  return payload?.data || payload;
}

async function releaseRuntimeLease(leaseId) {
  if (!leaseId) return;
  await fetchRuntimeJson(
    "/browser/lease/release",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId })
    },
    10_000
  ).catch((error) => serviceLog("warn", "runtime", `Browser runtime lease release failed: ${errorMessage(error)}`));
}

async function exportViewerCookies(domains) {
  const payload = await fetchRuntimeJson(
    "/browser/cookies/export",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains })
    },
    BROWSER_RUNTIME_TIMEOUT_MS
  );
  const data = payload?.data || payload;
  return Array.isArray(data?.cookies) ? data.cookies : [];
}

async function openViewerForStorageExport() {
  await fetchViewerRuntimeJson(
    "/browser/open",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.douyin.com" })
    },
    BROWSER_RUNTIME_TIMEOUT_MS
  );
}

async function exportViewerStorage(domains, origins = []) {
  const payload = await fetchRuntimeJson(
    "/browser/storage/export",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains, origins })
    },
    BROWSER_RUNTIME_TIMEOUT_MS
  );
  const data = payload?.data || payload;
  return Array.isArray(data?.storage) ? data.storage : [];
}

async function waitForCdpHttp() {
  const deadline = Date.now() + CDP_CONNECT_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${INTERNAL_CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await delay(400);
  }
  throw new Error(`CDP endpoint not ready on 127.0.0.1:${INTERNAL_CDP_PORT}: ${lastError}`);
}

async function connectBrowserOverCdp() {
  let lastError;
  for (let attempt = 1; attempt <= CDP_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${INTERNAL_CDP_PORT}`, { timeout: CDP_CONNECT_TIMEOUT_MS });
    } catch (error) {
      lastError = error;
      serviceLog("warn", "browser", `connectOverCDP attempt ${attempt}/${CDP_CONNECT_ATTEMPTS} failed: ${errorMessage(error)}`);
      await requestRuntimeRestart(`douyin cdp connect attempt ${attempt}`).catch(() => undefined);
      await delay(900 * attempt);
    }
  }
  throw lastError;
}

async function fetchRuntimeJson(endpoint, init = {}, timeoutMs = BROWSER_RUNTIME_TIMEOUT_MS) {
  const baseUrl = endpoint === "/browser/cookies/export" || endpoint === "/browser/storage/export" ? VIEWER_RUNTIME_URL : BROWSER_RUNTIME_URL;
  const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
  const response = await fetchWithTimeout(url, init, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || (data && data.success === false)) {
    const message = data?.error?.message || data?.message || `Runtime ${endpoint} failed: HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function fetchViewerRuntimeJson(endpoint, init = {}, timeoutMs = BROWSER_RUNTIME_TIMEOUT_MS) {
  const url = `${VIEWER_RUNTIME_URL.replace(/\/$/, "")}${endpoint}`;
  const response = await fetchWithTimeout(url, init, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || (data && data.success === false)) {
    const message = data?.error?.message || data?.message || `Viewer runtime ${endpoint} failed: HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCookies(context) {
  try {
    const raw = await readFile(COOKIES_PATH, "utf8");
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length) {
      const added = await addCookiesToContext(context, cookies, "load");
      serviceLog("info", "cookies", `Loaded ${added}/${cookies.length} Douyin cookies.`, { cookiesPath: COOKIES_PATH });
    }
  } catch {
    // Missing cookie files are normal on first boot.
  }
}

async function persistedLoginStatus() {
  const cookies = await readPersistedCookies();
  const storage = await readPersistedStorage();
  return summarizeLoginStatus(cookies, "file", { storageOrigins: storage.length });
}

async function persistedAuthPayload() {
  const cookies = await readPersistedCookies();
  const storage = await readPersistedStorage();
  return {
    exported: true,
    source: "file",
    cookie: cookiesToHeader(cookies),
    cookies,
    storage,
    storage_json: JSON.stringify(storage),
    cookie_count: cookies.length,
    storage_origin_count: storage.length,
    auth: summarizeLoginStatus(cookies, "file", { storageOrigins: storage.length })
  };
}

async function readPersistedCookies() {
  try {
    const raw = await readFile(COOKIES_PATH, "utf8");
    const cookies = JSON.parse(raw);
    return Array.isArray(cookies) ? cookies.filter(isDouyinCookie) : [];
  } catch {
    return [];
  }
}

async function readPersistedStorage() {
  try {
    const raw = await readFile(STORAGE_PATH, "utf8");
    const storage = JSON.parse(raw);
    return Array.isArray(storage) ? storage : [];
  } catch {
    return [];
  }
}

function summarizeLoginStatus(cookies, source, extra = {}) {
  const douyinCookies = Array.isArray(cookies) ? cookies.filter(isDouyinCookie) : [];
  const names = new Set(douyinCookies.map((cookie) => stringValue(cookie.name).toLowerCase()).filter(Boolean));
  const loginCookieNames = [...names].filter((name) => DOUYIN_LOGIN_COOKIE_NAMES.has(name));
  const storageOriginCount = Number(extra.storageOrigins || 0);
  const hasSyncedBrowserState = douyinCookies.length > 0 && storageOriginCount > 0;
  return {
    is_logged_in: loginCookieNames.length > 0 || hasSyncedBrowserState,
    cookie_count: douyinCookies.length,
    login_cookie_names: loginCookieNames,
    login_evidence: loginCookieNames.length > 0 ? "cookie" : hasSyncedBrowserState ? "cookie+storage" : "none",
    storage_origin_count: storageOriginCount,
    domains: [...new Set(douyinCookies.map((cookie) => stringValue(cookie.domain)).filter(Boolean))],
    source,
    username: ""
  };
}

async function addCookiesToContext(context, cookies, source) {
  const normalized = normalizeCookiesForPlaywright(cookies);
  if (!normalized.length) return 0;
  try {
    await context.addCookies(normalized);
    return normalized.length;
  } catch (error) {
    serviceLog("warn", "cookies", `Failed to add Douyin cookies to worker context during ${source}: ${errorMessage(error)}`, {
      count: normalized.length
    });
    return 0;
  }
}

function normalizeCookiesForPlaywright(cookies) {
  if (!Array.isArray(cookies)) return [];
  const result = [];
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object") continue;
    const name = stringValue(cookie.name);
    const value = cookie.value == null ? "" : String(cookie.value);
    const domain = stringValue(cookie.domain);
    if (!name || !domain || !isDouyinCookie(cookie)) continue;
    const normalized = {
      name,
      value,
      domain,
      path: stringValue(cookie.path) || "/",
      httpOnly: Boolean(cookie.httpOnly),
      secure: cookie.secure !== false
    };
    const expires = Number(cookie.expires ?? cookie.expirationDate);
    if (Number.isFinite(expires) && expires > 0) normalized.expires = Math.floor(expires);
    const sameSite = normalizeSameSite(cookie.sameSite);
    if (sameSite) normalized.sameSite = sameSite;
    result.push(normalized);
  }
  return result;
}

function normalizeSameSite(value) {
  const normalized = stringValue(value).toLowerCase().replace(/[_\s-]+/g, "");
  if (!normalized || normalized === "unspecified") return undefined;
  if (normalized === "lax") return "Lax";
  if (normalized === "strict") return "Strict";
  if (normalized === "none" || normalized === "norestriction") return "None";
  return undefined;
}

async function loadStorage(context) {
  try {
    const raw = await readFile(STORAGE_PATH, "utf8");
    const storage = JSON.parse(raw);
    if (Array.isArray(storage) && storage.length) {
      await restoreStorage(context, storage);
      serviceLog("info", "storage", `Loaded ${storage.length} Douyin storage origins.`, { storagePath: STORAGE_PATH });
    }
  } catch {
    // Missing storage files are normal on first boot.
  }
}

async function restoreStorage(context, storage) {
  for (const entry of storage) {
    const origin = stringValue(entry?.origin);
    if (!/^https:\/\/([^/]+\.)?douyin\.com$/i.test(origin)) continue;
    const page = await context.newPage();
    try {
      await applyPageFingerprint(page).catch(() => undefined);
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      await page.evaluate(({ localStorageData, sessionStorageData }) => {
        const apply = (target, data) => {
          if (!data || typeof data !== "object") return;
          for (const [key, value] of Object.entries(data)) {
            try {
              target.setItem(key, String(value ?? ""));
            } catch {
              // Ignore storage quota and blocked key failures.
            }
          }
        };
        apply(localStorage, localStorageData);
        apply(sessionStorage, sessionStorageData);
      }, { localStorageData: entry.localStorage || {}, sessionStorageData: entry.sessionStorage || {} });
    } finally {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
  }
}

async function applyRequestAuth(auth, source) {
  if (!auth || typeof auth !== "object") return;
  const cookies = normalizeRequestAuthCookies(auth);
  const storage = normalizeRequestAuthStorage(auth);
  if (!cookies.length && !storage.length) return;
  const context = await ensureContext();
  if (cookies.length) await addCookiesToContext(context, cookies, source);
  if (storage.length) await restoreStorage(context, storage).catch((error) => {
    serviceLog("warn", "storage", `Douyin request storage restore failed during ${source}: ${errorMessage(error)}`);
  });
  serviceLog("info", "cookies", "Douyin request auth applied.", {
    source,
    traceId: stringValue(auth.trace_id || auth.traceId || auth.run_id || auth.runId),
    credentialId: stringValue(auth.credential_id || auth.account_id),
    cookies: cookies.length,
    storageOrigins: storage.length
  });
}

function normalizeRequestAuthCookies(auth) {
  if (!auth || typeof auth !== "object") return [];
  if (Array.isArray(auth.cookies)) return normalizeCookiesForPlaywright(auth.cookies);
  const cookieHeader = stringValue(auth.cookie || auth.cookies);
  if (!cookieHeader) return [];
  return parseCookieHeader(cookieHeader, ".douyin.com");
}

function normalizeRequestAuthStorage(auth) {
  if (!auth || typeof auth !== "object") return [];
  const raw = auth.storage_json || auth.storage;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function startCookieAutoPersist(context) {
  stopCookieAutoPersist();
  cookiePersistTimer = setInterval(() => {
    persistContextCookies(context, "timer").catch((error) => serviceLog("warn", "cookies", `Cookie auto persist failed: ${errorMessage(error)}`));
  }, 30_000);
  cookiePersistTimer.unref?.();
}

function stopCookieAutoPersist() {
  if (cookiePersistTimer) clearInterval(cookiePersistTimer);
  cookiePersistTimer = undefined;
}

async function persistContextCookies(context, source) {
  const cookies = (await context.cookies()).filter(isDouyinCookie);
  await persistCookies(cookies, source);
  return cookies.length;
}

async function persistCookies(cookies, source) {
  await mkdir(path.dirname(COOKIES_PATH), { recursive: true });
  await writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  serviceLog("info", "cookies", `Persisted ${cookies.length} Douyin cookies.`, { source, cookiesPath: COOKIES_PATH });
}

async function persistStorage(storage, source) {
  await mkdir(path.dirname(STORAGE_PATH), { recursive: true });
  await writeFile(STORAGE_PATH, JSON.stringify(storage, null, 2));
  serviceLog("info", "storage", `Persisted ${storage.length} Douyin storage origins.`, { source, storagePath: STORAGE_PATH });
}

function cookiesToHeader(cookies) {
  const pairs = [];
  const seen = new Set();
  for (const cookie of cookies) {
    const name = stringValue(cookie?.name).trim();
    const value = cookie?.value == null ? "" : String(cookie.value);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    pairs.push(`${name}=${value}`);
  }
  return pairs.join("; ");
}

function parseCookieHeader(cookieHeader, domain) {
  const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return null;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (!name || ["path", "domain", "expires", "max-age", "secure", "httponly", "samesite"].includes(name.toLowerCase())) return null;
      return {
        name,
        value,
        domain,
        path: "/",
        expires,
        httpOnly: false,
        secure: true,
        sameSite: "Lax"
      };
    })
    .filter(Boolean);
}

function isDouyinCookie(cookie) {
  return /(^|\.)douyin\.com$/i.test(cookie.domain) || /(^|\.)amemv\.com$/i.test(cookie.domain) || /bytedance/i.test(cookie.domain);
}

function browserQueueSummary() {
  const tasks = Array.from(browserTaskRecords.values())
    .map(browserTaskSnapshot)
    .sort((a, b) => Number(a.id) - Number(b.id));
  return {
    pending: browserTaskPending,
    maxPending: BROWSER_QUEUE_MAX_PENDING,
    active: browserTaskActive,
    generation: browserTaskGeneration,
    tasks,
    recent: browserTaskRecent.slice(0, BROWSER_QUEUE_RECENT_LIMIT)
  };
}

function trackBrowserTask(record) {
  browserTaskRecords.set(record.id, { ...record });
}

function updateBrowserTaskRecord(id, patch) {
  const record = browserTaskRecords.get(id);
  if (!record) return;
  Object.assign(record, patch);
}

function finishBrowserTaskRecord(id, status, extra = {}) {
  const record = browserTaskRecords.get(id);
  if (!record) return;
  const finishedAt = new Date().toISOString();
  const snapshot = browserTaskSnapshot({ ...record, ...extra, status, finishedAt });
  browserTaskRecords.delete(id);
  browserTaskRecent.unshift(snapshot);
  if (browserTaskRecent.length > BROWSER_QUEUE_RECENT_LIMIT) browserTaskRecent = browserTaskRecent.slice(0, BROWSER_QUEUE_RECENT_LIMIT);
}

function browserTaskSnapshot(record) {
  const now = Date.now();
  const queuedAtMs = Date.parse(record.queuedAt) || now;
  const startedAtMs = record.startedAt ? Date.parse(record.startedAt) : 0;
  const finishedAtMs = record.finishedAt ? Date.parse(record.finishedAt) : 0;
  return {
    ...record,
    ageMs: Math.max(0, (finishedAtMs || now) - queuedAtMs),
    waitMs: record.waitMs ?? Math.max(0, (startedAtMs || now) - queuedAtMs),
    activeMs: record.activeMs ?? (startedAtMs ? Math.max(0, (finishedAtMs || now) - startedAtMs) : 0)
  };
}

function createRequestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new BrowserTaskCancelledError("Client disconnected before the browser task completed."));
  };
  req.on("aborted", abort);
  res.on("close", () => {
    if (!res.writableEnded) abort();
  });
  return controller.signal;
}

function taskAbortReason(signal, fallbackMessage = "Browser task was cancelled.") {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason) return new BrowserTaskCancelledError(reason);
  return new BrowserTaskCancelledError(fallbackMessage);
}

function abortReasonMessage(signal) {
  return taskAbortReason(signal).message;
}

function serviceLog(level, source, message, details) {
  const entry = {
    seq: ++serviceLogSeq,
    time: new Date().toISOString(),
    level,
    source,
    message: sanitizeLogText(message),
    details: sanitizeLogDetails(details)
  };
  serviceLogs.push(entry);
  while (serviceLogs.length > SERVICE_LOG_LIMIT) serviceLogs.shift();

  const suffix = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
  const line = `[${entry.time}] [${entry.source}] ${level.toUpperCase()} ${entry.message}${suffix}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function serviceLogsSince(since, limit) {
  const cursor = Number.isFinite(Number(since)) ? Math.max(0, Math.floor(Number(since))) : 0;
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.floor(Number(limit)))) : 200;
  return serviceLogs.filter((entry) => entry.seq > cursor).slice(-max);
}

function sanitizeLogText(value) {
  return String(value || "").slice(0, 1000);
}

function sanitizeLogDetails(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "string" ? sanitizeLogText(item) : item)));
  } catch {
    return sanitizeLogText(value);
  }
}

function safeLogUrl(value) {
  return sanitizeLogText(value).slice(0, 600);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function normalizeLimit(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function normalizeFullPageSize(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(1, Math.min(100, Math.floor(fallback || 50)));
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function normalizeFullPageCount(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(1, Math.floor(fallback || 1));
  return Math.max(1, Math.floor(parsed));
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeCursor(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizePositiveEnv(name, fallback) {
  return normalizePositiveInt(process.env[name], fallback);
}

function normalizeNonNegativeEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function normalizeDelayMax(name, fallback, min) {
  return Math.max(min, normalizeNonNegativeEnv(name, fallback));
}

async function humanDelay(label, minMs, maxMs, options = {}) {
  if (!HUMAN_DELAY_ENABLED || maxMs <= 0) return 0;
  const ms = minMs + Math.round(Math.random() * Math.max(0, maxMs - minMs));
  if (options.log) serviceLog("info", "delay", `Human delay before ${label}.`, { ms });
  await waitForAbortable(delay(ms), options.signal);
  return ms;
}

function waitForAbortable(promise, signal) {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      if (signal.aborted) {
        reject(taskAbortReason(signal));
        return;
      }
      signal.addEventListener("abort", () => reject(taskAbortReason(signal)), { once: true });
    })
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runStepWithTimeout(label, factory, timeoutMs, message, parentSignal, details = {}) {
  const controller = new AbortController();
  const signal = combineAbortSignals(parentSignal, controller.signal);
  const startedAt = Date.now();
  const timeoutError = new DouyinUpstreamTimeoutError(message, { label, timeoutMs, ...details });
  let timer;
  const stepPromise = Promise.resolve().then(() => factory(signal));
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    serviceLog("info", "comments", `Douyin step started: ${label}.`, { timeoutMs, ...details });
    const result = await Promise.race([stepPromise, timeoutPromise]);
    serviceLog("info", "comments", `Douyin step completed: ${label}.`, { elapsedMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    if (error === timeoutError || controller.signal.aborted) {
      stepPromise.catch(() => undefined);
      serviceLog("warn", "comments", `Douyin step timed out: ${label}.`, { elapsedMs: Date.now() - startedAt, timeoutMs, ...details });
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function combineAbortSignals(parentSignal, stepSignal) {
  const signals = [parentSignal, stepSignal].filter(Boolean);
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function walkObjects(value, seen = new Set()) {
  const result = [];
  const visit = (item) => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (!Array.isArray(item)) result.push(item);
    for (const child of Object.values(item)) {
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(value);
  return result;
}

function normalizeDouyinUrl(value, id) {
  const raw = stringValue(value);
  if (/^https?:\/\//i.test(raw)) return raw;
  if (id) return canonicalPostUrl(id);
  if (/^(www\.)?douyin\.com(\/|$)/i.test(raw)) return `https://${raw}`;
  return raw;
}

function canonicalPostUrl(id) {
  return `https://www.douyin.com/video/${encodeURIComponent(id || "unknown")}`;
}

function extractFirstUrl(text) {
  return /https?:\/\/[^\s，。！？、)）"'<>]+/i.exec(text)?.[0] || "";
}

function extractAwemeId(value) {
  const text = stringValue(value);
  return (
    /\/video\/(\d+)/i.exec(text)?.[1] ||
    /[?&](?:modal_id|aweme_id|item_id|vid)=(\d+)/i.exec(text)?.[1] ||
    /\/note\/(\d+)/i.exec(text)?.[1] ||
    (/^\d{10,}$/.test(text) ? text : "")
  );
}

function stringValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function numberValue(value) {
  const numeric = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : undefined;
}

function dateFromSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return new Date(numeric * 1000).toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function detectChromeVersion() {
  const fallback = process.env.DOUYIN_BROWSER_FULL_VERSION || process.env.BROWSER_FULL_VERSION || "137.0.0.0";
  try {
    const output = execFileSync(process.env.GOOGLE_CHROME_BIN || "/usr/bin/google-chrome-stable", ["--version"], {
      encoding: "utf8",
      timeout: 2_000
    });
    const version = output.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] || fallback;
    return { full: version, major: version.split(".")[0] || "137" };
  } catch {
    return { full: fallback, major: fallback.split(".")[0] || "137" };
  }
}
