import { createServer } from "node:http";
import { connect as connectTcp } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const PORT = numberEnv(["BROWSER_RUNTIME_PORT", "XHS_BROWSER_RUNTIME_PORT"], 18100);
const RUNTIME_NAME = stringEnv(["BROWSER_RUNTIME_NAME", "KATO_BROWSER_RUNTIME_NAME"], `runtime:${PORT}`);
const DISPLAY = stringEnv(["BROWSER_DISPLAY", "XHS_DISPLAY"], ":99");
const DISPLAY_SIZE = stringEnv(["BROWSER_DISPLAY_SIZE", "XHS_DISPLAY_SIZE"], "1440x980x24");
const VNC_ENABLED = stringEnv(["BROWSER_VNC_ENABLED", "XHS_VNC_ENABLED"], "1") !== "0";
const VNC_PORT = numberEnv(["BROWSER_VNC_PORT", "XHS_VNC_PORT"], 5900);
const NOVNC_PORT = numberEnv(["BROWSER_NOVNC_PORT", "XHS_NOVNC_PORT"], 6080);
const CDP_HOST = stringEnv(["BROWSER_CDP_HOST", "XHS_CDP_HOST"], "127.0.0.1");
const CDP_PORT = numberEnv(["BROWSER_CDP_PORT", "XHS_INTERNAL_CDP_PORT", "XHS_CDP_PORT"], 9224);
const BROWSER_BIN = stringEnv(["BROWSER_BIN", "XHS_BROWSER_BIN", "CHROME_BIN"], "/usr/local/bin/kato-chromium");
const CHROME_USER = stringEnv(["BROWSER_CHROME_USER", "XHS_CHROME_USER"], "kato");
const DEFAULT_DATA_DIR = path.join(process.cwd(), "data", "browser-runtime");
const PROFILE_DIR = stringEnv(["BROWSER_PROFILE_DIR", "XHS_PROFILE_DIR"], path.join(DEFAULT_DATA_DIR, "profile"));
const COOKIES_PATH = stringEnv(["BROWSER_COOKIES_PATH", "COOKIES_PATH"], path.join(DEFAULT_DATA_DIR, "cookies.json"));
const COOKIE_MIRROR_PATHS = uniquePaths([
  COOKIES_PATH,
  ...stringEnv(["BROWSER_COOKIE_MIRROR_PATHS"], "").split(",").map((item) => item.trim()).filter(Boolean)
]);
const HEADLESS = stringEnv(["BROWSER_HEADLESS", "XHS_CHROMIUM_HEADLESS"], "0") === "1";
const CHROME_NO_SANDBOX = stringEnv(["BROWSER_CHROME_NO_SANDBOX", "XHS_CHROME_NO_SANDBOX"], "1") === "1";
const ENABLE_WEBGL = stringEnv(["BROWSER_ENABLE_WEBGL", "XHS_ENABLE_WEBGL"], "1") !== "0";
const WEBGL_BACKEND = stringEnv(["BROWSER_WEBGL_BACKEND", "XHS_WEBGL_BACKEND"], "swiftshader");
const BLOCK_EXTERNAL_PROTOCOLS = stringEnv(["BROWSER_BLOCK_EXTERNAL_PROTOCOLS"], "1") !== "0";
const FINGERPRINT_ENABLED = stringEnv(["BROWSER_FINGERPRINT_ENABLED", "XHS_BROWSER_FINGERPRINT_ENABLED"], "1") !== "0";
const FINGERPRINT_INTERVAL_MS = numberEnv(["BROWSER_FINGERPRINT_INTERVAL_MS"], 2_000);
const EXTERNAL_PROTOCOL_SCHEMES = stringEnv(
  ["BROWSER_EXTERNAL_PROTOCOL_SCHEMES"],
  "douyin,snssdk1128,snssdk2329,snssdk1233,aweme,bytedance,iesdouyin,xhsdiscover,xiaohongshu,bilibili,bilibiliapp,intent"
)
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const ACCEPT_LANGUAGE = stringEnv(["BROWSER_ACCEPT_LANGUAGE", "XHS_BROWSER_ACCEPT_LANGUAGE"], "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7");
const NAVIGATOR_PLATFORM = stringEnv(["BROWSER_NAVIGATOR_PLATFORM", "XHS_NAVIGATOR_PLATFORM"], "Win32");
const WINDOWS_PLATFORM_VERSION = stringEnv(["BROWSER_PLATFORM_VERSION", "XHS_BROWSER_PLATFORM_VERSION"], "10.0.0");
const BROWSER_VERSION = detectChromeVersion();
const BROWSER_MAJOR_VERSION = stringEnv(["BROWSER_MAJOR_VERSION", "XHS_BROWSER_MAJOR_VERSION"], BROWSER_VERSION.major);
const USER_AGENT =
  stringEnv(["BROWSER_USER_AGENT", "XHS_BROWSER_USER_AGENT"], "") ||
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION.full} Safari/537.36`;
const USER_AGENT_METADATA = {
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
const START_TIMEOUT_MS = numberEnv(["BROWSER_START_TIMEOUT_MS", "XHS_HEALTH_ENSURE_TIMEOUT_MS"], 20_000);
const RESTART_TIMEOUT_MS = numberEnv(["BROWSER_RESTART_TIMEOUT_MS", "XHS_BROWSER_RESTART_TIMEOUT_MS"], 120_000);
const PROCESS_EXIT_GRACE_MS = numberEnv(["BROWSER_PROCESS_EXIT_GRACE_MS", "XHS_PROCESS_EXIT_GRACE_MS"], 2_000);
const LOG_LIMIT = numberEnv(["BROWSER_RUNTIME_LOG_LIMIT", "XHS_SERVICE_LOG_LIMIT"], 800);
const LEASE_DEFAULT_WAIT_MS = numberEnv(["BROWSER_LEASE_DEFAULT_WAIT_MS"], 120_000);
const LEASE_DEFAULT_TTL_MS = numberEnv(["BROWSER_LEASE_DEFAULT_TTL_MS"], 900_000);

let logSeq = 0;
const logs = [];
let xvfbProcess;
let vncSupervisor;
let noVncSupervisor;
let chromeProcess;
let restartPromise;
let ensureBrowserPromise;
let activeLease;
let fingerprintSupervisorTimer;
let fingerprintedTargets = new Set();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const ensure = url.searchParams.get("ensure") === "1";
      const status = ensure ? await ensureRuntimeReady() : await runtimeStatus();
      const ok = status.chrome.running && status.cdp.ready && (!VNC_ENABLED || (status.vnc.ready && status.noVnc.ready));
      sendJson(res, ensure && !ok ? 503 : 200, { ok: ensure ? ok : true, service: "kato-browser-runtime", runtime: status });
      return;
    }

    if (req.method === "POST" && url.pathname === "/browser/lease/acquire") {
      const body = await readJson(req);
      const lease = await acquireLease({
        owner: String(body.owner || "unknown"),
        label: String(body.label || "browser-task"),
        waitMs: normalizeNonNegativeNumber(body.waitMs, LEASE_DEFAULT_WAIT_MS),
        ttlMs: normalizePositiveNumber(body.ttlMs, LEASE_DEFAULT_TTL_MS)
      });
      sendJson(res, 200, { success: true, data: lease });
      return;
    }

    if (req.method === "POST" && url.pathname === "/browser/lease/release") {
      const body = await readJson(req);
      const released = releaseLease(String(body.leaseId || ""));
      sendJson(res, released ? 200 : 409, {
        success: released,
        data: { released },
        error: released ? undefined : { code: "LEASE_MISMATCH", message: "Lease is not active." }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/browser/open") {
      const body = await readJson(req);
      const status = await ensureRuntimeReady();
      const targetUrl = normalizeViewerUrl(String(body.url || ""));
      if (targetUrl) await navigateViewerUrl(targetUrl);
      sendJson(res, 200, {
        success: true,
        data: {
          opened: true,
          url: targetUrl,
          viewer: "novnc",
          viewerUrl: "/novnc/vnc.html?autoconnect=1&resize=scale&path=novnc/websockify",
          runtime: status
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/browser/restart") {
      const body = await readJson(req);
      const reason = String(body.reason || "manual");
      assertLeaseAccess(body.leaseId, "restart");
      const data = await restartBrowser(reason);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/browser/action") {
      const body = await readJson(req);
      assertLeaseAccess(body.leaseId, "browser action");
      await ensureRuntimeReady();
      await runBrowserAction(body);
      sendJson(res, 200, { success: true, data: { ok: true } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/browser/cookies/export") {
      await ensureRuntimeReady();
      const body = await readJson(req);
      const domains = Array.isArray(body.domains) ? body.domains.map((item) => String(item)).filter(Boolean) : [];
      const cookies = await exportCookies(domains);
      serviceLog("info", "cookies", `Exported ${cookies.length} browser cookies.`, { domains });
      sendJson(res, 200, { success: true, data: { exportedCookies: cookies.length, cookies } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/browser/storage/export") {
      await ensureRuntimeReady();
      const body = await readJson(req);
      const domains = Array.isArray(body.domains) ? body.domains.map((item) => String(item)).filter(Boolean) : [];
      const origins = Array.isArray(body.origins) ? body.origins.map((item) => String(item)).filter(Boolean) : [];
      const storage = await exportBrowserStorage({ domains, origins });
      serviceLog("info", "storage", `Exported ${storage.length} browser storage origins.`, { domains, origins });
      sendJson(res, 200, { success: true, data: { exportedOrigins: storage.length, storage } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/browser/cookies/sync") {
      const body = await readJson(req);
      assertLeaseAccess(body.leaseId, "cookie sync");
      await ensureRuntimeReady();
      const domains = Array.isArray(body.domains) ? body.domains.map((item) => String(item)).filter(Boolean) : [];
      const cookies = await exportCookies(domains);
      await persistCookies(cookies);
      serviceLog("info", "cookies", `Persisted ${cookies.length} browser cookies.`, { cookiesPath: COOKIES_PATH, domains });
      sendJson(res, 200, { success: true, data: { cookiesPath: COOKIES_PATH, exportedCookies: cookies.length } });
      return;
    }

    if (req.method === "GET" && url.pathname === "/browser/logs") {
      const since = Number(url.searchParams.get("since") || 0);
      const limit = Number(url.searchParams.get("limit") || 200);
      sendJson(res, 200, { success: true, data: { logs: logsSince(since, limit), cursor: logSeq } });
      return;
    }

    sendJson(res, 404, { success: false, error: { code: "NOT_FOUND", message: "Endpoint not found." } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    serviceLog("error", "request", `${req.method || "GET"} ${req.url || "/"} failed: ${message}`);
    const status = Number(error?.statusCode || 500);
    sendJson(res, status, { success: false, error: { code: status === 423 ? "BROWSER_BUSY" : "INTERNAL_ERROR", message } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  serviceLog("info", "runtime", `${RUNTIME_NAME} listening on http://127.0.0.1:${PORT}`);
});

