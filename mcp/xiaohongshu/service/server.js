import { createServer } from "node:http";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

let stealthPluginReady = false;
try {
  chromium.use(StealthPlugin());
  stealthPluginReady = true;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Stealth plugin unavailable; using custom fingerprint fallback only: ${message}`);
}

const PORT = Number(process.env.PORT || 18060);
const BROWSER_BIN = process.env.XHS_BROWSER_BIN || process.env.CHROME_BIN || "/usr/bin/google-chrome-stable";
const CDP_HOST = process.env.XHS_CDP_HOST || "127.0.0.1";
const CDP_PORT = Number(process.env.XHS_CDP_PORT || 9224);
const INTERNAL_CDP_PORT = Number(process.env.XHS_INTERNAL_CDP_PORT || CDP_PORT);
const CDP_PROXY_ENABLED = process.env.XHS_CDP_PROXY_ENABLED === "1";
const PROFILE_DIR = process.env.XHS_PROFILE_DIR || "/app/data/profile";
const COOKIES_PATH = process.env.COOKIES_PATH || "/app/data/cookies.json";
const COOKIE_FALLBACK_PATHS = uniquePaths([
  COOKIES_PATH,
  "/app/mcp/xiaohongshu/data/cookies.json",
  "/app/data/cookies.json"
]);
const CHROMIUM_HEADLESS = process.env.XHS_CHROMIUM_HEADLESS === "1";
const CHROME_NO_SANDBOX = process.env.XHS_CHROME_NO_SANDBOX === "1";
const CDP_CONNECT_TIMEOUT_MS = normalizePositiveEnv("XHS_CDP_CONNECT_TIMEOUT_MS", 30_000);
const BROWSER_STATUS_TIMEOUT_MS = normalizePositiveEnv("XHS_BROWSER_STATUS_TIMEOUT_MS", 2_000);
const BROWSER_RESTART_TIMEOUT_MS = normalizePositiveEnv("XHS_BROWSER_RESTART_TIMEOUT_MS", 120_000);
const PROCESS_EXIT_GRACE_MS = normalizePositiveEnv("XHS_PROCESS_EXIT_GRACE_MS", 2_000);
const HEALTH_ENSURE_TIMEOUT_MS = normalizePositiveEnv("XHS_HEALTH_ENSURE_TIMEOUT_MS", 20_000);
const CDP_CONNECT_ATTEMPTS = normalizePositiveEnv("XHS_CDP_CONNECT_ATTEMPTS", 3);
const BROWSER_TASK_TIMEOUT_MS = normalizePositiveEnv("XHS_BROWSER_TASK_TIMEOUT_MS", 180_000);
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

let contextPromise;
let servicePagePromise;
let browserProcess;
let cdpProxyStarted = false;
let restartPromise;
let browserTaskTail = Promise.resolve();
let browserTaskSeq = 0;
let browserTaskPending = 0;
let browserTaskActive = null;
let browserPriorityPromise;
let cookiePersistTimer;

class BrowserTaskTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserTaskTimeoutError";
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const ensure = url.searchParams.get("ensure") === "1";
      const browser = await healthBrowserSummary({ ensure });
      const ok = ensure ? browser.running === true : true;
      sendJson(res, ok ? 200 : 503, { ok, service: "kato-xhs-browser", browser });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/login/status") {
      const data = await enqueueBrowserTask("login:status", () => loginStatus());
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/login/qrcode") {
      await enqueueBrowserTask("login:qrcode", () => openLoginPage());
      sendJson(res, 200, { success: true, data: { opened: true, loginUrl: XHS_HOME_URL, viewer: "novnc" } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/restart") {
      const body = await readJson(req);
      const data = await priorityRestartBrowser(`priority:${String(body.reason || "manual")}`);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/browser/status") {
      sendJson(res, 200, { success: true, data: await browserSummary() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/sync-cookies") {
      const context = await ensureContext();
      const exportedCookies = await persistContextCookies(context, "manual-sync");
      sendJson(res, 200, { success: true, data: { cookiesPath: COOKIES_PATH, exportedCookies } });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/user/me") {
      const data = await enqueueBrowserTask("user:me", () => currentUserSummary());
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/feeds/search") {
      const keyword = url.searchParams.get("keyword") || url.searchParams.get("query") || "";
      const limit = normalizeLimit(url.searchParams.get("limit"), 20);
      const page = normalizePositiveInt(url.searchParams.get("page"), 1);
      const feeds = await enqueueBrowserTask("feeds:search", () => searchFeeds(keyword, limit, { page }));
      sendJson(res, 200, { success: true, data: pagedPayload("feeds", feeds, { page, limit }) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/search") {
      const body = await readJson(req);
      const keyword = String(body.keyword || body.query || "");
      const limit = normalizeLimit(body.limit, 20);
      const page = normalizePositiveInt(body.page, 1);
      const feeds = await enqueueBrowserTask("feeds:search", () => searchFeeds(keyword, limit, { page }));
      sendJson(res, 200, { success: true, data: pagedPayload("feeds", feeds, { page, limit }) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/detail") {
      const body = await readJson(req);
      const post = await enqueueBrowserTask("feeds:detail", () => getFeedDetail(body));
      sendJson(res, 200, { success: true, data: { note: toNotePayload(post), feeds: [post] } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/comments") {
      const body = await readJson(req);
      const limit = normalizeLimit(body.limit || body.max_comments || body.max_comment_items, 50);
      const index = normalizeCursorIndex(body.index, body.cursor, 0);
      const comments = await enqueueBrowserTask("feeds:comments", () => getFeedComments(body, limit, { index }));
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
      await enqueueBrowserTask("feeds:comment", () => postComment(body));
      sendJson(res, 200, { success: true, data: { posted: true } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/like") {
      const body = await readJson(req);
      await enqueueBrowserTask("feeds:like", () => likeFeed(body));
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
    sendJson(res, 500, { success: false, error: { code: "INTERNAL_ERROR", message } });
  }
});

server.listen(PORT, () => {
  console.log(`kato-xhs-browser listening on http://0.0.0.0:${PORT}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  try {
    const context = contextPromise ? await contextPromise : undefined;
    if (context) await persistContextCookies(context, "shutdown").catch(() => undefined);
    await context?.browser()?.close();
  } finally {
    stopCookieAutoPersist();
    browserProcess?.kill();
    process.exit(0);
  }
}

