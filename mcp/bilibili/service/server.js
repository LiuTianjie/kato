import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || process.env.BILIBILI_SERVICE_PORT || 18080);
const COOKIES_PATH = process.env.BILIBILI_COOKIES_PATH || "/app/data/platforms/bilibili/cookies.json";
const STORAGE_PATH = process.env.BILIBILI_STORAGE_PATH || "/app/data/platforms/bilibili/storage.json";
const VIEWER_RUNTIME_URL = process.env.BILIBILI_VIEWER_RUNTIME_URL || "http://127.0.0.1:18120";
const FETCH_TIMEOUT_MS = normalizePositiveEnv("BILIBILI_FETCH_TIMEOUT_MS", 60_000);
const BROWSER_RUNTIME_TIMEOUT_MS = normalizePositiveEnv("BILIBILI_BROWSER_RUNTIME_TIMEOUT_MS", 30_000);
const SERVICE_LOG_LIMIT = normalizePositiveEnv("BILIBILI_SERVICE_LOG_LIMIT", 600);
const USER_AGENT =
  process.env.BILIBILI_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BILIBILI_COOKIE_DOMAINS = [".bilibili.com", "bilibili.com", ".biligame.com", "biligame.com"];
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

let serviceLogSeq = 0;
const serviceLogs = [];
let wbiKeyCache = null;
const collectionJobs = new Map();
const credentialQueues = new Map();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/v1/browser/logs") {
      const since = Number(url.searchParams.get("since") || 0);
      const limit = Number(url.searchParams.get("limit") || 200);
      sendJson(res, 200, { success: true, data: { logs: serviceLogsSince(since, limit), cursor: serviceLogSeq } });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "kato-bilibili-service" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/login/status") {
      const cookie = await loadCookieHeader();
      sendJson(res, 200, {
        success: true,
        data: {
          is_logged_in: /SESSDATA=/i.test(cookie),
          cookie_count: cookie ? cookie.split(";").filter(Boolean).length : 0
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/update-cookie") {
      const body = await readJson(req);
      const cookie = String(body.cookie || body.cookies || "").trim();
      if (!cookie) throw httpError(400, "INVALID_PARAMS", "cookie is required.");
      await persistCookieHeader(cookie);
      sendJson(res, 200, { success: true, data: { cookiesPath: COOKIES_PATH, updated: true } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/sync-cookies") {
      const cookies = await exportViewerCookies(BILIBILI_COOKIE_DOMAINS);
      const storage = await exportViewerStorage(BILIBILI_COOKIE_DOMAINS).catch((error) => {
        serviceLog("warn", "storage", `Bilibili browser storage sync failed: ${errorMessage(error)}`);
        return [];
      });
      const cookieHeader = cookiesToHeader(cookies);
      if (!cookieHeader) throw httpError(401, "COOKIE_EXPIRED", "No Bilibili cookies found in viewer runtime.");
      await persistCookieHeader(cookieHeader);
      await persistStorage(storage, "manual-sync");
      sendJson(res, 200, {
        success: true,
        data: {
          cookiesPath: COOKIES_PATH,
          storagePath: STORAGE_PATH,
          exportedCookies: cookies.length,
          exportedStorageOrigins: storage.length
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/browser/clear-auth") {
      await clearPersistedAuth("manual-clear");
      sendJson(res, 200, { success: true, data: { cookiesPath: COOKIES_PATH, storagePath: STORAGE_PATH, cleared: true } });
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/v1/videos/search") {
      const body = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
      const keyword = String(body.keyword || body.query || "").trim();
      if (!keyword) throw httpError(400, "INVALID_PARAMS", "keyword is required.");
      const pn = normalizePositiveInt(body.pn || body.page, 1);
      const ps = normalizeLimit(body.ps || body.page_size || body.limit, 20);
      const data = await searchVideos(keyword, pn, ps, body.order || sortOrderFromLabel(body.sort_label, "totalrank"), body.auth);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/v1/videos/detail") {
      const body = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
      const data = await fetchOneVideo(body, body.auth);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/v1/videos/comments") {
      const body = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
      const pn = normalizePositiveInt(body.pn || body.page || body.num, 1);
      const ps = normalizeLimit(body.ps || body.page_size || body.limit || body.size, 20);
      const data = await fetchVideoComments(body, pn, ps, body.auth);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/v1/videos/comment_replies") {
      const body = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
      const pn = normalizePositiveInt(body.pn || body.page || body.num, 1);
      const ps = normalizeLimit(body.ps || body.page_size || body.limit || body.size, 20);
      const data = await fetchCommentReplies(body, pn, ps, body.auth);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/collection/jobs") {
      const body = await readJson(req);
      const job = await createCollectionJob(body);
      sendJson(res, 200, { success: true, data: job });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/v1/collection/jobs/")) {
      const jobId = url.pathname.split("/").pop();
      const job = collectionJobs.get(jobId);
      if (!job) throw httpError(404, "JOB_NOT_FOUND", "collection job not found.");
      sendJson(res, 200, { success: true, data: job });
      return;
    }

    sendJson(res, 404, { success: false, error: { code: "NOT_FOUND", message: "Endpoint not found." } });
  } catch (error) {
    const status = error?.status || 500;
    const code = error?.code || "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const level = status >= 500 ? "error" : status === 401 ? "warn" : "info";
    serviceLog(level, "request", `${req.method || "GET"} ${req.url || "/"} failed: ${message}`, { status, code });
    sendJson(res, status, { success: false, error: { code, message } });
  }
});

server.listen(PORT, () => {
  serviceLog("info", "service", `kato-bilibili-service listening on http://0.0.0.0:${PORT}`);
});

async function searchVideos(keyword, pn, ps, order = "totalrank", auth) {
  const payload = await bilibiliApi("/x/web-interface/search/type", {
    search_type: "video",
    keyword,
    page: pn,
    page_size: ps,
    order
  }, auth);
  const data = payload.data || {};
  const result = Array.isArray(data.result) ? data.result.map(toSearchVideo).filter((item) => item.bvid) : [];
  return {
    result,
    page: {
      pn,
      ps,
      count: numberValue(data.numResults ?? data.num_results ?? data.page?.count)
    }
  };
}

async function fetchOneVideo(input, auth) {
  const identity = normalizeVideoIdentity(input);
  const payload = await bilibiliApi("/x/web-interface/view", identity, auth);
  return toDetailVideo(payload.data || {});
}

async function fetchVideoComments(input, pn, ps, auth) {
  const oid = await resolveAid(input, auth);
  const order = String(input.order || input.sort_label || input.sort || "").toLowerCase();
  const latest = ["time", "latest", "pubdate"].includes(order);
  if (latest) return fetchVideoCommentsLatest(input, oid, pn, ps, auth);
  const payload = await bilibiliApi("/x/v2/reply", { type: input.type || 1, oid, pn, ps, sort: input.sort || 2 }, auth);
  const data = payload.data || {};
  return {
    replies: Array.isArray(data.replies) ? data.replies.map(toReply) : [],
    page: {
      num: numberValue(data.page?.num ?? pn),
      size: numberValue(data.page?.size ?? ps),
      count: numberValue(data.page?.count)
    },
    has_more: hasMoreByPage(data.page, pn, ps),
    cursor: ""
  };
}

async function fetchVideoCommentsLatest(input, oid, pn, ps, auth) {
  const pageSize = Math.max(1, Math.min(ps, 50));
  const endpoint = await buildWbiCommentEndpoint({
    oid,
    page: pn,
    pageSize,
    cursor: stringValue(input.cursor)
  }, auth);
  const payload = await bilibiliApi(endpoint.pathname, Object.fromEntries(endpoint.searchParams.entries()), auth);
  const data = payload.data || {};
  const page = data.page || {};
  const cursor = extractWbiNextCursor(data);
  const total = numberValue(data.cursor?.all_count ?? page.count);
  const replies = Array.isArray(data.replies) ? data.replies.map(toReply) : [];
  return {
    replies,
    page: {
      num: numberValue(page.num ?? pn),
      size: numberValue(page.size ?? pageSize),
      count: total
    },
    cursor,
    has_more: Boolean(cursor) && replies.length > 0 && !isWbiCursorEnded(data)
  };
}

async function fetchCommentReplies(input, pn, ps, auth) {
  const oid = await resolveAid(input, auth);
  const root = String(input.root || input.root_id || input.rpid || input.comment_id || "").trim();
  if (!root) throw httpError(400, "INVALID_PARAMS", "root/rpid/comment_id is required.");
  const payload = await bilibiliApi("/x/v2/reply/reply", { type: input.type || 1, oid, root, pn, ps }, auth);
  const data = payload.data || {};
  const order = String(input.order || input.sort_label || "").toLowerCase();
  const replies = Array.isArray(data.replies) ? data.replies.map((reply) => toReply(reply, root)) : [];
  if (["time", "latest", "pubdate"].includes(order)) {
    replies.sort((left, right) => numberValue(right.ctime) - numberValue(left.ctime));
  }
  return {
    replies,
    page: {
      num: numberValue(data.page?.num ?? pn),
      size: numberValue(data.page?.size ?? ps),
      count: numberValue(data.page?.count)
    }
  };
}

async function resolveAid(input, auth) {
  const aid = String(input.aid || input.oid || input.id || "").trim();
  if (aid && /^\d+$/.test(aid)) return aid;
  const bvid = extractBvid(String(input.bvid || input.bv_id || input.bvId || input.url || ""));
  if (!bvid) throw httpError(400, "INVALID_PARAMS", "aid/oid or bvid is required.");
  const detail = await fetchOneVideo({ bvid }, auth);
  if (!detail.aid) throw httpError(400, "INVALID_PARAMS", "Cannot resolve aid from bvid.");
  return String(detail.aid);
}

function normalizeVideoIdentity(input) {
  const bvid = extractBvid(String(input.bvid || input.bv_id || input.bvId || input.url || ""));
  const aid = String(input.aid || input.id || "").trim();
  if (bvid) return { bvid };
  if (aid) return { aid };
  throw httpError(400, "INVALID_PARAMS", "bvid, aid or url is required.");
}

async function bilibiliApi(pathname, params, auth) {
  const url = new URL(`https://api.bilibili.com${pathname}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const cookie = normalizeAuthCookie(auth) || (await loadCookieHeader());
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json,text/plain,*/*",
    "Referer": "https://www.bilibili.com/",
    ...(cookie ? { Cookie: cookie } : {})
  };
  const response = await fetchWithTimeout(url, { headers }, FETCH_TIMEOUT_MS);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (response.status === 401 || response.status === 403 || response.status === 412) {
    throw httpError(401, "COOKIE_EXPIRED", "cookie expired or anti-bot challenge");
  }
  if (!response.ok) throw httpError(response.status, "UPSTREAM_ERROR", `Bilibili HTTP ${response.status}`);
  if (payload.code !== 0) {
    const code = payload.code === -101 || payload.code === -102 ? "COOKIE_EXPIRED" : "UPSTREAM_ERROR";
    const status = code === "COOKIE_EXPIRED" ? 401 : 502;
    throw httpError(status, code, String(payload.message || payload.msg || `Bilibili API code ${payload.code}`));
  }
  return payload;
}

async function createCollectionJob(input) {
  const jobId = randomUUID();
  const platform = String(input.platform || "bilibili");
  if (platform !== "bilibili") throw httpError(400, "INVALID_PARAMS", "bilibili service only accepts bilibili jobs.");
  const type = String(input.type || input.job_type || "").trim();
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const auth = input.auth && typeof input.auth === "object" ? input.auth : {};
  const credentialId = String(auth.credential_id || auth.account_id || "anonymous");
  const startedAt = new Date().toISOString();
  const baseJob = {
    job_id: jobId,
    platform,
    type,
    credential_id: credentialId,
    status: "running",
    created_at: startedAt,
    started_at: startedAt,
    finished_at: null,
    result: null,
    error: null
  };
  collectionJobs.set(jobId, baseJob);
  try {
    const result = await runCredentialQueued(credentialId, () => runCollectionJob(type, payload, auth));
    const finished = { ...baseJob, status: "succeeded", finished_at: new Date().toISOString(), result };
    collectionJobs.set(jobId, finished);
    return finished;
  } catch (error) {
    const failed = {
      ...baseJob,
      status: "failed",
      finished_at: new Date().toISOString(),
      error: normalizeCollectionError(error)
    };
    collectionJobs.set(jobId, failed);
    return failed;
  }
}

async function runCollectionJob(type, payload, auth) {
  if (type === "keyword_search") {
    const keyword = String(payload.keyword || payload.query || "").trim();
    if (!keyword) throw httpError(400, "INVALID_PARAMS", "keyword is required.");
    const page = normalizePositiveInt(payload.page || payload.pn, 1);
    const limit = normalizeLimit(payload.limit || payload.ps || payload.page_size, 20);
    return searchVideos(keyword, page, limit, payload.order || sortOrderFromLabel(payload.sort_label, "totalrank"), auth);
  }
  if (type === "post_detail") return fetchOneVideo(payload, auth);
  if (type === "post_comments") {
    const page = normalizePositiveInt(payload.page || payload.pn || payload.num, 1);
    const limit = normalizeLimit(payload.limit || payload.ps || payload.page_size || payload.size, 20);
    return fetchVideoComments(payload, page, limit, auth);
  }
  if (type === "comment_replies") {
    const page = normalizePositiveInt(payload.page || payload.pn || payload.num, 1);
    const limit = normalizeLimit(payload.limit || payload.ps || payload.page_size || payload.size, 20);
    return fetchCommentReplies(payload, page, limit, auth);
  }
  throw httpError(400, "INVALID_PARAMS", `unsupported collection job type: ${type}`);
}

function runCredentialQueued(credentialId, task) {
  const key = credentialId || "anonymous";
  const previous = credentialQueues.get(key) || Promise.resolve();
  const current = previous.then(task, task);
  const queued = current.catch(() => undefined).finally(() => {
    if (credentialQueues.get(key) === queued) credentialQueues.delete(key);
  });
  credentialQueues.set(key, queued);
  return current;
}

function normalizeAuthCookie(auth) {
  if (!auth || typeof auth !== "object") return "";
  return String(auth.cookie || auth.cookies || "").trim();
}

function normalizeCollectionError(error) {
  return {
    code: error?.code || "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    status: error?.status || 500
  };
}

function toSearchVideo(item) {
  const bvid = stringValue(item.bvid ?? item.bv_id ?? item.bvId);
  return {
    bvid,
    bv_id: bvid,
    bvId: bvid,
    aid: numberValue(item.aid ?? item.id),
    id: numberValue(item.aid ?? item.id),
    title: cleanHtml(stringValue(item.title ?? item.name)),
    name: cleanHtml(stringValue(item.title ?? item.name)),
    description: cleanHtml(stringValue(item.description ?? item.desc ?? item.content)),
    desc: cleanHtml(stringValue(item.description ?? item.desc ?? item.content)),
    content: cleanHtml(stringValue(item.description ?? item.desc ?? item.content)),
    author: stringValue(item.author ?? item.uname),
    uname: stringValue(item.author ?? item.uname),
    mid: numberValue(item.mid),
    pubdate: numberValue(item.pubdate),
    play: numberValue(item.play),
    favorites: numberValue(item.favorites ?? item.favorite),
    review: numberValue(item.review ?? item.video_review),
    raw_data: item
  };
}

function toDetailVideo(item) {
  const bvid = stringValue(item.bvid);
  const owner = item.owner || {};
  const stat = item.stat || {};
  return {
    bvid,
    bv_id: bvid,
    bvId: bvid,
    aid: numberValue(item.aid),
    id: numberValue(item.aid),
    cid: numberValue(item.cid),
    title: cleanHtml(stringValue(item.title)),
    name: cleanHtml(stringValue(item.title)),
    desc: cleanHtml(stringValue(item.desc ?? item.description)),
    description: cleanHtml(stringValue(item.desc ?? item.description)),
    content: cleanHtml(stringValue(item.desc ?? item.description)),
    owner: {
      mid: numberValue(owner.mid),
      name: stringValue(owner.name ?? owner.uname),
      uname: stringValue(owner.uname ?? owner.name)
    },
    pubdate: numberValue(item.pubdate),
    ctime: numberValue(item.ctime),
    reply: numberValue(stat.reply),
    stat: {
      view: numberValue(stat.view),
      reply: numberValue(stat.reply),
      favorite: numberValue(stat.favorite),
      coin: numberValue(stat.coin),
      share: numberValue(stat.share),
      like: numberValue(stat.like)
    },
    raw_data: item
  };
}

function toReply(item, rootId = "") {
  const member = item.member || {};
  const message = stringValue(item.content?.message ?? item.message ?? item.content);
  const rpid = stringValue(item.rpid ?? item.id ?? item.comment_id);
  const parent = stringValue(item.parent ?? rootId ?? "0");
  const root = stringValue(item.root ?? rootId ?? parent);
  return {
    rpid,
    id: rpid,
    comment_id: rpid,
    parent,
    root,
    content: { message },
    message,
    member: {
      mid: stringValue(member.mid),
      uname: stringValue(member.uname ?? member.name),
      name: stringValue(member.name ?? member.uname)
    },
    like: numberValue(item.like),
    ctime: numberValue(item.ctime),
    rcount: numberValue(item.rcount),
    raw_data: item
  };
}

async function buildWbiCommentEndpoint({ oid, page, pageSize, cursor }, auth) {
  const params = {
    oid,
    type: 1,
    mode: 2,
    plat: 1,
    web_location: 1315875,
    ps: Math.max(1, Math.min(pageSize, 50)),
    wts: Math.round(Date.now() / 1000)
  };
  if (cursor) {
    params.pagination_str = JSON.stringify({ offset: cursor });
  } else if (page > 1) {
    params.pagination_str = `{"offset":"{\\"type\\":1,\\"direction\\":1,\\"Data\\":{\\"cursor\\":${page - 1}}}"}`;
  }
  const signed = await signWbiParams(params, auth);
  const url = new URL("https://api.bilibili.com/x/v2/reply/wbi/main");
  for (const [key, value] of Object.entries(signed)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function signWbiParams(params, auth) {
  const mixinKey = await getWbiMixinKey(auth);
  const cleaned = {};
  for (const key of Object.keys(params).sort()) {
    const value = String(params[key]).replace(/[!'()*]/g, "");
    cleaned[key] = value;
  }
  const query = new URLSearchParams(cleaned).toString();
  return {
    ...params,
    w_rid: createHash("md5").update(`${query}${mixinKey}`).digest("hex")
  };
}

async function getWbiMixinKey(auth) {
  const now = Date.now();
  if (wbiKeyCache && wbiKeyCache.expiresAt > now) return wbiKeyCache.mixinKey;
  const payload = await bilibiliApi("/x/web-interface/nav", {}, auth);
  const wbiImg = payload.data?.wbi_img || {};
  const imgKey = extractWbiKey(wbiImg.img_url);
  const subKey = extractWbiKey(wbiImg.sub_url);
  if (!imgKey || !subKey) {
    throw httpError(502, "UPSTREAM_ERROR", "Cannot resolve Bilibili WBI keys.");
  }
  const rawKey = `${imgKey}${subKey}`;
  const mixinKey = WBI_MIXIN_KEY_ENC_TAB.map((index) => rawKey[index] || "").join("").slice(0, 32);
  if (!mixinKey) throw httpError(502, "UPSTREAM_ERROR", "Cannot build Bilibili WBI mixin key.");
  wbiKeyCache = {
    mixinKey,
    expiresAt: now + 6 * 60 * 60 * 1000
  };
  return mixinKey;
}

function extractWbiKey(value) {
  const text = stringValue(value);
  if (!text) return "";
  const filename = text.split("/").pop() || "";
  return filename.split(".")[0] || "";
}

function extractWbiNextCursor(data) {
  const cursor = data?.cursor || {};
  const paginationReply = cursor.pagination_reply || {};
  const candidates = [
    paginationReply.next_offset,
    paginationReply.nextOffset,
    cursor.next_offset,
    cursor.nextOffset,
    data.next_offset,
    data.nextOffset
  ];
  for (const value of candidates) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function isWbiCursorEnded(data) {
  const cursor = data?.cursor || {};
  const paginationReply = cursor.pagination_reply || {};
  return Boolean(
    cursor.is_end ||
      cursor.isEnd ||
      paginationReply.is_end ||
      paginationReply.isEnd ||
      data?.is_end ||
      data?.isEnd
  );
}

function hasMoreByPage(page, pn, ps) {
  const total = numberValue(page?.count);
  if (!total) return false;
  return pn * ps < total;
}

function sortOrderFromLabel(label, fallback) {
  const normalized = String(label || "").trim().toLowerCase();
  if (normalized === "latest") return "pubdate";
  if (normalized === "hot") return "click";
  return fallback;
}

async function persistCookieHeader(cookie) {
  await mkdir(path.dirname(COOKIES_PATH), { recursive: true });
  await writeFile(COOKIES_PATH, JSON.stringify({ cookie, updatedAt: new Date().toISOString() }, null, 2));
  serviceLog("info", "cookies", "Persisted Bilibili cookie.", { cookiesPath: COOKIES_PATH });
}

async function clearPersistedAuth(source) {
  await persistCookieHeader("");
  await persistStorage([], source);
}

async function persistStorage(storage, source) {
  await mkdir(path.dirname(STORAGE_PATH), { recursive: true });
  await writeFile(STORAGE_PATH, JSON.stringify(storage, null, 2));
  serviceLog("info", "storage", `Persisted ${storage.length} Bilibili storage origins.`, { source, storagePath: STORAGE_PATH });
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

async function exportViewerStorage(domains) {
  const payload = await fetchRuntimeJson(
    "/browser/storage/export",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains })
    },
    BROWSER_RUNTIME_TIMEOUT_MS
  );
  const data = payload?.data || payload;
  return Array.isArray(data?.storage) ? data.storage : [];
}

function cookiesToHeader(cookies) {
  const pairs = [];
  const seen = new Set();
  for (const cookie of cookies) {
    const name = stringValue(cookie?.name);
    const value = stringValue(cookie?.value);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    pairs.push(`${name}=${value}`);
  }
  return pairs.join("; ");
}

async function fetchRuntimeJson(endpoint, init = {}, timeoutMs = BROWSER_RUNTIME_TIMEOUT_MS) {
  const response = await fetchWithTimeout(new URL(endpoint, VIEWER_RUNTIME_URL), init, timeoutMs);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || (data && data.success === false)) {
    const message = data?.error?.message || data?.message || `Runtime ${endpoint} failed: HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function loadCookieHeader() {
  try {
    const raw = await readFile(COOKIES_PATH, "utf8");
    if (!raw.trim()) return "";
    if (raw.trim().startsWith("{")) {
      const payload = JSON.parse(raw);
      return String(payload.cookie || "");
    }
    return raw.trim();
  } catch {
    return "";
  }
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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function serviceLog(level, source, message, meta = {}) {
  const entry = { seq: ++serviceLogSeq, time: new Date().toISOString(), level, source, message, meta };
  serviceLogs.push(entry);
  while (serviceLogs.length > SERVICE_LOG_LIMIT) serviceLogs.shift();
  console.log(`[bilibili:${level}:${source}] ${message}${Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ""}`);
}

function serviceLogsSince(since, limit) {
  return serviceLogs.filter((entry) => entry.seq > since).slice(-Math.max(1, Math.min(500, limit)));
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function extractBvid(value) {
  const text = String(value || "");
  const match = /(BV[0-9A-Za-z]+)/.exec(text);
  return match?.[1] || "";
}

function cleanHtml(value) {
  return value.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").trim();
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function numberValue(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLimit(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizePositiveEnv(name, fallback) {
  const parsed = Number(process.env[name] || fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
