const TOKEN_STORAGE_KEY = "kato.apiToken";

export async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = getApiToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (response.status === 401) {
    const error = new Error(data.error?.message || data.message || "需要登录 Kato Console");
    error.status = 401;
    if (shouldLogoutConsole(path, data, options)) {
      window.dispatchEvent(new CustomEvent("kato:unauthorized", { detail: { path, message: error.message } }));
    }
    throw error;
  }
  if (!response.ok) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
  return data;
}

function shouldLogoutConsole(path, data, options = {}) {
  if (options.logoutOnUnauthorized === false) return false;
  const code = data?.error?.code || data?.code || "";
  if (path === "/api/auth/login") return false;
  if (path === "/api/auth/status") return true;
  return code === "UNAUTHORIZED" && /Kato API token|invalid Kato|Missing or invalid/i.test(String(data?.error?.message || data?.message || ""));
}

export function getApiToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
}

export function setApiToken(token) {
  const value = String(token || "").trim();
  if (value) localStorage.setItem(TOKEN_STORAGE_KEY, value);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export const dashboardApi = {
  login: (token) => api("/api/auth/login", { method: "POST", body: { token }, headers: {}, logoutOnUnauthorized: false }),
  getAuthStatus: () => api("/api/auth/status"),
  getPlatforms: () => api("/api/platforms"),
  getPlatformLoginStatuses: () => api("/api/platforms/login-status"),
  getPlatformWorkerStatuses: () => api("/api/platforms/worker-status"),
  openBrowserViewer: (body = {}) => api("/api/browser-viewer/open", { method: "POST", body }),
  sendBrowserViewerAction: (body = {}) => api("/api/browser-viewer/action", { method: "POST", body }),
  syncPlatformCookies: (platform) => api("/api/platforms/sync-cookies", { method: "POST", body: { platform } }),
  clearPlatformAuth: (platform) => api("/api/platforms/clear-auth", { method: "POST", body: { platform } }),
  resetPlatformProfile: (body = {}) => api("/api/platforms/profile-reset", { method: "POST", body }),
  recoverPlatformWorker: (platform) => api("/api/platforms/worker/recover", { method: "POST", body: { platform } }),
};