async function browserSummary() {
  if (!contextPromise) return { running: false, queue: browserQueueSummary(), stealth: stealthSummary() };
  try {
    const context = await withTimeout(contextPromise, BROWSER_STATUS_TIMEOUT_MS, "Browser status timed out.");
    return { running: true, pages: context.pages().length, queue: browserQueueSummary(), stealth: stealthSummary() };
  } catch (error) {
    return {
      running: false,
      queue: browserQueueSummary(),
      stealth: stealthSummary(),
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
      throw error;
    });
  }
  return contextPromise;
}

function enqueueBrowserTask(label, task, options = {}) {
  const id = ++browserTaskSeq;
  const timeoutMs = normalizePositiveInt(options.timeoutMs, BROWSER_TASK_TIMEOUT_MS);
  const queuedAt = Date.now();
  browserTaskPending += 1;

  const run = async () => {
    if (browserPriorityPromise) await browserPriorityPromise.catch(() => undefined);
    browserTaskPending = Math.max(0, browserTaskPending - 1);
    browserTaskActive = { id, label, startedAt: new Date().toISOString() };
    const waitedMs = Date.now() - queuedAt;
    console.error(`Browser task #${id} started: ${label}; waited=${waitedMs}ms pending=${browserTaskPending}`);
    try {
      return await runBrowserTaskWithTimeout(label, task, timeoutMs);
    } finally {
      const activeMs = Date.now() - (queuedAt + waitedMs);
      console.error(`Browser task #${id} finished: ${label}; active=${activeMs}ms pending=${browserTaskPending}`);
      browserTaskActive = null;
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

async function runBrowserTaskWithTimeout(label, task, timeoutMs) {
  let timer;
  const taskPromise = Promise.resolve().then(task);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new BrowserTaskTimeoutError(`Browser task ${label} timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof BrowserTaskTimeoutError) {
      taskPromise.catch(() => undefined);
      await resetBrowserAfterTaskTimeout(label);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resetBrowserAfterTaskTimeout(label) {
  console.error(`Browser task timed out; resetting Chromium before next task: ${label}`);
  const oldContextPromise = contextPromise;
  const oldProcess = browserProcess;
  contextPromise = undefined;
  servicePagePromise = undefined;

  if (oldProcess) {
    terminateProcess(oldProcess, `task timeout: ${label}`);
    await waitForProcessExit(oldProcess, PROCESS_EXIT_GRACE_MS + 500).catch(() => undefined);
  }
  if (browserProcess === oldProcess) browserProcess = undefined;

  if (oldContextPromise) {
    const context = await withTimeout(oldContextPromise, 1_500, "Timed-out browser context close timed out.").catch(() => undefined);
    await withTimeout(context?.browser()?.close(), 1_500, "Timed-out browser close timed out.").catch(() => undefined);
  }

  await waitForCdpClosed(3_000).catch(() => undefined);
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
  await clearStaleProfileLocks();
  const spawned = spawn(
    BROWSER_BIN,
    [
      ...(CHROMIUM_HEADLESS ? ["--headless=new"] : []),
      ...(CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
      "--disable-dev-shm-usage",
      "--disable-notifications",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-blink-features=AutomationControlled",
      "--password-store=basic",
      "--window-size=1440,980",
      `--user-agent=${WINDOWS_USER_AGENT}`,
      "--accept-lang=zh-CN,zh,en-US,en",
      `--remote-debugging-address=${CDP_HOST}`,
      `--remote-debugging-port=${INTERNAL_CDP_PORT}`,
      "--lang=zh-CN",
      `--user-data-dir=${PROFILE_DIR}`,
      "about:blank"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  browserProcess = spawned;
  spawned.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  spawned.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  spawned.on("exit", (code) => {
    console.error(`Chromium exited with code ${code ?? "unknown"}`);
    if (browserProcess === spawned) {
      browserProcess = undefined;
      contextPromise = undefined;
      servicePagePromise = undefined;
      stopCookieAutoPersist();
    }
  });

  try {
    startCdpProxy();
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
        console.error(`Page fingerprint apply failed: ${message}`);
      });
    });
    await verifyContextReady(context);
    return context;
  } catch (error) {
    if (browserProcess === spawned) {
      terminateProcess(spawned, "launch failed");
      browserProcess = undefined;
    }
    stopCookieAutoPersist();
    throw error;
  }
}

async function clearStaleProfileLocks() {
  await Promise.all(
    ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((name) =>
      rm(path.join(PROFILE_DIR, name), { force: true, recursive: true }).catch(() => undefined)
    )
  );
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
    console.error(`Context fingerprint init script failed: ${message}`);
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

async function servicePage() {
  const context = await ensureContext();
  if (!servicePagePromise) {
    servicePagePromise = (async () => {
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(30_000);
      await applyPageFingerprint(page).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Service page fingerprint apply failed: ${message}`);
      });
      return page;
    })();
  }
  const page = await servicePagePromise;
  if (page.isClosed()) {
    servicePagePromise = undefined;
    return servicePage();
  }
  return page;
}

