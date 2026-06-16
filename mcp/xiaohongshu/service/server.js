import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const SERVICE_LOG_LIMIT = normalizePositiveEnv("XHS_SERVICE_LOG_LIMIT", 600);
let serviceLogSeq = 0;
const serviceLogs = [];

let stealthPluginReady = false;
try {
  chromium.use(StealthPlugin());
  stealthPluginReady = true;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  serviceLog("warn", "stealth", `Stealth plugin unavailable; using custom fingerprint fallback only: ${message}`);
}

const PORT = Number(process.env.PORT || 18060);
const BROWSER_RUNTIME_URL =
  process.env.XHS_BROWSER_RUNTIME_URL ||
  process.env.BROWSER_WORKER_RUNTIME_URL ||
  process.env.BROWSER_RUNTIME_URL ||
  `http://127.0.0.1:${process.env.BROWSER_RUNTIME_PORT || process.env.XHS_BROWSER_RUNTIME_PORT || 18101}`;
const VIEWER_RUNTIME_URL =
  process.env.XHS_VIEWER_RUNTIME_URL ||
  process.env.BROWSER_VIEWER_RUNTIME_URL ||
  "http://127.0.0.1:18100";
const INTERNAL_CDP_PORT = Number(process.env.XHS_INTERNAL_CDP_PORT || process.env.BROWSER_CDP_PORT || process.env.XHS_CDP_PORT || 9224);
const PROFILE_DIR = process.env.XHS_PROFILE_DIR || "/app/data/profile";
const COOKIES_PATH = process.env.COOKIES_PATH || "/app/data/cookies.json";
const COOKIE_FALLBACK_PATHS = uniquePaths([
  COOKIES_PATH,
  "/app/mcp/xiaohongshu/data/cookies.json",
  "/app/data/cookies.json"
]);
const CDP_CONNECT_TIMEOUT_MS = normalizePositiveEnv("XHS_CDP_CONNECT_TIMEOUT_MS", 30_000);
const BROWSER_STATUS_TIMEOUT_MS = normalizePositiveEnv("XHS_BROWSER_STATUS_TIMEOUT_MS", 2_000);
const BROWSER_RESTART_TIMEOUT_MS = normalizePositiveEnv("XHS_BROWSER_RESTART_TIMEOUT_MS", 120_000);
const BROWSER_RUNTIME_TIMEOUT_MS = normalizePositiveEnv("XHS_BROWSER_RUNTIME_TIMEOUT_MS", 30_000);
const HEALTH_ENSURE_TIMEOUT_MS = normalizePositiveEnv("XHS_HEALTH_ENSURE_TIMEOUT_MS", 20_000);
const CDP_CONNECT_ATTEMPTS = normalizePositiveEnv("XHS_CDP_CONNECT_ATTEMPTS", 3);
const BROWSER_TASK_TIMEOUT_MS = normalizePositiveEnv("XHS_BROWSER_TASK_TIMEOUT_MS", 180_000);
const HUMAN_DELAY_ENABLED = process.env.XHS_HUMAN_DELAY_ENABLED !== "0";
const BROWSER_TASK_DELAY_MIN_MS = normalizeNonNegativeEnv("XHS_BROWSER_TASK_DELAY_MIN_MS", 900);
const BROWSER_TASK_DELAY_MAX_MS = normalizeDelayMax("XHS_BROWSER_TASK_DELAY_MAX_MS", 2_800, BROWSER_TASK_DELAY_MIN_MS);
const BROWSER_ACTION_DELAY_MIN_MS = normalizeNonNegativeEnv("XHS_BROWSER_ACTION_DELAY_MIN_MS", 260);
const BROWSER_ACTION_DELAY_MAX_MS = normalizeDelayMax("XHS_BROWSER_ACTION_DELAY_MAX_MS", 1_100, BROWSER_ACTION_DELAY_MIN_MS);
const BROWSER_TYPE_DELAY_MIN_MS = normalizeNonNegativeEnv("XHS_BROWSER_TYPE_DELAY_MIN_MS", 45);
const BROWSER_TYPE_DELAY_MAX_MS = normalizeDelayMax("XHS_BROWSER_TYPE_DELAY_MAX_MS", 135, BROWSER_TYPE_DELAY_MIN_MS);
const STEALTH_PLUGIN_READY = stealthPluginReady;
const BROWSER_VERSION = detectChromeVersion();
const BROWSER_MAJOR_VERSION = process.env.XHS_BROWSER_MAJOR_VERSION || BROWSER_VERSION.major;
const WINDOWS_USER_AGENT =
  process.env.XHS_BROWSER_USER_AGENT ||
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION.full} Safari/537.36`;
const WINDOWS_ACCEPT_LANGUAGE = process.env.XHS_BROWSER_ACCEPT_LANGUAGE || "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7";
const WINDOWS_NAVIGATOR_PLATFORM = process.env.XHS_NAVIGATOR_PLATFORM || "Win32";
const WINDOWS_PLATFORM_VERSION = process.env.XHS_BROWSER_PLATFORM_VERSION || "10.0.0";
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
const XHS_HOME_URL = "https://www.xiaohongshu.com/explore";
const XHS_CREATOR_URL = "https://creator.xiaohongshu.com";
const XHS_COOKIE_DOMAINS = [".xiaohongshu.com", "xiaohongshu.com", ".xhslink.com", "xhslink.com", ".xhscdn.com"];

let contextPromise;
let servicePagePromise;
let viewerPagePromise;
let restartPromise;
let browserTaskTail = Promise.resolve();
let browserTaskSeq = 0;
let browserTaskPending = 0;
let browserTaskActive = null;
let browserPriorityPromise;
let cookiePersistTimer;
const postTokenCache = new Map();

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
  const line = `[${entry.time}] [${entry.source}] ${entry.level.toUpperCase()} ${entry.message}${suffix}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function serviceLogsSince(since, limit) {
  const cursor = Number.isFinite(Number(since)) ? Math.max(0, Math.floor(Number(since))) : 0;
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.floor(Number(limit)))) : 200;
  return serviceLogs.filter((entry) => entry.seq > cursor).slice(-max);
}

function sanitizeLogText(value) {
  return String(value || "")
    .replace(/(xsec_token|xsecToken)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/("?(?:xsec_token|xsecToken)"?\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .slice(0, 1000);
}

function sanitizeLogDetails(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === "string") return sanitizeLogText(item);
      return item;
    }));
  } catch {
    return sanitizeLogText(value);
  }
}

function captureProcessLog(source, level, chunk) {
  String(chunk || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => serviceLog(level, source, line));
}