startDisplayRuntime().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  serviceLog("error", "runtime", `Display runtime failed to start: ${message}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function startDisplayRuntime() {
  await ensureRuntimeDirs();
  if (!xvfbProcess) {
    xvfbProcess = spawn("Xvfb", [DISPLAY, "-screen", "0", DISPLAY_SIZE, "-ac", "+extension", "RANDR"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    captureChildLogs(xvfbProcess, "xvfb");
    xvfbProcess.on("exit", (code) => {
      serviceLog("error", "xvfb", `Xvfb exited with code ${code ?? "unknown"}.`);
      xvfbProcess = undefined;
    });
    await delay(500);
  }

  if (VNC_ENABLED) {
    if (!vncSupervisor) vncSupervisor = startSupervisor("x11vnc", () => [
      "-display",
      DISPLAY,
      "-forever",
      "-shared",
      "-nopw",
      "-localhost",
      "-listen",
      "127.0.0.1",
      "-rfbport",
      String(VNC_PORT),
      "-quiet"
    ]);
    if (!noVncSupervisor) noVncSupervisor = startSupervisor("websockify", () => [
      "--web=/usr/share/novnc",
      `127.0.0.1:${NOVNC_PORT}`,
      `127.0.0.1:${VNC_PORT}`
    ]);
  }
}

function startSupervisor(command, argsFactory) {
  const supervisor = { stopped: false, child: undefined };
  const run = () => {
    if (supervisor.stopped) return;
    const child = spawn(command, argsFactory(), { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DISPLAY } });
    supervisor.child = child;
    captureChildLogs(child, command);
    child.on("exit", (code) => {
      if (supervisor.stopped) return;
      serviceLog("warn", command, `${command} exited with code ${code ?? "unknown"}; restarting in 1s.`);
      setTimeout(run, 1_000).unref();
    });
  };
  run();
  return supervisor;
}

async function ensureRuntimeReady() {
  await startDisplayRuntime();
  await ensureBrowser();
  const deadline = Date.now() + START_TIMEOUT_MS;
  let status = await runtimeStatus();
  while (Date.now() < deadline) {
    if (status.chrome.running && status.cdp.ready && (!VNC_ENABLED || (status.vnc.ready && status.noVnc.ready))) return status;
    await delay(250);
    status = await runtimeStatus();
  }
  throw new Error(`Browser runtime not ready: ${JSON.stringify(status)}`);
}

async function runtimeStatus() {
  const cdp = await isHttpReady(`http://127.0.0.1:${CDP_PORT}/json/version`, 600);
  const managedChromeRunning = Boolean(chromeProcess && chromeProcess.exitCode === null && chromeProcess.signalCode === null);
  return {
    name: RUNTIME_NAME,
    display: { value: DISPLAY, running: Boolean(xvfbProcess && xvfbProcess.exitCode === null && xvfbProcess.signalCode === null) },
    chrome: {
      running: managedChromeRunning || cdp.ok,
      managed: managedChromeRunning,
      pid: chromeProcess?.pid,
      profileDir: PROFILE_DIR,
      bin: BROWSER_BIN
    },
    cdp: {
      host: CDP_HOST,
      port: CDP_PORT,
      ready: cdp.ok,
      internal: true,
      error: cdp.error
    },
    vnc: {
      enabled: VNC_ENABLED,
      host: "127.0.0.1",
      port: VNC_PORT,
      ready: VNC_ENABLED ? await isTcpReady(VNC_PORT, "127.0.0.1", 600) : false
    },
    noVnc: {
      enabled: VNC_ENABLED,
      host: "127.0.0.1",
      port: NOVNC_PORT,
      ready: VNC_ENABLED ? (await isHttpReady(`http://127.0.0.1:${NOVNC_PORT}/vnc.html`, 600)).ok : false
    },
    logs: { cursor: logSeq },
    lease: leaseSummary()
  };
}