async function restartBrowser(reason = "manual") {
  if (restartPromise) return restartPromise;
  restartPromise = withTimeout((async () => {
    console.error(`Restarting Chromium: ${reason}`);
    const oldContextPromise = contextPromise;
    const oldProcess = browserProcess;
    contextPromise = undefined;
    servicePagePromise = undefined;
    stopCookieAutoPersist();

    if (oldProcess) {
      terminateProcess(oldProcess, reason);
      await waitForProcessExit(oldProcess, PROCESS_EXIT_GRACE_MS + 500).catch(() => undefined);
    }
    if (browserProcess === oldProcess) browserProcess = undefined;

    if (oldContextPromise) {
      const context = await withTimeout(oldContextPromise, 1_500, "Old browser context close timed out.").catch(() => undefined);
      if (context) await persistContextCookies(context, "restart").catch(() => undefined);
      await withTimeout(context?.browser()?.close(), 1_500, "Old browser close timed out.").catch(() => undefined);
    }

    await waitForCdpClosed(3_000).catch(() => undefined);
    await delay(1_000);
    await ensureContext();
    await servicePage();
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

async function withBrowserRecovery(label, task) {
  try {
    return await task();
  } catch (error) {
    if (!isRecoverableBrowserError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await restartBrowser(`${label}: ${message.slice(0, 240)}`);
    return task();
  }
}

function isRecoverableBrowserError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Page crashed|Page\.getLayoutMetrics|Target closed|Browser has been closed|Execution context was destroyed|Protocol error|connectOverCDP|CDP|timed out/i.test(
    message
  );
}

async function openLoginPage() {
  return withBrowserRecovery("openLoginPage", async () => {
    const page = await servicePage();
    await page.goto(XHS_HOME_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
  });
}

async function loginStatus() {
  return withBrowserRecovery("loginStatus", async () => {
    const context = await ensureContext();
    const cookies = await context.cookies();
    const xhsCookies = cookies.filter((cookie) => /xiaohongshu|xhs|rednote/i.test(cookie.domain));
    if (xhsCookies.length) await persistCookies(xhsCookies, "loginStatus");
    return {
      is_logged_in: xhsCookies.some((cookie) => ["web_session", "id_token"].includes(cookie.name) && cookie.value),
      username: await readVisibleUsername().catch(() => ""),
      cookie_count: xhsCookies.length
    };
  });
}

async function currentUserSummary() {
  const status = await loginStatus();
  return {
    userBasicInfo: { nickname: status.username || "" },
    feeds: []
  };
}

async function searchFeeds(keyword, limit, options = {}) {
  return withBrowserRecovery("searchFeeds", async () => {
    if (!keyword.trim()) return [];
    const pageNumber = normalizePositiveInt(options.page, 1);
    const page = await servicePage();
    const url = new URL("https://www.xiaohongshu.com/search_result");
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("source", "web_search_result_notes");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await autoScroll(page, Math.max(2, pageNumber + 1));
    const posts = await scrapePosts(page);
    const start = (pageNumber - 1) * limit;
    return uniquePosts(posts).slice(start, start + limit);
  });
}

async function getFeedDetail(body) {
  return withBrowserRecovery("getFeedDetail", async () => {
    const id = String(body.feed_id || body.id || "").trim();
    const xsecToken = String(body.xsec_token || body.xsecToken || "").trim();
    const url = normalizeXhsDetailUrl(body.url, id, xsecToken);
    if (!url && !id) throw new Error("feed_id or url is required.");
    const page = await servicePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_500);
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
    return {
      id: id || parsed.id,
      xsecToken: xsecToken || parsed.xsecToken,
      url,
      title: cleanTitle(detail.title),
      snippet: cleanSnippet(detail.snippet || detail.text),
      author: detail.author || undefined
    };
  });
}

async function postComment(body) {
  const content = String(body.content || body.comment || "").trim();
  if (!content) throw new Error("content is required.");
  const post = await getFeedDetail(body);
  const page = await servicePage();
  await focusCommentEditor(page);
  await page.keyboard.insertText(content);
  await page.waitForTimeout(500);
  const clicked = await clickFirstVisible(page, [
    "button:has-text('发送')",
    "button:has-text('发布')",
    "button:has-text('评论')",
    ".submit",
    "[class*=submit]"
  ]);
  if (!clicked) throw new Error(`Cannot find comment submit button for ${post.id}.`);
}

async function likeFeed(body) {
  const post = await getFeedDetail(body);
  const page = await servicePage();
  const clicked = await clickFirstVisible(page, [
    "[aria-label*='点赞']",
    "button:has-text('点赞')",
    "[class*=like]",
    "[class*=interact] button"
  ]);
  if (!clicked) throw new Error(`Cannot find like button for ${post.id}.`);
}

async function handleMcp(req, res) {
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
      const result = await enqueueBrowserTask(`mcp:${toolName}`, () => callTool(payload.params || {}));
      sendMcpResult(res, payload.id, result);
      return;
    }

    sendMcpError(res, payload.id, -32601, `Method not found: ${payload.method}`);
  } catch (error) {
    sendMcpError(res, payload.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

async function callTool(params) {
  const name = String(params.name || "");
  const args = params.arguments || {};
  if (name === "search_feeds") {
    const limit = normalizeLimit(args.limit, 20);
    const page = normalizePositiveInt(args.page, 1);
    const feeds = await searchFeeds(String(args.keyword || args.query || ""), limit, { page });
    return toolJson(pagedPayload("feeds", feeds, { page, limit }));
  }
  if (name === "get_feed_detail") {
    return toolJson(await getFeedDetail(args));
  }
  if (name === "get_feed_comments") {
    const limit = normalizeLimit(args.limit || args.max_comments || args.max_comment_items, 50);
    const index = normalizeCursorIndex(args.index, args.cursor, 0);
    const comments = await getFeedComments(args, limit, { index });
    return toolJson({
      comments,
      items: comments,
      cursor: { cursor: comments.length ? `offset:${index + 1}` : "", index: index + 1, pageArea: args.pageArea || "UNFOLDED" },
      has_more: comments.length >= limit
    });
  }
  if (name === "post_comment_to_feed") {
    await postComment(args);
    return toolJson({ posted: true });
  }
  if (name === "like_feed") {
    await likeFeed(args);
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

async function focusCommentEditor(page) {
  const selectors = [
    "textarea",
    "[contenteditable='true']",
    "[role='textbox']",
    "input[placeholder*='评论']",
    "[placeholder*='评论']"
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await locator.click();
      return;
    }
  }
  throw new Error("Cannot find comment editor.");
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
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
  return withBrowserRecovery("getFeedComments", async () => {
    await getFeedDetail(body);
    const page = await servicePage();
    const index = normalizeCursorIndex(options.index, options.cursor, 0);
    await autoScroll(page, Math.max(3, index + 3));
    return uniqueComments(await scrapeComments(page), limit, index * limit);
  });
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

async function autoScroll(page, steps) {
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, 900).catch(() => undefined);
    await page.waitForTimeout(800);
  }
}

function uniquePosts(posts) {
  const seen = new Set();
  const result = [];
  for (const post of posts) {
    if (!post.id || !post.url || seen.has(post.id)) continue;
    seen.add(post.id);
    result.push({
      id: post.id,
      url: post.url,
      title: post.title || "小红书笔记",
      snippet: post.snippet || post.title || "",
      author: post.author || undefined,
      xsecToken: post.xsecToken || undefined,
      likeCount: post.likeCount,
      commentCount: post.commentCount
    });
  }
  return result;
}

async function readVisibleUsername() {
  const page = await servicePage();
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
        console.error(`Loaded ${cookies.length} XHS cookies from ${cookiesPath}`);
        if (cookiesPath !== COOKIES_PATH) await persistCookies(cookies, "migrate");
        return;
      }
    } catch {
      // try next cookie path
    }
  }
  console.error(`No exported XHS cookies found in ${COOKIE_FALLBACK_PATHS.join(", ")}`);
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
  console.error(`Persisted ${cookies.length} XHS cookies (${reason}) to ${COOKIES_PATH}`);
}

function startCookieAutoPersist(context) {
  stopCookieAutoPersist();
  cookiePersistTimer = setInterval(() => {
    persistContextCookies(context, "auto").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Cookie auto persist failed: ${message}`);
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

function normalizeXhsDetailUrl(rawUrl, id, xsecToken) {
  const token = String(xsecToken || "").trim();
  const fallback = id ? buildXhsUrl(id, token) : "";
  const extractedUrl = normalizeUrlCandidate(extractUrl(String(rawUrl || "").trim()));
  if (!extractedUrl) return fallback;
  try {
    const url = new URL(extractedUrl);
    if (token && isXhsExploreUrl(url) && !url.searchParams.get("xsec_token")) {
      url.searchParams.set("xsec_token", token);
    }
    return url.toString();
  } catch {
    return fallback || extractedUrl;
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
  if (/^(www\.)?xiaohongshu\.com(\/|$)/i.test(value)) return `https://${value}`;
  return value;
}

function isXhsExploreUrl(url) {
  return /(^|\.)xiaohongshu\.com$/i.test(url.hostname) && url.pathname.split("/").includes("explore");
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

function cdpUrl() {
  return `http://127.0.0.1:${CDP_PORT}`;
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
      console.error(`CDP connect attempt ${attempt}/${CDP_CONNECT_ATTEMPTS} failed: ${message}`);
      if (attempt < CDP_CONNECT_ATTEMPTS) await delay(1_000 * attempt);
    }
  }
  throw lastError || new Error("Chromium CDP connection failed.");
}

async function verifyContextReady(context) {
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30_000);
  await page.evaluate(() => document.readyState).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Chromium page readiness check failed: ${message}`);
  });
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

async function waitForCdpClosed(timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${INTERNAL_CDP_PORT}/json/version`).catch(() => null);
    if (!response?.ok) return;
    await delay(150);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  if (!promise) return Promise.resolve(undefined);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function terminateProcess(processRef, reason) {
  if (!processRef || processRef.killed) return;
  console.error(`Terminating Chromium process: ${reason}`);
  processRef.kill("SIGTERM");
  setTimeout(() => {
    if (processRef.exitCode === null && processRef.signalCode === null) {
      console.error("Chromium did not exit after SIGTERM; sending SIGKILL");
      processRef.kill("SIGKILL");
    }
  }, PROCESS_EXIT_GRACE_MS).unref();
}

function waitForProcessExit(processRef, timeoutMs) {
  if (!processRef || processRef.exitCode !== null || processRef.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    processRef.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function normalizePositiveEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
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

function startCdpProxy() {
  if (!CDP_PROXY_ENABLED || CDP_PORT === INTERNAL_CDP_PORT) return;
  if (cdpProxyStarted) return;
  cdpProxyStarted = true;
  const proxy = createTcpServer((client) => {
    const upstream = connectTcp(INTERNAL_CDP_PORT, "127.0.0.1");
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  });
  proxy.on("error", (error) => console.error(`CDP proxy error: ${error.message}`));
  proxy.listen(CDP_PORT, "127.0.0.1", () => {
    console.log(`CDP proxy listening on 127.0.0.1:${CDP_PORT} -> 127.0.0.1:${INTERNAL_CDP_PORT}`);
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

function sendMcpResult(res, id, result) {
  sendJson(res, 200, { jsonrpc: "2.0", id, result }, { "Mcp-Session-Id": randomUUID() });
}

function sendMcpError(res, id, code, message) {
  sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } }, { "Mcp-Session-Id": randomUUID() });
}
