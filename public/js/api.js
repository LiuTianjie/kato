export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export const dashboardApi = {
  getDashboard: () => api("/api/dashboard"),
  getInteractions: (params) => api(`/api/interactions?${params}`),
  getDebugScreenshots: () => api("/api/debug-screenshots?limit=48"),
  getMcpStatus: () => api("/api/mcp/login-status"),
  restartMcpBrowser: () => api("/api/mcp/browser/restart", { method: "POST" }),
  openCdpLogin: (body = {}) => api("/api/cdp-login/open", { method: "POST", body }),
  getCdpTarget: () => api("/api/cdp-login/target?ensure=1"),
  getCdpFrame: (params = {}) => {
    const search = new URLSearchParams({ ensure: "1" });
    if (params.width) search.set("width", String(params.width));
    if (params.height) search.set("height", String(params.height));
    return api(`/api/cdp-login/frame?${search.toString()}`);
  },
  getCdpScreencastUrl: (params = {}) => {
    const search = new URLSearchParams({ ensure: "1" });
    if (params.width) search.set("width", String(params.width));
    if (params.height) search.set("height", String(params.height));
    return `/api/cdp-login/screencast?${search.toString()}`;
  },
  sendCdpInput: (body = {}) => api("/api/cdp-login/input", { method: "POST", body }),
  sendCdpBrowserAction: (body = {}) => api("/api/cdp-login/browser-action", { method: "POST", body }),
  syncCdpCookies: (body = {}) => api("/api/cdp-login/sync-cookies", { method: "POST", body }),
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