function safeLogUrl(value) {
  const text = String(value || "");
  try {
    const url = new URL(text);
    for (const key of ["xsec_token", "xsecToken"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString().slice(0, 600);
  } catch {
    return sanitizeLogText(text).slice(0, 600);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const requestSignal = createRequestAbortSignal(req, res);

    if (req.method === "GET" && url.pathname === "/api/v1/browser/logs") {
      const since = Number(url.searchParams.get("since") || 0);
      const limit = Number(url.searchParams.get("limit") || 200);
      sendJson(res, 200, {
        success: true,
        data: {
          logs: serviceLogsSince(since, limit),
          cursor: serviceLogSeq
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const ensure = url.searchParams.get("ensure") === "1";
      const browser = await healthBrowserSummary({ ensure });
      const ok = ensure ? browser.running === true : true;
      sendJson(res, ok ? 200 : 503, { ok, service: "kato-xhs-browser", browser });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/login/status") {
      const data = await enqueueBrowserTask("login:status", (taskContext) => loginStatus(taskContext), { signal: requestSignal });
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/login/qrcode") {
      serviceLog("info", "browser", "Open login/browser viewer requested.");
      await enqueueBrowserTask("login:qrcode", (taskContext) => openLoginPage(taskContext), { signal: requestSignal });
      sendJson(res, 200, { success: true, data: { opened: true, loginUrl: XHS_HOME_URL, viewer: "novnc" } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/restart") {
      const body = await readJson(req);
      serviceLog("warn", "browser", "Browser restart requested.", { reason: body.reason || "manual" });
      const data = await priorityRestartBrowser(`priority:${String(body.reason || "manual")}`);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/browser/status") {
      sendJson(res, 200, { success: true, data: await browserSummary() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/sync-cookies") {
      const cookies = await exportViewerCookies(XHS_COOKIE_DOMAINS);
      await persistCookies(cookies, "manual-sync");
      const context = contextPromise ? await contextPromise.catch(() => undefined) : undefined;
      if (context && cookies.length) await context.addCookies(cookies).catch(() => undefined);
      const exportedCookies = cookies.length;
      serviceLog("info", "cookies", "Browser cookies synced manually.", { exportedCookies });
      sendJson(res, 200, { success: true, data: { cookiesPath: COOKIES_PATH, exportedCookies } });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/user/me") {
      const data = await enqueueBrowserTask("user:me", (taskContext) => currentUserSummary(taskContext), { signal: requestSignal });
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/feeds/search") {
      const keyword = url.searchParams.get("keyword") || url.searchParams.get("query") || "";
      const limit = normalizeLimit(url.searchParams.get("limit"), 20);
      const page = normalizePositiveInt(url.searchParams.get("page"), 1);
      const feeds = await enqueueBrowserTask("feeds:search", (taskContext) => searchFeeds(keyword, limit, { page, taskContext }), { signal: requestSignal });
      sendJson(res, 200, { success: true, data: pagedPayload("feeds", feeds, { page, limit }) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/search") {
      const body = await readJson(req);
      const keyword = String(body.keyword || body.query || "");
      const limit = normalizeLimit(body.limit, 20);
      const page = normalizePositiveInt(body.page, 1);
      const feeds = await enqueueBrowserTask("feeds:search", (taskContext) => searchFeeds(keyword, limit, { page, taskContext }), { signal: requestSignal });
      sendJson(res, 200, { success: true, data: pagedPayload("feeds", feeds, { page, limit }) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/detail") {
      const body = await readJson(req);
      const post = await enqueueBrowserTask("feeds:detail", (taskContext) => getFeedDetail(body, taskContext), { signal: requestSignal });
      sendJson(res, 200, { success: true, data: { note: toNotePayload(post), feeds: [post] } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/comments") {
      const body = await readJson(req);
      const limit = normalizeLimit(body.limit || body.max_comments || body.max_comment_items, 50);
      const index = normalizeCursorIndex(body.index, body.cursor, 0);
      const comments = await enqueueBrowserTask("feeds:comments", (taskContext) => getFeedComments(body, limit, { index, taskContext }), {
        signal: requestSignal
      });
      sendJson(res, 200, {
        success: true,
        data: {
          comments,
          items: comments,
          cursor: {
            cursor: comments.length ? `offset:${index + 1}` : "",
            index: index + 1,
            pageArea: body.pageArea || body.page_area || "UNFOLDED"
          },
          has_more: comments.length >= limit
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/comment") {
      const body = await readJson(req);
      await enqueueBrowserTask("feeds:comment", (taskContext) => postComment(body, taskContext), { signal: requestSignal });
      sendJson(res, 200, { success: true, data: { posted: true } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/like") {
      const body = await readJson(req);
      await enqueueBrowserTask("feeds:like", (taskContext) => likeFeed(body, taskContext), { signal: requestSignal });
      sendJson(res, 200, { success: true, data: { liked: body.unlike === true ? false : true } });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"))) {
      await handleMcp(req, res);
      return;
    }

    sendJson(res, 404, { success: false, error: { code: "NOT_FOUND", message: "Endpoint not found." } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BrowserTaskCancelledError) {
      serviceLog("warn", "request", `${req.method || "GET"} ${req.url || "/"} cancelled: ${message}`);
      sendJson(res, 499, { success: false, error: { code: "CLIENT_CLOSED_REQUEST", message } });
      return;
    }
    serviceLog("error", "request", `${req.method || "GET"} ${req.url || "/"} failed: ${message}`);
    sendJson(res, 500, { success: false, error: { code: "INTERNAL_ERROR", message } });
  }
});

server.listen(PORT, () => {
  serviceLog("info", "service", `kato-xhs-browser listening on http://0.0.0.0:${PORT}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  try {
    const context = contextPromise ? await contextPromise : undefined;
    if (context) await persistContextCookies(context, "shutdown").catch(() => undefined);
    await context?.browser()?.close().catch(() => undefined);
  } finally {
    stopCookieAutoPersist();
    process.exit(0);
  }
}

async function browserSummary() {
  const runtime = await runtimeBrowserSummary().catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
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
      error: error instanceof Error ? error.message : String(error)
    };
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
      error: error instanceof Error ? error.message : String(error)
    };
  }
  return browserSummary();
}

function stealthSummary() {
  return {
    plugin: STEALTH_PLUGIN_READY,
    customFingerprint: true,
    platform: "Windows",
    cdp: "internal-loopback"
  };
}

async function ensureContext() {
  if (!contextPromise) {
    contextPromise = launchContext().catch((error) => {
      contextPromise = undefined;
      servicePagePromise = undefined;
      viewerPagePromise = undefined;
      throw error;
    });
  }
  return contextPromise;
}

function enqueueBrowserTask(label, task, options = {}) {
  const id = ++browserTaskSeq;
  const timeoutMs = normalizePositiveInt(options.timeoutMs, BROWSER_TASK_TIMEOUT_MS);
  const queuedAt = Date.now();
  const taskContext = createBrowserTaskContext(id, label, options.signal);
  browserTaskPending += 1;

  const run = async () => {
    let removedFromPending = false;
    const removeFromPending = () => {
      if (removedFromPending) return;
      browserTaskPending = Math.max(0, browserTaskPending - 1);
      removedFromPending = true;
    };
    let markCancelled;
    try {
      if (browserPriorityPromise) await waitForAbortable(browserPriorityPromise.catch(() => undefined), taskContext);
      removeFromPending();
      taskContext.throwIfCancelled();
      browserTaskActive = { id, label, startedAt: new Date().toISOString(), cancelled: false };
      markCancelled = () => {
        if (browserTaskActive?.id !== id) return;
        browserTaskActive.cancelled = true;
        browserTaskActive.cancelReason = abortReasonMessage(taskContext.signal);
        serviceLog("warn", "queue", `Browser task #${id} cancelled: ${label}.`, {
          reason: browserTaskActive.cancelReason
        });
      };
      taskContext.signal.addEventListener("abort", markCancelled, { once: true });
      const waitedMs = Date.now() - queuedAt;
      serviceLog("info", "queue", `Browser task #${id} started: ${label}.`, { waitedMs, pending: browserTaskPending });
      const jitterMs = await humanDelay(`task:${label}`, BROWSER_TASK_DELAY_MIN_MS, BROWSER_TASK_DELAY_MAX_MS, {
        log: true,
        signal: taskContext.signal
      });
      if (jitterMs > 0 && browserTaskActive?.id === id) browserTaskActive.delayMs = jitterMs;
      const lease = await acquireRuntimeLease(label, timeoutMs, taskContext);
      taskContext.leaseId = lease.leaseId;
      if (browserTaskActive?.id === id) browserTaskActive.leaseId = lease.leaseId;
      return await runBrowserTaskWithTimeout(label, task, timeoutMs, taskContext);
    } finally {
      removeFromPending();
      const activeMs = browserTaskActive?.id === id ? Date.now() - Date.parse(browserTaskActive.startedAt) : 0;
      if (browserTaskActive?.id === id) {
        serviceLog("info", "queue", `Browser task #${id} finished: ${label}.`, { activeMs, pending: browserTaskPending });
        if (markCancelled) taskContext.signal.removeEventListener("abort", markCancelled);
        browserTaskActive = null;
      }
      await closeTaskServicePage(taskContext, "task finished").catch(() => undefined);
      await releaseRuntimeLease(taskContext.leaseId).catch(() => undefined);
    }
  };

  const result = browserTaskTail.then(run, run);
  browserTaskTail = result.catch(() => undefined);
  return result;
}

function priorityRestartBrowser(reason) {
  if (!browserPriorityPromise) {
    browserPriorityPromise = restartBrowser(reason).finally(() => {
      browserPriorityPromise = undefined;
    });
  }
  return browserPriorityPromise;
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
    timer = setTimeout(() => {
      taskContext.abort(new BrowserTaskTimeoutError(`Browser task ${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
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
  servicePagePromise = undefined;
  viewerPagePromise = undefined;
  stopCookieAutoPersist();

  if (oldContextPromise) {
    const context = await withTimeout(oldContextPromise, 1_500, "Timed-out browser context close timed out.").catch(() => undefined);
    await withTimeout(context?.browser()?.close(), 1_500, "Timed-out browser close timed out.").catch(() => undefined);
  }

  await requestRuntimeRestart(`task timeout: ${label}`, taskContext?.leaseId);
}

function createBrowserTaskContext(id, label, externalSignal) {
  const controller = new AbortController();
  const context = {
    id,
    label,
    signal: controller.signal,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw taskAbortReason(controller.signal);
    }
  };

  if (externalSignal) {
    const abortFromExternal = () => {
      context.abort(taskAbortReason(externalSignal, `Browser task ${label} cancelled because client disconnected.`));
    };
    if (externalSignal.aborted) abortFromExternal();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  return context;
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

async function waitForAbortable(promise, taskContext) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      if (taskContext.signal.aborted) {
        reject(taskAbortReason(taskContext.signal));
        return;
      }
      taskContext.signal.addEventListener("abort", () => reject(taskAbortReason(taskContext.signal)), { once: true });
    })
  ]);
}

function browserQueueSummary() {
  return {
    pending: browserTaskPending,
    active: browserTaskActive
  };
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
    startCookieAutoPersist(context);
    context.on("page", (page) => {
      page.setDefaultTimeout(30_000);
      applyPageFingerprint(page).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        serviceLog("warn", "stealth", `Page fingerprint apply failed: ${message}`);
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
  await context.setExtraHTTPHeaders({
    "Accept-Language": WINDOWS_ACCEPT_LANGUAGE
  }).catch(() => undefined);
  await context.addInitScript(
    ({ userAgent, platform, platformVersion, brands, fullVersionList, languages }) => {
      const defineGetter = (target, key, value) => {
        try {
          Object.defineProperty(target, key, { get: () => value, configurable: true });
        } catch {
          // Some browser-owned properties may be non-configurable in older builds.
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
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    serviceLog("warn", "stealth", `Context fingerprint init script failed: ${message}`);
  });

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

async function servicePage(taskContext) {
  taskContext?.throwIfCancelled?.();
  const context = await ensureContext();
  if (taskContext) {
    if (!taskContext.servicePagePromise) {
      taskContext.servicePagePromise = createServicePage(context, taskContext);
    }
    const page = await taskContext.servicePagePromise;
    if (page.isClosed()) {
      taskContext.servicePagePromise = undefined;
      taskContext.servicePage = undefined;
      return servicePage(taskContext);
    }
    await ensurePageUsable(page, taskContext);
    bindTaskPage(taskContext, page);
    return page;
  }
  if (!servicePagePromise) {
    servicePagePromise = createServicePage(context);
  }
  const page = await servicePagePromise;
  if (page.isClosed()) {
    servicePagePromise = undefined;
    return servicePage(taskContext);
  }
  await ensurePageUsable(page);
  return page;
}

async function createServicePage(context, taskContext) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("crash", () => {
    serviceLog("error", "browser", "Service page crashed; it will be discarded before the next browser action.", {
      task: taskContext ? `#${taskContext.id}:${taskContext.label}` : "warmup",
      url: safeLogUrl(page.url())
    });
    discardServicePage(page, taskContext);
  });
  page.on("close", () => discardServicePage(page, taskContext));
  await applyPageFingerprint(page).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    serviceLog("warn", "stealth", `Service page fingerprint apply failed: ${message}`);
  });
  if (taskContext) taskContext.servicePage = page;
  return page;
}

async function viewerPage(taskContext) {
  taskContext?.throwIfCancelled?.();
  const context = await ensureContext();
  if (!viewerPagePromise) {
    viewerPagePromise = createViewerPage(context);
  }
  const page = await viewerPagePromise;
  if (page.isClosed()) {
    viewerPagePromise = undefined;
    return viewerPage(taskContext);
  }
  try {
    await ensurePageUsable(page);
  } catch (error) {
    discardViewerPage(page);
    throw error;
  }
  return page;
}

async function createViewerPage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("crash", () => {
    serviceLog("error", "browser", "Viewer page crashed; it will be recreated on the next browser open.", {
      url: safeLogUrl(page.url())
    });
    discardViewerPage(page);
  });
  page.on("close", () => discardViewerPage(page));
  await applyPageFingerprint(page).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    serviceLog("warn", "stealth", `Viewer page fingerprint apply failed: ${message}`);
  });
  return page;
}

async function ensurePageUsable(page, taskContext) {
  if (page.isClosed()) throw new Error("Service page is closed.");
  try {
    await page.evaluate(() => document.readyState).catch((error) => {
      throw error;
    });
  } catch (error) {
    discardServicePage(page, taskContext);
    throw error;
  }
}

function discardServicePage(page, taskContext) {
  if (taskContext?.servicePage === page) {
    taskContext.servicePage = undefined;
    taskContext.servicePagePromise = undefined;
    taskContext.pageAbortBound = false;
  }
  if (servicePagePromise) {
    const currentPromise = servicePagePromise;
    currentPromise.then((current) => {
      if (current === page && servicePagePromise === currentPromise) servicePagePromise = undefined;
    }).catch(() => {
      if (servicePagePromise === currentPromise) servicePagePromise = undefined;
    });
  }
}

function discardViewerPage(page) {
  if (!viewerPagePromise) return;
  const currentPromise = viewerPagePromise;
  currentPromise.then((current) => {
    if (current === page && viewerPagePromise === currentPromise) viewerPagePromise = undefined;
  }).catch(() => {
    if (viewerPagePromise === currentPromise) viewerPagePromise = undefined;
  });
}

function bindTaskPage(taskContext, page) {
  if (!taskContext?.signal) return;
  if (taskContext.signal.aborted) {
    closeCancelledTaskPage(taskContext, page);
    throw taskAbortReason(taskContext.signal);
  }
  if (taskContext.pageAbortBound && taskContext.servicePage === page) return;
  const closePage = () => closeCancelledTaskPage(taskContext, page);
  taskContext.signal.addEventListener("abort", closePage, { once: true });
  taskContext.pageAbortBound = true;
}

function closeCancelledTaskPage(taskContext, page) {
  if (!page || page.isClosed()) return;
  serviceLog("warn", "queue", `Closing active page for cancelled task #${taskContext.id}: ${taskContext.label}.`, {
    reason: abortReasonMessage(taskContext.signal)
  });
  if (servicePagePromise) servicePagePromise = undefined;
  if (taskContext) {
    taskContext.servicePage = undefined;
    taskContext.servicePagePromise = undefined;
    taskContext.pageAbortBound = false;
  }
  page.close({ runBeforeUnload: false }).catch(() => undefined);
}

async function closeTaskServicePage(taskContext, reason) {
  if (!taskContext || taskContext.keepServicePage) return;
  const page = taskContext.servicePagePromise ? await taskContext.servicePagePromise.catch(() => undefined) : taskContext.servicePage;
  taskContext.servicePage = undefined;
  taskContext.servicePagePromise = undefined;
  taskContext.pageAbortBound = false;
  if (!page || page.isClosed()) return;
  serviceLog("info", "queue", `Closing task service page after ${reason}.`, {
    task: `#${taskContext.id}:${taskContext.label}`,
    url: safeLogUrl(page.url())
  });
  await page.close({ runBeforeUnload: false }).catch(() => undefined);
}

async function restartBrowser(reason = "manual", taskContext) {
  if (restartPromise) return restartPromise;
  restartPromise = withTimeout((async () => {
    serviceLog("warn", "browser", `Restarting runtime browser: ${reason}`);
    const oldContextPromise = contextPromise;
    contextPromise = undefined;
    servicePagePromise = undefined;
    viewerPagePromise = undefined;
    stopCookieAutoPersist();

    if (oldContextPromise) {
      const context = await withTimeout(oldContextPromise, 1_500, "Old browser context close timed out.").catch(() => undefined);
      if (context) await persistContextCookies(context, "restart").catch(() => undefined);
      await withTimeout(context?.browser()?.close(), 1_500, "Old browser close timed out.").catch(() => undefined);
    }

    await requestRuntimeRestart(reason, taskContext?.leaseId);
    await ensureContext();
    await warmServicePage();
    return {
      restarted: true,
      reason,
      browser: await browserSummary()
    };
  })(), BROWSER_RESTART_TIMEOUT_MS, "Browser restart timed out.").finally(() => {
    restartPromise = undefined;
  });
  return restartPromise;
}

async function withBrowserRecovery(label, task, taskContext) {
  try {
    taskContext?.throwIfCancelled?.();
    return await task();
  } catch (error) {
    if (error instanceof BrowserTaskCancelledError || error instanceof BrowserTaskTimeoutError) throw error;
    if (!isRecoverableBrowserError(error)) throw error;
    taskContext?.throwIfCancelled?.();
    const message = error instanceof Error ? error.message : String(error);
    serviceLog("warn", "browser", `Recoverable browser error in ${label}; restarting.`, { error: message.slice(0, 240) });
    await restartBrowser(`${label}: ${message.slice(0, 240)}`, taskContext);
    taskContext?.throwIfCancelled?.();
    return task();
  }
}

function isRecoverableBrowserError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Page crashed|Page\.getLayoutMetrics|Target closed|Browser has been closed|Execution context was destroyed|Protocol error|connectOverCDP|CDP|timed out/i.test(
    message
  );
}

async function openLoginPage(taskContext) {
  return withBrowserRecovery("openLoginPage", async () => {
    const page = await viewerPage(taskContext);
    taskContext?.throwIfCancelled?.();
    await page.goto(XHS_HOME_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    taskContext?.throwIfCancelled?.();
    await page.bringToFront().catch(() => undefined);
  }, taskContext);
}

async function warmServicePage() {
  const context = await ensureContext();
  const page = await createServicePage(context);
  try {
    await ensurePageUsable(page);
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
  }
}

async function loginStatus(taskContext) {
  return withBrowserRecovery("loginStatus", async () => {
    taskContext?.throwIfCancelled?.();
    const context = await ensureContext();
    const cookies = await context.cookies();
    const xhsCookies = cookies.filter((cookie) => /xiaohongshu|xhs|rednote/i.test(cookie.domain));
    if (xhsCookies.length) await persistCookies(xhsCookies, "loginStatus");
    return {
      is_logged_in: xhsCookies.some((cookie) => ["web_session", "id_token"].includes(cookie.name) && cookie.value),
      username: await readVisibleUsername(taskContext).catch(() => ""),
      cookie_count: xhsCookies.length
    };
  }, taskContext);
}

async function currentUserSummary(taskContext) {
  const status = await loginStatus(taskContext);
  return {
    userBasicInfo: { nickname: status.username || "" },
    feeds: []
  };
}

async function searchFeeds(keyword, limit, options = {}) {
  const taskContext = options.taskContext;
  return withBrowserRecovery("searchFeeds", async () => {
    if (!keyword.trim()) return [];
    const pageNumber = normalizePositiveInt(options.page, 1);
    serviceLog("info", "feeds", "Search feeds requested.", { keyword, limit, page: pageNumber });
    const page = await servicePage(taskContext);
    const capture = startPostResponseCapture(page);
    const url = new URL("https://www.xiaohongshu.com/search_result");
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("source", "web_search_result_notes");
    let capturedPosts = [];
    try {
      taskContext?.throwIfCancelled?.();
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await humanDelay("search:settle", 2_400, 5_200, { signal: taskContext?.signal });
      await autoScroll(page, Math.max(2, pageNumber + 1), taskContext);
    } finally {
      capturedPosts = await capture.stop();
    }
    taskContext?.throwIfCancelled?.();
    const posts = [...capturedPosts, ...(await scrapePosts(page))];
    const start = (pageNumber - 1) * limit;
    const unique = uniquePosts(posts);
    rememberPosts(unique);
    const result = unique.slice(start, start + limit);
    serviceLog("info", "feeds", "Search feeds completed.", {
      keyword,
      page: pageNumber,
      captured: capturedPosts.length,
      scraped: unique.length,
      returned: result.length,
      currentUrl: safeLogUrl(page.url())
    });
    return result;
  }, taskContext);
}

async function getFeedDetail(body, taskContext) {
  return withBrowserRecovery("getFeedDetail", async () => {
    const { id, xsecToken, url } = normalizeDetailInput(body);
    if (!url && !id) throw new Error("feed_id or url is required.");
    if (isTokenRequiredForDetailUrl(url) && !xsecToken) {
      throw new Error(`xsec_token is required for XHS note detail: ${id || url}`);
    }
    serviceLog("info", "detail", "Note detail requested.", {
      id,
      hasXsecToken: Boolean(xsecToken),
      url: safeLogUrl(url)
    });
    const page = await servicePage(taskContext);
    taskContext?.throwIfCancelled?.();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await humanDelay("detail:settle", 2_100, 5_000, { signal: taskContext?.signal });
    taskContext?.throwIfCancelled?.();
    const detail = await page.evaluate(() => {
      const pick = (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const text = node?.textContent?.trim();
          if (text) return text;
        }
        return "";
      };
      const meta = (name) =>
        document.querySelector(`meta[property="${name}"]`)?.getAttribute("content") ||
        document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ||
        "";
      return {
        title: pick(["#detail-title", ".title", "[class*=title]"]) || meta("og:title") || document.title,
        snippet:
          pick(["#detail-desc", ".desc", "[class*=desc]", "[class*=content]"]) ||
          meta("description") ||
          meta("og:description"),
        author: pick([".author .name", "[class*=author] [class*=name]", "[class*=nickname]"]),
        text: document.body?.innerText?.slice(0, 2000) || ""
      };
    });
    const parsed = postFromUrl(url);
    const finalUrl = page.url();
    const looksBlockedOrMissing =
      /\/404(?:\?|$)/.test(finalUrl) ||
      /当前笔记暂时无法浏览|你访问的页面不见了|扫码查看|error_code=300031/.test(detail.text || "");
    serviceLog(looksBlockedOrMissing ? "warn" : "info", "detail", "Note detail page loaded.", {
      id: id || parsed.id,
      status: response?.status?.(),
      finalUrl: safeLogUrl(finalUrl),
      title: cleanTitle(detail.title),
      blockedOrMissing: looksBlockedOrMissing
    });
    const result = {
      id: id || parsed.id,
      xsecToken: xsecToken || parsed.xsecToken,
      url,
      title: cleanTitle(detail.title),
      snippet: cleanSnippet(detail.snippet || detail.text),
      author: detail.author || undefined
    };
    rememberPosts([result]);
    return result;
  }, taskContext);
}

async function postComment(body, taskContext) {
  const content = String(body.content || body.comment || "").trim();
  if (!content) throw new Error("content is required.");
  const post = await getFeedDetail(body, taskContext);
  const page = await servicePage(taskContext);
  await focusCommentEditor(page, taskContext);
  await humanDelay("comment:before-type", 450, 1_400, { signal: taskContext?.signal });
  await humanType(page, content, taskContext);
  await humanDelay("comment:before-submit", 700, 1_900, { signal: taskContext?.signal });
  const clicked = await clickFirstVisible(page, [
    "button:has-text('发送')",
    "button:has-text('发布')",
    "button:has-text('评论')",
    ".submit",
    "[class*=submit]"
  ], taskContext);
  if (!clicked) throw new Error(`Cannot find comment submit button for ${post.id}.`);
}

async function likeFeed(body, taskContext) {
  const post = await getFeedDetail(body, taskContext);
  const page = await servicePage(taskContext);
  await humanDelay("like:before-click", 550, 1_600, { signal: taskContext?.signal });
  const clicked = await clickFirstVisible(page, [
    "[aria-label*='点赞']",
    "button:has-text('点赞')",
    "[class*=like]",
    "[class*=interact] button"
  ], taskContext);
  if (!clicked) throw new Error(`Cannot find like button for ${post.id}.`);
}

async function handleMcp(req, res) {
  const requestSignal = createRequestAbortSignal(req, res);
  const payload = await readJson(req);
  if (!payload.id && payload.method?.startsWith("notifications/")) {
    sendJson(res, 202, {});
    return;
  }

  try {
    if (payload.method === "initialize") {
      sendMcpResult(res, payload.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "kato-xhs-browser", version: "0.1.0" }
      });
      return;
    }

    if (payload.method === "tools/list") {
      sendMcpResult(res, payload.id, { tools: toolList() });
      return;
    }

    if (payload.method === "tools/call") {
      const toolName = String(payload.params?.name || "unknown");
      const result = await enqueueBrowserTask(`mcp:${toolName}`, (taskContext) => callTool(payload.params || {}, taskContext), {
        signal: requestSignal
      });
      sendMcpResult(res, payload.id, result);
      return;
    }

    sendMcpError(res, payload.id, -32601, `Method not found: ${payload.method}`);
  } catch (error) {
    sendMcpError(res, payload.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

async function callTool(params, taskContext) {
  const name = String(params.name || "");
  const args = params.arguments || {};
  if (name === "search_feeds") {
    const limit = normalizeLimit(args.limit, 20);
    const page = normalizePositiveInt(args.page, 1);
    const feeds = await searchFeeds(String(args.keyword || args.query || ""), limit, { page, taskContext });
    return toolJson(pagedPayload("feeds", feeds, { page, limit }));
  }
  if (name === "get_feed_detail") {
    return toolJson(await getFeedDetail(args, taskContext));
  }
  if (name === "get_feed_comments") {
    const limit = normalizeLimit(args.limit || args.max_comments || args.max_comment_items, 50);
    const index = normalizeCursorIndex(args.index, args.cursor, 0);
    const comments = await getFeedComments(args, limit, { index, taskContext });
    return toolJson({
      comments,
      items: comments,
      cursor: { cursor: comments.length ? `offset:${index + 1}` : "", index: index + 1, pageArea: args.pageArea || "UNFOLDED" },
      has_more: comments.length >= limit
    });
  }
  if (name === "post_comment_to_feed") {
    await postComment(args, taskContext);
    return toolJson({ posted: true });
  }
  if (name === "like_feed") {
    await likeFeed(args, taskContext);
    return toolJson({ liked: args.unlike === true ? false : true });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function toolList() {
  return [
    { name: "search_feeds", description: "Search Xiaohongshu posts", inputSchema: { type: "object" } },
    { name: "get_feed_detail", description: "Read a Xiaohongshu post detail", inputSchema: { type: "object" } },
    { name: "get_feed_comments", description: "Read Xiaohongshu post comments", inputSchema: { type: "object" } },
    { name: "post_comment_to_feed", description: "Post a confirmed comment", inputSchema: { type: "object" } },
    { name: "like_feed", description: "Like a confirmed post", inputSchema: { type: "object" } }
  ];
}

function toolJson(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }]
  };
}

async function focusCommentEditor(page, taskContext) {
  const selectors = [
    "textarea",
    "[contenteditable='true']",
    "[role='textbox']",
    "input[placeholder*='评论']",
    "[placeholder*='评论']"
  ];
  for (const selector of selectors) {
    taskContext?.throwIfCancelled?.();
    const locator = page.locator(selector).last();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await humanDelay("focus:comment-editor", BROWSER_ACTION_DELAY_MIN_MS, BROWSER_ACTION_DELAY_MAX_MS, {
        signal: taskContext?.signal
      });
      await locator.click();
      return;
    }
  }
  throw new Error("Cannot find comment editor.");
}

async function clickFirstVisible(page, selectors, taskContext) {
  for (const selector of selectors) {
    taskContext?.throwIfCancelled?.();
    const locator = page.locator(selector).last();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await humanDelay("click:visible", BROWSER_ACTION_DELAY_MIN_MS, BROWSER_ACTION_DELAY_MAX_MS, {
        signal: taskContext?.signal
      });
      await locator.click({ timeout: 5_000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function scrapePosts(page) {
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="/explore/"]')];
    return anchors.map((anchor) => {
      const href = anchor.href;
      const card = anchor.closest("section, article, div") || anchor;
      const text = (card.textContent || anchor.textContent || "").replace(/\s+/g, " ").trim();
      let id = "";
      let xsecToken = "";
      try {
        const url = new URL(href);
        id = url.pathname.split("/").filter(Boolean).at(-1) || "";
        xsecToken = url.searchParams.get("xsec_token") || "";
      } catch {
        // ignore malformed links
      }
      return {
        id,
        xsecToken,
        url: href,
        title: text.slice(0, 80),
        snippet: text.slice(0, 240)
      };
    });
  });
}

async function getFeedComments(body, limit, options = {}) {
  const taskContext = options.taskContext;
  return withBrowserRecovery("getFeedComments", async () => {
    const detailInput = normalizeDetailInput(body);
    const index = normalizeCursorIndex(options.index, options.cursor, 0);
    serviceLog("info", "comments", "Note comments requested.", {
      id: detailInput.id,
      hasXsecToken: Boolean(detailInput.xsecToken),
      limit,
      index
    });
    await getFeedDetail(body, taskContext);
    const page = await servicePage(taskContext);
    await humanDelay("comments:before-scroll", 700, 1_800, { signal: taskContext?.signal });
    await autoScroll(page, Math.max(3, index + 3), taskContext);
    taskContext?.throwIfCancelled?.();
    const scraped = await scrapeComments(page);
    const comments = uniqueComments(scraped, limit, index * limit);
    serviceLog("info", "comments", "Note comments completed.", {
      id: detailInput.id,
      index,
      scraped: scraped.length,
      returned: comments.length,
      currentUrl: safeLogUrl(page.url())
    });
    return comments;
  }, taskContext);
}

function startPostResponseCapture(page) {
  const posts = [];
  const jobs = [];
  const handler = (response) => {
    const url = response.url();
    if (!isLikelyXhsJsonResponse(url)) return;
    const job = (async () => {
      try {
        const payload = await response.json();
        posts.push(...extractPostsFromPayload(payload));
      } catch {
        // Non-JSON or already-consumed responses are expected on some XHS resources.
      }
    })();
    jobs.push(job);
  };
  page.on("response", handler);
  return {
    async stop() {
      page.off("response", handler);
      await Promise.allSettled(jobs);
      return posts;
    }
  };
}

function isLikelyXhsJsonResponse(url) {
  return /xiaohongshu\.com|xhscdn\.com|edith\.xiaohongshu\.com/i.test(url) && /\/api\/|search|feed|note/i.test(url);
}

function extractPostsFromPayload(payload) {
  const result = [];
  const seen = new Set();
  walkPayload(payload, (item) => {
    const post = postFromPayloadItem(item);
    if (!post?.id || seen.has(post.id)) return;
    seen.add(post.id);
    result.push(post);
  });
  return result.slice(0, 300);
}

function walkPayload(value, visit, seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value)) visit(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) walkPayload(child, visit, seen, depth + 1);
}

function postFromPayloadItem(item) {
  const noteCard = objectValue(item.note_card) || objectValue(item.noteCard);
  const note = objectValue(item.note) || noteCard || item;
  const user = objectValue(note.user) || objectValue(item.user) || {};
  const interactInfo =
    objectValue(note.interact_info) ||
    objectValue(note.interactInfo) ||
    objectValue(item.interact_info) ||
    objectValue(item.interactInfo) ||
    {};
  const id = firstText(
    item.id,
    item.note_id,
    item.noteId,
    item.feed_id,
    item.feedId,
    note.note_id,
    note.noteId,
    note.id
  );
  const xsecToken = firstText(item.xsec_token, item.xsecToken, note.xsec_token, note.xsecToken);
  const title = firstText(
    item.title,
    item.display_title,
    item.displayTitle,
    note.title,
    note.display_title,
    note.displayTitle,
    noteCard?.display_title,
    noteCard?.displayTitle
  );
  const snippet = firstText(item.desc, item.description, item.content, note.desc, note.description, title);
  const url = normalizeXhsDetailUrl(firstText(item.url, item.link, note.url, note.link), id, xsecToken);
  if (!id || (!title && !snippet && !xsecToken)) return null;
  return {
    id,
    url,
    title: title || snippet || "小红书笔记",
    snippet: snippet || title || "",
    author: firstText(user.nickname, user.nickName, user.name, item.author),
    xsecToken: xsecToken || undefined,
    likeCount: toOptionalCount(interactInfo.liked_count ?? interactInfo.likedCount ?? interactInfo.like_count ?? interactInfo.likeCount),
    commentCount: toOptionalCount(interactInfo.comment_count ?? interactInfo.commentCount)
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function toOptionalCount(value) {
  const numberValue = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

async function scrapeComments(page) {
  return page.evaluate(() => {
    const selectors = [
      "[class*=comment-item]",
      "[class*=CommentItem]",
      "[class*=parent-comment]",
      "[class*=commentItem]",
      "[data-comment-id]"
    ];
    const nodes = [...document.querySelectorAll(selectors.join(","))];
    const fallbackNodes = nodes.length
      ? nodes
      : [...document.querySelectorAll("div, li")]
          .filter((node) => {
            const className = String(node.getAttribute("class") || "");
            const text = (node.textContent || "").replace(/\s+/g, " ").trim();
            return /comment|评论/i.test(className) && text.length >= 2 && text.length <= 500;
          })
          .slice(0, 100);

    return fallbackNodes.map((node, index) => {
      const text = pickCommentText(node);
      const author = pickAuthorText(node);
      const id =
        node.getAttribute("data-comment-id") ||
        node.getAttribute("data-id") ||
        node.id ||
        `comment-${index}-${hashText(`${author}:${text}`)}`;
      const parent = node.closest("[data-comment-id]")?.getAttribute("data-comment-id") || "";
      return {
        id,
        comment_id: id,
        content: text,
        text,
        author,
        author_name: author,
        parent_id: parent && parent !== id ? parent : ""
      };
    });

    function pickCommentText(node) {
      const candidates = [
        "[class*=content]",
        "[class*=Content]",
        "[class*=text]",
        "[class*=Text]",
        "[class*=desc]"
      ];
      for (const selector of candidates) {
        const text = [...node.querySelectorAll(selector)]
          .map((item) => item.textContent || "")
          .map((item) => item.replace(/\s+/g, " ").trim())
          .find((item) => item && item.length <= 500);
        if (text) return cleanCommentText(text);
      }
      return cleanCommentText((node.textContent || "").replace(/\s+/g, " ").trim());
    }

    function pickAuthorText(node) {
      const selectors = [
        "[class*=author]",
        "[class*=Author]",
        "[class*=nickname]",
        "[class*=Nickname]",
        "[class*=name]",
        "[class*=Name]"
      ];
      for (const selector of selectors) {
        const text = [...node.querySelectorAll(selector)]
          .map((item) => item.textContent || "")
          .map((item) => item.replace(/\s+/g, " ").trim())
          .find((item) => item && item.length <= 80);
        if (text) return text;
      }
      return "";
    }

    function cleanCommentText(value) {
      return String(value || "")
        .replace(/^(回复|评论)\s*/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1000);
    }

    function hashText(value) {
      let hash = 0;
      for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
      }
      return hash.toString(16);
    }
  });
}

function uniqueComments(comments, limit, offset = 0) {
  const seen = new Set();
  const result = [];
  let skipped = 0;
  for (const comment of comments) {
    const content = String(comment.content || comment.text || "").trim();
    if (!content) continue;
    const key = String(comment.id || comment.comment_id || content);
    if (seen.has(key)) continue;
    seen.add(key);
    if (skipped < offset) {
      skipped += 1;
      continue;
    }
    result.push({
      id: key,
      comment_id: key,
      content,
      text: content,
      author: comment.author || undefined,
      author_name: comment.author_name || comment.author || undefined,
      parent_id: comment.parent_id || undefined,
      parent_comment_id: comment.parent_id || undefined
    });
    if (result.length >= limit) break;
  }
  return result;
}

async function autoScroll(page, steps, taskContext) {
  for (let i = 0; i < steps; i += 1) {
    taskContext?.throwIfCancelled?.();
    await humanDelay("scroll:pre", 180, 620, { signal: taskContext?.signal });
    await page.mouse.wheel(randomBetween(-18, 18), randomBetween(520, 1_180)).catch(() => undefined);
    await humanDelay("scroll:settle", 650, 1_650, { signal: taskContext?.signal });
  }
}

async function humanType(page, content, taskContext) {
  taskContext?.throwIfCancelled?.();
  const delayMs = randomBetween(BROWSER_TYPE_DELAY_MIN_MS, BROWSER_TYPE_DELAY_MAX_MS);
  try {
    await page.keyboard.type(content, { delay: delayMs });
  } catch {
    await page.keyboard.insertText(content);
  }
}

function uniquePosts(posts) {
  const byId = new Map();
  const result = [];
  for (const post of posts) {
    if (!post.id || !post.url) continue;
    const normalizedUrl = normalizeXhsDetailUrl(post.url, post.id, post.xsecToken);
    const parsed = postFromUrl(normalizedUrl);
    const normalized = {
      id: post.id,
      url: normalizedUrl,
      title: post.title || "小红书笔记",
      snippet: post.snippet || post.title || "",
      author: post.author || undefined,
      xsecToken: post.xsecToken || parsed.xsecToken || undefined,
      likeCount: post.likeCount,
      commentCount: post.commentCount
    };
    const existing = byId.get(post.id);
    if (!existing) {
      byId.set(post.id, normalized);
      result.push(normalized);
      continue;
    }
    if (!existing.xsecToken && normalized.xsecToken) {
      existing.xsecToken = normalized.xsecToken;
      existing.url = normalizeXhsDetailUrl(existing.url || normalized.url, existing.id, normalized.xsecToken);
    }
    if ((!existing.title || existing.title === "小红书笔记") && normalized.title) existing.title = normalized.title;
    if (!existing.snippet && normalized.snippet) existing.snippet = normalized.snippet;
    if (!existing.author && normalized.author) existing.author = normalized.author;
    if (existing.likeCount == null && normalized.likeCount != null) existing.likeCount = normalized.likeCount;
    if (existing.commentCount == null && normalized.commentCount != null) existing.commentCount = normalized.commentCount;
  }
  return result;
}

async function readVisibleUsername(taskContext) {
  const page = await servicePage(taskContext);
  taskContext?.throwIfCancelled?.();
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll("[class*=nickname], [class*=user], [class*=name]")];
    return candidates.map((node) => node.textContent?.trim()).find((text) => text && text.length <= 40) || "";
  });
}

async function loadCookies(context) {
  for (const cookiesPath of COOKIE_FALLBACK_PATHS) {
    try {
      const text = await readFile(cookiesPath, "utf8");
      const cookies = JSON.parse(text);
      if (Array.isArray(cookies) && cookies.length) {
        await context.addCookies(cookies);
        serviceLog("info", "cookies", `Loaded ${cookies.length} XHS cookies.`, { cookiesPath });
        if (cookiesPath !== COOKIES_PATH) await persistCookies(cookies, "migrate");
        return;
      }
    } catch {
      // try next cookie path
    }
  }
  serviceLog("warn", "cookies", "No exported XHS cookies found.", { paths: COOKIE_FALLBACK_PATHS });
}

async function persistContextCookies(context, reason = "auto") {
  const cookies = await context.cookies();
  const xhsCookies = cookies.filter((cookie) => /xiaohongshu|xhs|rednote/i.test(cookie.domain));
  if (!xhsCookies.length) return 0;
  await persistCookies(xhsCookies, reason);
  return xhsCookies.length;
}

async function persistCookies(cookies, reason = "manual") {
  if (!Array.isArray(cookies) || !cookies.length) return;
  const data = JSON.stringify(cookies, null, 2);
  await Promise.all(
    COOKIE_FALLBACK_PATHS.map(async (cookiesPath) => {
      try {
        await mkdir(path.dirname(cookiesPath), { recursive: true });
        await writeFile(cookiesPath, data, "utf8");
      } catch {
        // best-effort compatibility mirror
      }
    })
  );
  serviceLog("info", "cookies", `Persisted ${cookies.length} XHS cookies.`, { reason, cookiesPath: COOKIES_PATH });
}

function startCookieAutoPersist(context) {
  stopCookieAutoPersist();
  cookiePersistTimer = setInterval(() => {
    persistContextCookies(context, "auto").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      serviceLog("warn", "cookies", `Cookie auto persist failed: ${message}`);
    });
  }, 15_000);
  cookiePersistTimer.unref?.();
}

function stopCookieAutoPersist() {
  if (cookiePersistTimer) clearInterval(cookiePersistTimer);
  cookiePersistTimer = undefined;
}

function toNotePayload(post) {
  return {
    noteId: post.id,
    xsecToken: post.xsecToken,
    title: post.title,
    desc: post.snippet,
    user: { nickname: post.author || "" },
    interactInfo: {
      likedCount: post.likeCount,
      commentCount: post.commentCount
    }
  };
}

function postFromUrl(value) {
  try {
    const url = new URL(value);
    if (!isAllowedXhsHttpUrl(url)) return { id: "", xsecToken: "" };
    return {
      id: url.pathname.split("/").filter(Boolean).at(-1) || value,
      xsecToken: url.searchParams.get("xsec_token") || ""
    };
  } catch {
    return { id: value, xsecToken: "" };
  }
}

function buildXhsUrl(id, xsecToken) {
  const url = new URL(`https://www.xiaohongshu.com/explore/${encodeURIComponent(id || "unknown")}`);
  if (xsecToken) url.searchParams.set("xsec_token", xsecToken);
  return url.toString();
}

function normalizeDetailInput(body) {
  const rawUrl = String(body.url || body.share_text || body.shareText || "").trim();
  const parsed = postFromUrl(extractUrl(rawUrl));
  const id = String(body.feed_id || body.id || parsed.id || "").trim();
  const cached = id ? postTokenCache.get(id) : undefined;
  const xsecToken = String(body.xsec_token || body.xsecToken || parsed.xsecToken || cached?.xsecToken || "").trim();
  const url = normalizeXhsDetailUrl(rawUrl || cached?.url || "", id, xsecToken);
  return { id, xsecToken, url };
}

function normalizeXhsDetailUrl(rawUrl, id, xsecToken) {
  const token = String(xsecToken || "").trim();
  const fallback = id ? buildXhsUrl(id, token) : "";
  const extractedUrl = normalizeUrlCandidate(extractUrl(String(rawUrl || "").trim()));
  if (!extractedUrl) return fallback;
  try {
    const url = new URL(extractedUrl);
    if (!isAllowedXhsHttpUrl(url)) return fallback;
    if (token && isXhsExploreUrl(url) && !url.searchParams.get("xsec_token")) {
      url.searchParams.set("xsec_token", token);
    }
    return url.toString();
  } catch {
    return fallback || "";
  }
}

function extractUrl(value) {
  if (!value) return "";
  const match = value.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0] || value;
}

function normalizeUrlCandidate(value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://www.xiaohongshu.com${value}`;
  if (/^(www\.)?(xiaohongshu|xhslink)\.com(\/|$)/i.test(value)) return `https://${value}`;
  return value;
}

function isXhsExploreUrl(url) {
  return /(^|\.)xiaohongshu\.com$/i.test(url.hostname) && url.pathname.split("/").includes("explore");
}

function isAllowedXhsHttpUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return /(^|\.)xiaohongshu\.com$/i.test(url.hostname) || /(^|\.)xhslink\.com$/i.test(url.hostname);
}

function isTokenRequiredForDetailUrl(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return isXhsExploreUrl(url) && parts.length >= 2 && parts[0] === "explore" && !url.searchParams.get("xsec_token");
  } catch {
    return false;
  }
}

function rememberPosts(posts) {
  for (const post of posts) {
    const id = String(post.id || "").trim();
    const parsed = postFromUrl(String(post.url || ""));
    const xsecToken = String(post.xsecToken || parsed.xsecToken || "").trim();
    if (!id || !xsecToken) continue;
    postTokenCache.set(id, {
      xsecToken,
      url: normalizeXhsDetailUrl(post.url || "", id, xsecToken),
      updatedAt: Date.now()
    });
  }
  trimPostTokenCache();
}

function trimPostTokenCache() {
  const maxSize = 1000;
  if (postTokenCache.size <= maxSize) return;
  const entries = [...postTokenCache.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of entries.slice(0, postTokenCache.size - maxSize)) {
    postTokenCache.delete(key);
  }
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/- 小红书$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function cleanSnippet(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function normalizeLimit(value, fallback) {
  const numberValue = Number(value || fallback);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(numberValue)));
}

function normalizePositiveInt(value, fallback) {
  const numberValue = Number(value || fallback);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(1, Math.floor(numberValue));
}

function normalizeCursorIndex(indexValue, cursorValue, fallback) {
  const cursorText = String(cursorValue || "");
  const offset = /^offset:(\d+)$/.exec(cursorText);
  if (offset) return Number(offset[1]);
  const numberValue = Number(indexValue ?? fallback);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.floor(numberValue));
}

function pagedPayload(key, items, { page, limit }) {
  return {
    [key]: items,
    items,
    cursor: { page: page + 1 },
    has_more: items.length >= limit,
    page,
    limit
  };
}

async function ensureRuntimeBrowser() {
  const payload = await fetchRuntimeJson("/health?ensure=1", {}, BROWSER_RUNTIME_TIMEOUT_MS);
  const runtime = payload?.runtime || payload?.data?.runtime || payload;
  serviceLog("info", "runtime", "Browser runtime ensured.", {
    url: BROWSER_RUNTIME_URL,
    chrome: runtime?.chrome?.running === true,
    cdp: runtime?.cdp?.ready === true,
    noVnc: runtime?.noVnc?.ready === true
  });
  return runtime;
}

async function runtimeBrowserSummary() {
  const payload = await fetchRuntimeJson("/health", {}, BROWSER_STATUS_TIMEOUT_MS);
  return payload?.runtime || payload;
}

async function requestRuntimeRestart(reason, leaseId) {
  const payload = await fetchRuntimeJson(
    "/browser/restart",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, leaseId })
    },
    Math.max(BROWSER_RESTART_TIMEOUT_MS, 30_000)
  );
  serviceLog("warn", "runtime", "Browser runtime restarted.", { reason });
  return payload?.data || payload;
}

