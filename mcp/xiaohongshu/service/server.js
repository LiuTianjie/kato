import { createServer } from "node:http";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 18060);
const BROWSER_BIN = process.env.XHS_BROWSER_BIN || process.env.CHROME_BIN || "/usr/bin/chromium";
const CDP_HOST = process.env.XHS_CDP_HOST || "0.0.0.0";
const CDP_PORT = Number(process.env.XHS_CDP_PORT || 9223);
const INTERNAL_CDP_PORT = Number(process.env.XHS_INTERNAL_CDP_PORT || CDP_PORT + 1);
const PROFILE_DIR = process.env.XHS_PROFILE_DIR || "/app/data/profile";
const COOKIES_PATH = process.env.COOKIES_PATH || "/app/data/cookies.json";
const CHROMIUM_HEADLESS = process.env.XHS_CHROMIUM_HEADLESS === "1";
const XHS_HOME_URL = "https://www.xiaohongshu.com/explore";
const XHS_CREATOR_URL = "https://creator.xiaohongshu.com";

let contextPromise;
let servicePagePromise;
let browserProcess;
let cdpProxyStarted = false;
let restartPromise;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "kato-xhs-browser", browser: await browserSummary() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/login/status") {
      sendJson(res, 200, { success: true, data: await loginStatus() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/login/qrcode") {
      await openLoginPage();
      sendJson(res, 200, { success: true, data: { opened: true, loginUrl: XHS_HOME_URL, cdpUrl: cdpUrl() } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/restart") {
      const body = await readJson(req);
      const data = await restartBrowser(String(body.reason || "manual"));
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/user/me") {
      sendJson(res, 200, { success: true, data: await currentUserSummary() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/feeds/search") {
      const keyword = url.searchParams.get("keyword") || url.searchParams.get("query") || "";
      const limit = normalizeLimit(url.searchParams.get("limit"), 20);
      const page = normalizePositiveInt(url.searchParams.get("page"), 1);
      const feeds = await searchFeeds(keyword, limit, { page });
      sendJson(res, 200, { success: true, data: pagedPayload("feeds", feeds, { page, limit }) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/search") {
      const body = await readJson(req);
      const keyword = String(body.keyword || body.query || "");
      const limit = normalizeLimit(body.limit, 20);
      const page = normalizePositiveInt(body.page, 1);
      const feeds = await searchFeeds(keyword, limit, { page });
      sendJson(res, 200, { success: true, data: pagedPayload("feeds", feeds, { page, limit }) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/detail") {
      const body = await readJson(req);
      const post = await getFeedDetail(body);
      sendJson(res, 200, { success: true, data: { note: toNotePayload(post), feeds: [post] } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/comments") {
      const body = await readJson(req);
      const limit = normalizeLimit(body.limit || body.max_comments || body.max_comment_items, 50);
      const index = normalizeCursorIndex(body.index, body.cursor, 0);
      const comments = await getFeedComments(body, limit, { index });
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
      await postComment(body);
      sendJson(res, 200, { success: true, data: { posted: true } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/feeds/like") {
      const body = await readJson(req);
      await likeFeed(body);
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
    await context?.browser()?.close();
  } finally {
    browserProcess?.kill();
    process.exit(0);
  }
}

async function browserSummary() {
  if (!contextPromise) return { running: false, cdpUrl: cdpUrl() };
  try {
    const context = await contextPromise;
    return { running: true, pages: context.pages().length, cdpUrl: cdpUrl() };
  } catch (error) {
    return {
      running: false,
      cdpUrl: cdpUrl(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
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

async function launchContext() {
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(path.dirname(COOKIES_PATH), { recursive: true });
  await clearStaleProfileLocks();
  const spawned = spawn(
    BROWSER_BIN,
    [
      ...(CHROMIUM_HEADLESS ? ["--headless=new"] : []),
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-notifications",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--password-store=basic",
      "--window-size=1440,980",
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
    }
  });

  startCdpProxy();
  await waitForCdpHttp();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${INTERNAL_CDP_PORT}`);
  const context = browser.contexts()[0] || (await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "zh-CN" }));
  await loadCookies(context);
  context.on("page", (page) => {
    page.setDefaultTimeout(30_000);
  });
  return context;
}

async function clearStaleProfileLocks() {
  await Promise.all(
    ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((name) =>
      rm(path.join(PROFILE_DIR, name), { force: true, recursive: true }).catch(() => undefined)
    )
  );
}

async function servicePage() {
  const context = await ensureContext();
  if (!servicePagePromise) {
    servicePagePromise = (async () => {
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(30_000);
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
  restartPromise = (async () => {
    console.error(`Restarting Chromium: ${reason}`);
    const oldContextPromise = contextPromise;
    const oldProcess = browserProcess;
    contextPromise = undefined;
    servicePagePromise = undefined;
    try {
      const context = oldContextPromise ? await oldContextPromise.catch(() => undefined) : undefined;
      await context?.browser()?.close().catch(() => undefined);
    } finally {
      if (oldProcess && !oldProcess.killed) {
        oldProcess.kill("SIGTERM");
        setTimeout(() => {
          if (oldProcess.exitCode === null && oldProcess.signalCode === null) oldProcess.kill("SIGKILL");
        }, 2_000).unref();
      }
      if (browserProcess === oldProcess) browserProcess = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await ensureContext();
    return {
      restarted: true,
      reason,
      browser: await browserSummary()
    };
  })().finally(() => {
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
  return /Page crashed|Page\.getLayoutMetrics|Target closed|Browser has been closed|Execution context was destroyed|Protocol error|CDP/i.test(
    message
  );
}

async function openLoginPage() {
  const page = await servicePage();
  await page.goto(XHS_HOME_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await page.bringToFront().catch(() => undefined);
}

async function loginStatus() {
  const context = await ensureContext();
  const cookies = await context.cookies();
  const xhsCookies = cookies.filter((cookie) => /xiaohongshu|xhs|rednote/i.test(cookie.domain));
  await persistCookies(xhsCookies);
  return {
    is_logged_in: xhsCookies.some((cookie) => ["web_session", "id_token"].includes(cookie.name) && cookie.value),
    username: await readVisibleUsername().catch(() => ""),
    cookie_count: xhsCookies.length,
    cdp_url: cdpUrl()
  };
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
    const url = String(body.url || buildXhsUrl(id, xsecToken)).trim();
    if (!url && !id) throw new Error("feed_id or url is required.");
    const page = await servicePage();
    await page.goto(url || buildXhsUrl(id, xsecToken), { waitUntil: "domcontentloaded", timeout: 60_000 });
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
      const result = await callTool(payload.params || {});
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
  try {
    const text = await readFile(COOKIES_PATH, "utf8");
    const cookies = JSON.parse(text);
    if (Array.isArray(cookies) && cookies.length) await context.addCookies(cookies);
  } catch {
    // no exported cookies yet
  }
}

async function persistCookies(cookies) {
  await writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2), "utf8").catch(() => undefined);
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

async function waitForCdpHttp(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${INTERNAL_CDP_PORT}/json/version`).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chromium CDP port ${INTERNAL_CDP_PORT} did not become ready.`);
}

function startCdpProxy() {
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
  proxy.listen(CDP_PORT, "0.0.0.0", () => {
    console.log(`CDP proxy listening on 0.0.0.0:${CDP_PORT} -> 127.0.0.1:${INTERNAL_CDP_PORT}`);
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
