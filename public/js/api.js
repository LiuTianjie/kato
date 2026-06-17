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
    window.dispatchEvent(new CustomEvent("kato:unauthorized", { detail: { path, message: error.message } }));
    throw error;
  }
  if (!response.ok) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
  return data;
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
  login: (token) => api("/api/auth/login", { method: "POST", body: { token }, headers: {} }),
  getAuthStatus: () => api("/api/auth/status"),
  getDashboard: () => api("/api/dashboard"),
  getPlatforms: () => api("/api/platforms"),
  getPlatformLoginStatuses: () => api("/api/platforms/login-status"),
  getPlatformWorkerStatuses: () => api("/api/platforms/worker-status"),
  getInteractions: (params) => api(`/api/interactions?${params}`),
  getDebugScreenshots: () => api("/api/debug-screenshots?limit=48"),
  getMcpStatus: () => api("/api/mcp/login-status"),
  restartMcpBrowser: () => api("/api/mcp/browser/restart", { method: "POST" }),
  openBrowserViewer: (body = {}) => api("/api/browser-viewer/open", { method: "POST", body }),
  sendBrowserViewerAction: (body = {}) => api("/api/browser-viewer/action", { method: "POST", body }),
  syncBrowserViewerCookies: () => api("/api/browser-viewer/sync-cookies", { method: "POST" }),
  syncPlatformCookies: (platform) => api("/api/platforms/sync-cookies", { method: "POST", body: { platform } }),
  recoverPlatformWorker: (platform) => api("/api/platforms/worker/recover", { method: "POST", body: { platform } }),
  getOperation: (id) => api(`/api/operations/${id}`),
  cancelOperation: (id) => api(`/api/operations/${id}/cancel`, { method: "POST" }),
  getPersona: () => api("/api/account-persona"),
  savePersona: (body) => api("/api/account-persona", { method: "POST", body }),
  getContentProjects: () => api("/api/content-projects?limit=30"),
  getContentProject: (id) => api(`/api/content-projects/${id}`),
  startContentProject: (body) => api("/api/content-projects", { method: "POST", body }),
  saveContentDraft: (id, body) => api(`/api/content-drafts/${id}`, { method: "POST", body }),
  updateContentDraftStatus: (id, status) => api(`/api/content-drafts/${id}/status`, { method: "POST", body: { status } }),
  publishContentDraft: (id) => api(`/api/content-drafts/${id}/publish`, { method: "POST", body: { async: true } }),
  searchPosts: (body) => api("/api/post-search", { method: "POST", body }),
  startRun: (body) => api("/api/runs", { method: "POST", body }),
  syncNotes: (body) => api("/api/notes/sync", { method: "POST", body }),
  generateComments: (ids) => api("/api/interactions/generate", { method: "POST", body: { ids, async: true } }),
  generateAndPublish: (ids) => api("/api/interactions/generate-publish", { method: "POST", body: { ids, async: true } }),
  updateInteractionStatus: (ids, status) => api("/api/interactions/status", { method: "POST", body: { ids, status } }),
  publishInteractions: (ids) => api("/api/interactions/publish", { method: "POST", body: { ids, async: true } }),
  saveDraft: (id, draftComment) => api("/api/interactions/draft", { method: "POST", body: { id, draftComment } }),
  updateNoteStatus: (id, status) => api("/api/notes/status", { method: "POST", body: { id, status } }),
};
