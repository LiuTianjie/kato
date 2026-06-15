export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
  return data;
}

export const dashboardApi = {
  getDashboard: () => api("/api/dashboard"),
  getInteractions: (params) => api(`/api/interactions?${params}`),
  getDebugScreenshots: () => api("/api/debug-screenshots?limit=48"),
  getMcpStatus: () => api("/api/mcp/login-status"),
  restartMcpBrowser: () => api("/api/mcp/browser/restart", { method: "POST" }),
  openBrowserViewer: (body = {}) => api("/api/browser-viewer/open", { method: "POST", body }),
  sendBrowserViewerAction: (body = {}) => api("/api/browser-viewer/action", { method: "POST", body }),
  syncBrowserViewerCookies: () => api("/api/browser-viewer/sync-cookies", { method: "POST" }),
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