async function acquireLease({ owner, label, waitMs, ttlMs }) {
  const deadline = Date.now() + waitMs;
  while (true) {
    pruneExpiredLease();
    if (!activeLease) {
      activeLease = {
        leaseId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        owner,
        label,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        ttlMs
      };
      serviceLog("info", "lease", "Browser lease acquired.", activeLease);
      return activeLease;
    }
    if (Date.now() >= deadline) {
      const holder = `${activeLease.owner}:${activeLease.label}`;
      throw httpError(423, `Browser runtime is busy; active lease held by ${holder}.`);
    }
    await delay(250);
  }
}

function releaseLease(leaseId) {
  pruneExpiredLease();
  if (!activeLease || activeLease.leaseId !== leaseId) return false;
  serviceLog("info", "lease", "Browser lease released.", activeLease);
  activeLease = undefined;
  return true;
}

function assertLeaseAccess(leaseId, action) {
  pruneExpiredLease();
  if (!activeLease) return;
  if (leaseId && activeLease.leaseId === leaseId) return;
  const holder = `${activeLease.owner}:${activeLease.label}`;
  throw httpError(423, `Browser runtime ${action} is blocked by active lease ${holder}.`);
}

function pruneExpiredLease() {
  if (!activeLease) return;
  if (Date.parse(activeLease.expiresAt) > Date.now()) return;
  serviceLog("warn", "lease", "Browser lease expired.", activeLease);
  activeLease = undefined;
}