async function acquireRuntimeLease(label, timeoutMs, taskContext) {
  const payload = await fetchRuntimeJson(
    "/browser/lease/acquire",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: "xhs-service",
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
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    serviceLog("warn", "runtime", `Browser runtime lease release failed: ${message}`);
  });
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

async function fetchRuntimeJson(endpoint, init = {}, timeoutMs = BROWSER_RUNTIME_TIMEOUT_MS) {
  const baseUrl = endpoint === "/browser/cookies/export" ? VIEWER_RUNTIME_URL : BROWSER_RUNTIME_URL;
  const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
  const response = await fetchWithAbort(url, init, timeoutMs);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || (payload && typeof payload === "object" && payload.success === false)) {
    const error = payload?.error?.message || payload?.message || `Browser runtime ${endpoint} failed: HTTP ${response.status}`;
    throw new Error(error);
  }
  return payload;
}

async function fetchWithAbort(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function connectBrowserOverCdp() {
  let lastError;
  for (let attempt = 1; attempt <= CDP_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      await waitForCdpHttp(Math.min(15_000, CDP_CONNECT_TIMEOUT_MS));
      return await chromium.connectOverCDP(`http://127.0.0.1:${INTERNAL_CDP_PORT}`, {
        timeout: CDP_CONNECT_TIMEOUT_MS
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      serviceLog("warn", "cdp", `CDP connect attempt ${attempt}/${CDP_CONNECT_ATTEMPTS} failed: ${message}`);
      if (attempt < CDP_CONNECT_ATTEMPTS) await delay(1_000 * attempt);
    }
  }
  throw lastError || new Error("Chromium CDP connection failed.");
}

async function verifyContextReady(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    await page.evaluate(() => document.readyState).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Chromium page readiness check failed: ${message}`);
    });
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
  }
}

async function waitForCdpHttp(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${INTERNAL_CDP_PORT}/json/version`).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chromium CDP port ${INTERNAL_CDP_PORT} did not become ready.`);
}

function delay(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(taskAbortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(taskAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function humanDelay(label, minMs = BROWSER_ACTION_DELAY_MIN_MS, maxMs = BROWSER_ACTION_DELAY_MAX_MS, options = {}) {
  if (!HUMAN_DELAY_ENABLED) return 0;
  const durationMs = randomBetween(minMs, maxMs);
  if (durationMs <= 0) return 0;
  if (options.log) serviceLog("info", "human-delay", `Waiting before ${label}.`, { durationMs });
  await delay(durationMs, options.signal);
  return durationMs;
}

function randomBetween(minMs, maxMs) {
  const min = Math.max(0, Math.floor(Number(minMs) || 0));
  const max = Math.max(min, Math.floor(Number(maxMs) || min));
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function withTimeout(promise, timeoutMs, message) {
  if (!promise) return Promise.resolve(undefined);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizePositiveEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeNonNegativeEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function normalizeDelayMax(name, fallback, min) {
  return Math.max(min, normalizeNonNegativeEnv(name, fallback));
}

function detectChromeVersion() {
  const fallback = process.env.XHS_BROWSER_FULL_VERSION || "137.0.0.0";
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

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function createRequestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (controller.signal.aborted || res.writableEnded) return;
    controller.abort(new BrowserTaskCancelledError(reason));
  };
  req.on("aborted", () => abort("Client aborted the HTTP request."));
  req.on("close", () => {
    if ((req.aborted === true || req.readableAborted === true) && !res.writableEnded) {
      abort("Client closed the HTTP request before completion.");
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) abort("Client connection closed before the browser task completed.");
  });
  return controller.signal;
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

function sendMcpResult(res, id, result) {
  sendJson(res, 200, { jsonrpc: "2.0", id, result }, { "Mcp-Session-Id": randomUUID() });
}

function sendMcpError(res, id, code, message) {
  sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } }, { "Mcp-Session-Id": randomUUID() });
}