function leaseSummary() {
  pruneExpiredLease();
  if (!activeLease) return { active: false };
  return { active: true, ...activeLease };
}

async function ensureBrowser() {
  if (ensureBrowserPromise) return ensureBrowserPromise;
  ensureBrowserPromise = (async () => {
    const running = chromeProcess && chromeProcess.exitCode === null && chromeProcess.signalCode === null;
    const cdpReady = (await isHttpReady(`http://127.0.0.1:${CDP_PORT}/json/version`, 600)).ok;
    if (running && cdpReady) {
      startFingerprintSupervisor();
      return;
    }
    if (!running && cdpReady) {
      serviceLog("warn", "chrome", "CDP is already ready but runtime has no Chrome process handle; reusing existing browser.", {
        cdp: `${CDP_HOST}:${CDP_PORT}`,
        profileDir: PROFILE_DIR
      });
      await applyFingerprintToAllPageTargets("reuse").catch((error) => {
        serviceLog("warn", "fingerprint", `Browser fingerprint apply on reused CDP failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      startFingerprintSupervisor();
      return;
    }
    if (running && !cdpReady) {
      terminateProcess(chromeProcess, "CDP not ready");
      await waitForProcessExit(chromeProcess, PROCESS_EXIT_GRACE_MS + 500).catch(() => undefined);
      chromeProcess = undefined;
    }
    await launchChrome();
  })().finally(() => {
    ensureBrowserPromise = undefined;
  });
  return ensureBrowserPromise;
}

async function launchChrome() {
  await ensureRuntimeDirs();
  await clearStaleProfileLocks();
  const args = [
    ...(HEADLESS ? ["--headless=new"] : []),
    ...(CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
    ...webglArgs(),
    "--disable-dev-shm-usage",
    "--disable-notifications",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-blink-features=AutomationControlled",
    "--password-store=basic",
    "--window-size=1440,980",
    `--user-agent=${USER_AGENT}`,
    "--accept-lang=zh-CN,zh,en-US,en",
    `--remote-debugging-address=${CDP_HOST}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--lang=zh-CN",
    `--user-data-dir=${PROFILE_DIR}`,
    "about:blank"
  ];
  serviceLog("info", "chrome", "Starting Chrome process.", { bin: BROWSER_BIN, cdp: `${CDP_HOST}:${CDP_PORT}`, display: DISPLAY, profileDir: PROFILE_DIR });
  const child = spawn(BROWSER_BIN, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DISPLAY }, detached: true });
  chromeProcess = child;
  captureChildLogs(child, "chrome");
  child.on("exit", (code) => {
    serviceLog("error", "chrome", `Chrome exited with code ${code ?? "unknown"}.`);
    if (chromeProcess === child) {
      chromeProcess = undefined;
      stopFingerprintSupervisor();
    }
  });
  await waitForCdpHttp(START_TIMEOUT_MS);
  fingerprintedTargets = new Set();
  await applyFingerprintToAllPageTargets("launch").catch((error) => {
    serviceLog("warn", "fingerprint", `Initial browser fingerprint apply failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  startFingerprintSupervisor();
}

function webglArgs() {
  if (!ENABLE_WEBGL) return [];
  const base = [
    "--enable-webgl",
    "--enable-webgl2",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox"
  ];
  if (WEBGL_BACKEND === "swiftshader") {
    return [...base, "--use-gl=angle", "--use-angle=swiftshader"];
  }
  if (WEBGL_BACKEND) return [...base, `--use-gl=${WEBGL_BACKEND}`];
  return base;
}

async function restartBrowser(reason = "manual") {
  if (restartPromise) return restartPromise;
  restartPromise = withTimeout((async () => {
    serviceLog("warn", "chrome", `Restarting Chrome: ${reason}`);
    const oldProcess = chromeProcess;
    chromeProcess = undefined;
    stopFingerprintSupervisor();
    fingerprintedTargets = new Set();
    if (oldProcess) {
      terminateProcess(oldProcess, reason);
      await waitForProcessExit(oldProcess, PROCESS_EXIT_GRACE_MS + 500).catch(() => undefined);
    }
    await waitForCdpClosed(3_000).catch(() => undefined);
    await delay(800);
    await ensureBrowser();
    return { restarted: true, reason, runtime: await runtimeStatus() };
  })(), RESTART_TIMEOUT_MS, "Browser runtime restart timed out.").finally(() => {
    restartPromise = undefined;
  });
  return restartPromise;
}

async function runBrowserAction(body) {
  const action = String(body.action || "");
  if (action === "navigate") {
    await navigateViewerUrl(normalizeViewerUrl(String(body.url || "")));
    return;
  }
  if (action === "back") {
    await runXdotool(["key", "--clearmodifiers", "Alt+Left"]);
    return;
  }
  if (action === "forward") {
    await runXdotool(["key", "--clearmodifiers", "Alt+Right"]);
    return;
  }
  if (action === "reload") {
    await runXdotool(["key", "--clearmodifiers", "F5"]);
    return;
  }
  throw new Error("Unsupported browser action.");
}

async function navigateViewerUrl(url) {
  if (!url) return;
  try {
    await navigateWithCdp(url);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    serviceLog("warn", "browser", `CDP viewer navigation failed; falling back to keyboard navigation: ${message}`, { url });
  }
  await navigateWithXdotool(url);
}

async function navigateWithCdp(url) {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const pages = Array.isArray(targets) ? targets.filter((item) => item?.type === "page" && item.webSocketDebuggerUrl) : [];
  const page = pickViewerPageTarget(pages);
  if (!page?.webSocketDebuggerUrl) throw new Error("No Chrome page target is available.");
  await applyFingerprintToPageTarget(page, "navigate").catch((error) => {
    serviceLog("warn", "fingerprint", `Viewer fingerprint apply failed before navigation: ${error instanceof Error ? error.message : String(error)}`);
  });
  await sendCdpCommand(page.webSocketDebuggerUrl, "Page.enable", {}).catch(() => undefined);
  await sendCdpCommand(page.webSocketDebuggerUrl, "Page.bringToFront", {}).catch(() => undefined);
  await sendCdpCommand(page.webSocketDebuggerUrl, "Page.navigate", { url });
  serviceLog("info", "browser", "Navigated viewer page via internal CDP.", { url });
}

function pickViewerPageTarget(pages) {
  const normalPages = pages.filter((page) => {
    const value = String(page.url || "");
    return !value.startsWith("devtools://") && !value.startsWith("chrome-extension://");
  });
  return normalPages.at(-1) || pages.at(-1);
}

function startFingerprintSupervisor() {
  if (!FINGERPRINT_ENABLED || fingerprintSupervisorTimer) return;
  fingerprintSupervisorTimer = setInterval(() => {
    applyFingerprintToAllPageTargets("supervisor").catch((error) => {
      serviceLog("warn", "fingerprint", `Browser fingerprint supervisor failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, FINGERPRINT_INTERVAL_MS);
  fingerprintSupervisorTimer.unref?.();
}

function stopFingerprintSupervisor() {
  if (!fingerprintSupervisorTimer) return;
  clearInterval(fingerprintSupervisorTimer);
  fingerprintSupervisorTimer = undefined;
}

async function applyFingerprintToAllPageTargets(reason) {
  if (!FINGERPRINT_ENABLED) return;
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const pages = Array.isArray(targets) ? targets.filter((item) => item?.type === "page" && item.webSocketDebuggerUrl) : [];
  await Promise.all(pages.map((page) => applyFingerprintToPageTarget(page, reason)));
}

async function applyFingerprintToPageTarget(page, reason) {
  if (!FINGERPRINT_ENABLED || !page?.webSocketDebuggerUrl) return;
  const targetKey = String(page.id || page.webSocketDebuggerUrl);
  const alreadyInitialized = fingerprintedTargets.has(targetKey);
  await sendCdpCommand(page.webSocketDebuggerUrl, "Network.enable", {}).catch(() => undefined);
  await setUserAgentOverride(page.webSocketDebuggerUrl);
  await sendCdpCommand(page.webSocketDebuggerUrl, "Emulation.setLocaleOverride", { locale: "zh-CN" }).catch(() => undefined);
  await sendCdpCommand(page.webSocketDebuggerUrl, "Page.enable", {}).catch(() => undefined);
  const source = browserFingerprintSource();
  if (!alreadyInitialized) {
    await sendCdpCommand(page.webSocketDebuggerUrl, "Page.addScriptToEvaluateOnNewDocument", { source });
    fingerprintedTargets.add(targetKey);
    serviceLog("info", "fingerprint", "Applied browser fingerprint init script.", {
      target: targetKey,
      reason,
      platform: NAVIGATOR_PLATFORM,
      userAgent: redactUserAgent(USER_AGENT)
    });
  }
  await sendCdpCommand(page.webSocketDebuggerUrl, "Runtime.enable", {}).catch(() => undefined);
  await sendCdpCommand(page.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: source,
    awaitPromise: false,
    returnByValue: true
  }).catch((error) => {
    serviceLog("warn", "fingerprint", `Runtime fingerprint patch failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function setUserAgentOverride(webSocketDebuggerUrl) {
  const params = {
    userAgent: USER_AGENT,
    acceptLanguage: ACCEPT_LANGUAGE,
    platform: "Windows",
    userAgentMetadata: USER_AGENT_METADATA
  };
  try {
    await sendCdpCommand(webSocketDebuggerUrl, "Network.setUserAgentOverride", params);
  } catch (error) {
    serviceLog("warn", "fingerprint", `UA metadata override failed; retrying basic UA override: ${error instanceof Error ? error.message : String(error)}`);
    await sendCdpCommand(webSocketDebuggerUrl, "Network.setUserAgentOverride", {
      userAgent: USER_AGENT,
      acceptLanguage: ACCEPT_LANGUAGE,
      platform: "Windows"
    });
  }
}

function browserFingerprintSource() {
  return `(() => {
    const userAgent = ${JSON.stringify(USER_AGENT)};
    const platform = ${JSON.stringify(NAVIGATOR_PLATFORM)};
    const platformVersion = ${JSON.stringify(WINDOWS_PLATFORM_VERSION)};
    const languages = ${JSON.stringify(["zh-CN", "zh", "en-US", "en"])};
    const brands = ${JSON.stringify(USER_AGENT_METADATA.brands)};
    const fullVersionList = ${JSON.stringify(USER_AGENT_METADATA.fullVersionList)};
    const defineGetter = (target, key, value) => {
      try {
        Object.defineProperty(target, key, { get: () => value, configurable: true });
      } catch {}
    };
    defineGetter(Navigator.prototype, "platform", platform);
    defineGetter(Navigator.prototype, "userAgent", userAgent);
    defineGetter(Navigator.prototype, "appVersion", userAgent.replace(/^Mozilla\\//, ""));
    defineGetter(Navigator.prototype, "languages", languages);
    defineGetter(Navigator.prototype, "language", languages[0]);
    defineGetter(Navigator.prototype, "webdriver", undefined);
    defineGetter(Navigator.prototype, "maxTouchPoints", 0);
    defineGetter(Navigator.prototype, "hardwareConcurrency", 12);
    defineGetter(Navigator.prototype, "deviceMemory", 8);
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
  })()`;
}

function redactUserAgent(userAgent) {
  return String(userAgent || "").replace(/Chrome\/[\d.]+/i, "Chrome/[version]");
}

async function navigateWithXdotool(url) {
  if (!url) return;
  await runXdotool(["key", "--clearmodifiers", "ctrl+l"]);
  await runXdotool(["type", "--delay", "12", "--clearmodifiers", url]);
  await runXdotool(["key", "--clearmodifiers", "Return"]);
}

function runXdotool(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("xdotool", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DISPLAY } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("xdotool timed out."));
    }, 10_000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error((stderr || stdout || `xdotool exited with code ${code}`).trim()));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function exportCookies(domains = []) {
  const cookies = await fetchCookiesFromCdp();
  const filters = domains.map((item) => item.toLowerCase());
  if (!filters.length) return cookies;
  return cookies.filter((cookie) => filters.some((filter) => String(cookie.domain || "").toLowerCase().includes(filter)));
}

async function fetchCookiesFromCdp() {
  const version = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  if (version?.webSocketDebuggerUrl) {
    try {
      const storage = await sendCdpCommand(version.webSocketDebuggerUrl, "Storage.getCookies", {});
      if (Array.isArray(storage.cookies)) return storage.cookies;
    } catch (error) {
      serviceLog("warn", "cookies", `Storage.getCookies failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = Array.isArray(targets) ? targets.find((item) => item?.type === "page" && item.webSocketDebuggerUrl) : undefined;
  if (!page?.webSocketDebuggerUrl) return [];
  const network = await sendCdpCommand(page.webSocketDebuggerUrl, "Network.getAllCookies", {});
  return Array.isArray(network.cookies) ? network.cookies : [];
}

async function exportBrowserStorage({ domains = [], origins = [] } = {}) {
  const filters = domains.map((item) => item.toLowerCase());
  const originFilters = origins.map((item) => item.toLowerCase());
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const pages = Array.isArray(targets) ? targets.filter((item) => item?.type === "page" && item.webSocketDebuggerUrl) : [];
  const byOrigin = new Map();
  for (const page of pages) {
    const pageUrl = String(page.url || "");
    if (!/^https?:\/\//i.test(pageUrl)) continue;
    const origin = new URL(pageUrl).origin;
    const host = new URL(pageUrl).hostname.toLowerCase();
    const matched =
      (!filters.length && !originFilters.length) ||
      filters.some((filter) => host === filter.replace(/^\./, "") || host.endsWith(filter.replace(/^\./, ""))) ||
      originFilters.some((filter) => origin.toLowerCase() === filter);
    if (!matched || byOrigin.has(origin)) continue;
    try {
      await sendCdpCommand(page.webSocketDebuggerUrl, "Runtime.enable", {}).catch(() => undefined);
      const result = await sendCdpCommand(page.webSocketDebuggerUrl, "Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const copy = (storage) => {
            const out = {};
            for (let i = 0; i < storage.length; i += 1) {
              const key = storage.key(i);
              out[key] = storage.getItem(key);
            }
            return out;
          };
          return { origin: location.origin, url: location.href, localStorage: copy(localStorage), sessionStorage: copy(sessionStorage) };
        })()`
      });
      const value = result?.result?.value;
      if (value?.origin) byOrigin.set(value.origin, value);
    } catch (error) {
      serviceLog("warn", "storage", `Storage export failed for ${pageUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...byOrigin.values()];
}

function sendCdpCommand(webSocketUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("Node WebSocket API unavailable."));
      return;
    }
    const id = 1;
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP ${method} timed out.`));
    }, 8_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id !== id) return;
      clearTimeout(timeout);
      socket.close();
      if (payload.error) reject(new Error(payload.error.message || `CDP ${method} failed.`));
      else resolve(payload.result || {});
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP websocket failed."));
    });
  });
}

async function persistCookies(cookies) {
  const data = JSON.stringify(cookies, null, 2);
  await Promise.all(
    COOKIE_MIRROR_PATHS.map(async (cookiesPath) => {
      await mkdir(path.dirname(cookiesPath), { recursive: true });
      await writeFile(cookiesPath, data, "utf8");
    })
  );
}

async function ensureRuntimeDirs() {
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(path.dirname(COOKIES_PATH), { recursive: true });
  if (BLOCK_EXTERNAL_PROTOCOLS) {
    await ensureChromeManagedPolicy();
    await ensureChromeProfilePreferences();
  }
  if (CHROME_USER) {
    try {
      execFileSync("chown", ["-R", `${CHROME_USER}:${CHROME_USER}`, PROFILE_DIR, path.dirname(COOKIES_PATH)], {
        stdio: "ignore",
        timeout: 5_000
      });
    } catch {
      // Best effort: containers that do not run as root may not be able to chown.
    }
  }
}

async function clearStaleProfileLocks() {
  await Promise.all(
    ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((name) =>
      rm(path.join(PROFILE_DIR, name), { force: true, recursive: true }).catch(() => undefined)
    )
  );
}

async function ensureChromeManagedPolicy() {
  const policyDir = "/etc/opt/chrome/policies/managed";
  const policyPath = path.join(policyDir, "kato-browser-runtime.json");
  const urlBlocklist = EXTERNAL_PROTOCOL_SCHEMES.map((scheme) => `${scheme}://*`);
  try {
    await mkdir(policyDir, { recursive: true });
    await writeFile(
      policyPath,
      `${JSON.stringify(
        {
          URLBlocklist: urlBlocklist,
          AutoLaunchProtocolsFromOrigins: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  } catch (error) {
    serviceLog("warn", "chrome", `Unable to write Chrome managed policy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function ensureChromeProfilePreferences() {
  const defaultProfileDir = path.join(PROFILE_DIR, "Default");
  const preferencesPath = path.join(defaultProfileDir, "Preferences");
  try {
    await mkdir(defaultProfileDir, { recursive: true });
    const preferences = await readJsonFile(preferencesPath);
    const excludedSchemes = Object.fromEntries(EXTERNAL_PROTOCOL_SCHEMES.map((scheme) => [scheme, true]));
    preferences.protocol_handler = {
      ...(preferences.protocol_handler || {}),
      excluded_schemes: {
        ...(preferences.protocol_handler?.excluded_schemes || {}),
        ...excludedSchemes
      }
    };
    preferences.custom_handlers = {
      ...(preferences.custom_handlers || {}),
      enabled: false
    };
    await writeFile(preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  } catch (error) {
    serviceLog("warn", "chrome", `Unable to write Chrome profile preferences: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function captureChildLogs(child, source) {
  child.stdout?.on("data", (chunk) => captureProcessLog(source, "info", chunk));
  child.stderr?.on("data", (chunk) => captureProcessLog(source, source === "chrome" ? "warn" : "info", chunk));
  child.on("error", (error) => serviceLog("error", source, `${source} process error: ${error.message}`));
}

function captureProcessLog(source, level, chunk) {
  String(chunk || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => serviceLog(level, source, line));
}

function serviceLog(level, source, message, details) {
  const entry = {
    seq: ++logSeq,
    time: new Date().toISOString(),
    level,
    source,
    message: sanitizeLogText(message),
    details: sanitizeLogDetails(details)
  };
  logs.push(entry);
  while (logs.length > LOG_LIMIT) logs.shift();
  const suffix = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
  const line = `[${entry.time}] [${entry.source}] ${entry.level.toUpperCase()} ${entry.message}${suffix}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function logsSince(since, limit) {
  const cursor = Number.isFinite(Number(since)) ? Math.max(0, Math.floor(Number(since))) : 0;
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.floor(Number(limit)))) : 200;
  return logs.filter((entry) => entry.seq > cursor).slice(-max);
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
    return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "string" ? sanitizeLogText(item) : item)));
  } catch {
    return sanitizeLogText(value);
  }
}

async function waitForCdpHttp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).catch(() => null);
    if (response?.ok) return;
    await delay(250);
  }
  throw new Error(`Chrome CDP port ${CDP_PORT} did not become ready.`);
}

async function waitForCdpClosed(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).catch(() => null);
    if (!response?.ok) return;
    await delay(150);
  }
}

async function isHttpReady(url, timeoutMs) {
  try {
    const response = await fetchWithTimeout(url, timeoutMs);
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isTcpReady(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connectTcp(port, host);
    const done = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

function terminateProcess(processRef, reason) {
  if (!processRef || processRef.killed) return;
  serviceLog("warn", "process", `Terminating process ${processRef.pid || ""}: ${reason}`);
  killProcessTree(processRef, "SIGTERM");
  setTimeout(() => {
    if (processRef.exitCode === null && processRef.signalCode === null) {
      serviceLog("error", "process", `Process ${processRef.pid || ""} did not exit after SIGTERM; sending SIGKILL.`);
      killProcessTree(processRef, "SIGKILL");
    }
  }, PROCESS_EXIT_GRACE_MS).unref();
}

function killProcessTree(processRef, signal) {
  if (!processRef?.pid) return;
  try {
    process.kill(-processRef.pid, signal);
  } catch {
    try {
      processRef.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }
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

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeViewerUrl(raw) {
  const value = raw.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectChromeVersion() {
  const fallback = stringEnv(["BROWSER_FULL_VERSION", "XHS_BROWSER_FULL_VERSION"], "137.0.0.0");
  try {
    const output = execFileSync(stringEnv(["GOOGLE_CHROME_BIN"], "/usr/bin/google-chrome-stable"), ["--version"], {
      encoding: "utf8",
      timeout: 2_000
    });
    const version = output.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] || fallback;
    return { full: version, major: version.split(".")[0] || "137" };
  } catch {
    return { full: fallback, major: fallback.split(".")[0] || "137" };
  }
}

function numberEnv(names, fallback) {
  const value = Number(stringEnv(names, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizePositiveNumber(value, fallback) {
  const numberValue = Number(value ?? fallback);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return fallback;
  return Math.floor(numberValue);
}

function normalizeNonNegativeNumber(value, fallback) {
  const numberValue = Number(value ?? fallback);
  if (!Number.isFinite(numberValue) || numberValue < 0) return fallback;
  return Math.floor(numberValue);
}

function stringEnv(names, fallback) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

async function shutdown() {
  server.close();
  stopFingerprintSupervisor();
  if (chromeProcess) terminateProcess(chromeProcess, "shutdown");
  for (const supervisor of [vncSupervisor, noVncSupervisor]) {
    if (!supervisor) continue;
    supervisor.stopped = true;
    supervisor.child?.kill("SIGTERM");
  }
  if (xvfbProcess) terminateProcess(xvfbProcess, "shutdown");
  await delay(250);
  process.exit(0);
}
